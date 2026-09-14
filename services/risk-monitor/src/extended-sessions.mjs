import {parseAbi,keccak256,encodeAbiParameters} from './deps.mjs';
import probe from './sale-probe-bytecode.json' with {type:'json'};

export const EXTENDED_LIMITS=Object.freeze({maxAgeSeconds:30,maxQuoteAgeSeconds:180,priceBasis:'freshest',maxSpreadBps:50,maxDeviationBps:100});
export const EXTENDED_STOCK_SYMBOLS=Object.freeze(['AAPL','MSFT','GOOGL','AMZN','META','NVDA','AMD','MU','TSLA']);
const address=x=>typeof x==='string'&&/^0x[\da-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
const hash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,code)=>{if(!ok){const e=new Error(code);e.name=code;throw e;}};
const word=n=>'0x'+n.toString(16).padStart(64,'0');
export function extendedSessionConfig(manifest){
 const c=manifest.continuousSessionAdmission;
 if(c===undefined)return null;
 const versionValid=c?.version===1&&c.corroborationWindowSeconds===undefined&&c.staleQuoteGraceSeconds===undefined
  ||[2,3].includes(c?.version)&&c.corroborationWindowSeconds===60&&c.staleQuoteGraceSeconds===120;
 const symbol=manifest.markets?.[0]?.symbol;
 const symbolValid=c?.version===3?EXTENDED_STOCK_SYMBOLS.includes(symbol):symbol==='AAPL';
 const debtLimitValid=c?.version===3?typeof c.maxDebtLimit==='string'&&/^[1-9]\d{0,7}$/.test(c.maxDebtLimit)
  &&BigInt(c.maxDebtLimit)>=1000000n&&BigInt(c.maxDebtLimit)<=50000000n:c?.maxDebtLimit==='50000000';
 demand(manifest.kind==='stock-pool'&&manifest.markets?.length===1&&symbolValid
  &&manifest.tradingSessionPolicy==='equities-24x5'&&manifest.marketDataUseApproved===true
  &&versionValid&&c.healthySeconds===900&&debtLimitValid&&c.maxLtvBps===3000
  &&c.saleHaircutBps===200,'InvalidExtendedSessionConfiguration');
 const r=c.route;
 demand(r&&['executor','salePool','factory'].every(k=>address(r[k]))
  &&['executorCodeHash','poolCodeHash','factoryCodeHash','balanceMappingSlot'].every(k=>hash(r[k]))
  &&Number.isSafeInteger(r.poolFee)&&r.poolFee>0&&r.poolFee<=10000,'InvalidExtendedSaleRoute');
 demand(new Set([manifest.vault,manifest.pool,manifest.usdg,manifest.markets[0].collateral,
  manifest.executionGate,r.executor,r.salePool,r.factory].map(x=>x.toLowerCase())).size===8,'OverlappingExtendedSaleRoute');
 return c;
}

// Deliberately memory-only. Versions 2 and 3 can retain a completed qualification
// during a bounded stale-quote interruption; it never authorizes borrowing
// while suspended. The caller still requires fresh price recovery and sale,
// keeper and liveness checks before calling observe() again.
export class ExtendedSessionAdmission {
 constructor(config){this.config=config;}
 reset(){this.record=undefined;}
 suspend({sessionKey,now,stale}){
  const r=this.record;
  if(![2,3].includes(this.config.version)||!r?.qualified||typeof stale!=='boolean'||!Number.isSafeInteger(now)
   ||sessionKey!==r.key||now<r.last||now-r.last>30||now-r.lastValidated>=this.config.healthySeconds){
   this.reset();return {ready:false,code:'checks_unavailable'};
  }
  if(stale){
   r.staleSince??=now;
   if(now-r.staleSince>=this.config.staleQuoteGraceSeconds){this.reset();return {ready:false,code:'checks_unavailable'};}
  }else delete r.staleSince;
  r.last=now;
  return {ready:false,code:stale?'quote_unavailable':'price_recovering',qualificationRetained:true,since:r.since,checkedAt:now};
 }
 observe({sessionKey,ok,now}){
  if(!ok||!Number.isSafeInteger(now)||typeof sessionKey!=='string'){this.reset();return {ready:false,code:'checks_unavailable'};}
  const old=this.record;
  const r=old&&old.key===sessionKey&&now>=old.last&&now-old.last<=30?old:{key:sessionKey,since:now,samples:0};
  if(now!==r.last)r.samples++;
  r.last=now;this.record=r;
  const ready=r.qualified===true||now-r.since>=this.config.healthySeconds&&r.samples>=60;
  if(ready){r.qualified=true;r.lastValidated=now;delete r.staleSince;}
  return {ready,code:ready?'healthy':'session_qualifying',since:r.since,checkedAt:now,samples:r.samples,
   requiredSeconds:this.config.healthySeconds,eligibleAt:r.since+this.config.healthySeconds};
 }
}

export function interruptExtendedAdmission(tracker,{result,recovered,operational,sessionKey,now}){
 if(result.ok&&recovered&&operational)return null;
 if(operational&&(result.code==='QuoteStale'||result.ok&&!recovered))
  return tracker.suspend({sessionKey,now,stale:!result.ok});
 tracker.reset();return {ready:false,code:'checks_unavailable'};
}

const engineAbi=parseAbi(['function maxLtvBps() view returns(uint16)','function liquidationLtvBps() view returns(uint16)',
 'function bonusBps() view returns(uint16)','function minimumDebt() view returns(uint256)']);
const exitAbi=parseAbi(['function routeHealthy() view returns(bool)','function engine() view returns(address)',
 'function salePool() view returns(address)','function factory() view returns(address)','function poolFee() view returns(uint24)']);
const balanceAbi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const probeAbi=parseAbi(['function sell(address,address,address,uint256) returns(uint256)']);

export function stressedSaleRequired(paid,profitPolicy,haircutBps=200){
 const absolute=BigInt(profitPolicy?.absoluteFloor??0),bps=profitPolicy?.repaymentBps;
 demand(absolute>0n&&Number.isSafeInteger(bps)&&bps>=50&&bps<=10000,'KeeperProfitPolicyUnavailable');
 const relative=(paid*BigInt(bps)+9999n)/10000n;
 const profit=relative>absolute?relative:absolute;
 return ((paid+profit)*10000n+BigInt(9999-haircutBps))/BigInt(10000-haircutBps);
}

// Simulate real token transfers and the actual V3 pool swap at a pinned block.
// No wallet signs and no state is broadcast. Synthetic inventory is isolated to
// the executor's ERC20 balance; no price, liquidity or token code is replaced.
export async function verifyExtendedSale({chain,manifest,config,head,liveness,keeper,now=()=>Math.floor(Date.now()/1000)}){
 const r=config.route,client=chain.client,blockNumber=head.number;
 demand(same(keeper?.snapshot?.executor,r.executor)&&same(keeper?.snapshot?.executorCodeHash,r.executorCodeHash),
  'ExtendedKeeperRouteMismatch');
 const token=manifest.markets[0].collateral;
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber});
 const [ltv,liquidationLtv,bonus,minimumDebt,debtLimit,interest,pending,price,healthy,engine,salePool,factory,fee]=await Promise.all([
  ...['maxLtvBps','liquidationLtvBps','bonusBps','minimumDebt'].map(n=>read(manifest.vault,engineAbi,n)),
  ...['debtLimit','interestReceivable','pendingInterest'].map(n=>chain.capital(n,[],blockNumber)),
  chain.stockPrice(blockNumber,liveness),
  ...['routeHealthy','engine','salePool','factory','poolFee'].map(n=>read(r.executor,exitAbi,n)),
 ]);
 demand(ltv>0&&ltv<=config.maxLtvBps&&liquidationLtv===4000&&bonus===500&&minimumDebt>0n
  &&debtLimit>0n&&debtLimit<=BigInt(config.maxDebtLimit)&&price>0n,'ExtendedExposureLimit');
 demand(healthy&&same(engine,manifest.vault)&&same(salePool,r.salePool)&&same(factory,r.factory)&&fee===r.poolFee,'ExtendedRouteChanged');
 for(const [address,expected]of [[r.executor,r.executorCodeHash],[r.salePool,r.poolCodeHash],[r.factory,r.factoryCodeHash]]){
  const code=await client.getCode({address,blockNumber});
  demand(code&&code!=='0x'&&same(keccak256(code),expected),'ExtendedRouteChanged');
 }
 // Prove the configured storage location against real nonzero pool holdings.
 const poolSlot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[r.salePool,BigInt(r.balanceMappingSlot)]));
 const [balance,stored]=await Promise.all([read(token,balanceAbi,'balanceOf',[r.salePool]),client.getStorageAt({address:token,slot:poolSlot,blockNumber})]);
 demand(balance>0n&&BigInt(stored??'0x0')===balance,'SaleProbeBalanceLayoutChanged');
 const exposure=debtLimit+interest+pending;
 demand(BigInt(keeper.snapshot.balances.usdg)>=exposure,'ExtendedKeeperCoverage');
 const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[r.executor,BigInt(r.balanceMappingSlot)]));
 const sizes=[...new Set([minimumDebt,exposure])];
 const samples=await Promise.all(sizes.map(async paid=>{
  const amount=(paid*10n**30n*BigInt(10000+bonus)+price*10000n-1n)/(price*10000n);
  const stateOverride=[{address:r.executor,code:probe.runtime,stateDiff:[{slot:word(0n),value:word(0n)}]},
   {address:token,stateDiff:[{slot,value:word(amount)}]}];
  const {result:output}=await client.simulateContract({address:r.executor,abi:probeAbi,functionName:'sell',
   args:[r.salePool,token,manifest.usdg,amount],blockNumber,stateOverride,gas:3000000n});
  const required=stressedSaleRequired(paid,keeper.snapshot.profitPolicy,config.saleHaircutBps);
  demand(output>=required,'ExtendedSaleCoverageInsufficient');
  return {repayment:String(paid),input:String(amount),output:String(output),required:String(required)};
 }));
 const completedAt=now();
 demand(completedAt>=Number(head.timestamp)&&completedAt-Number(head.timestamp)<=15,'ExtendedSaleSnapshotExpired');
 demand(same((await client.getBlock({blockNumber})).hash,head.hash),'ExtendedSaleReorg');
 return {ok:true,block:String(blockNumber),checkedAt:Number(head.timestamp),validUntil:Number(head.timestamp)+30,
  maxLtvBps:ltv,debtLimit:String(debtLimit),saleHaircutBps:config.saleHaircutBps,samples,simulation:true};
}
