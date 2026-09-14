// SPDX-License-Identifier: GPL-2.0-or-later
import {parseAbi,parseUnits,keccak256,encodeAbiParameters} from './deps.mjs';
import probe from './sale-probe-bytecode.json' with {type:'json'};
import {parseDependencyPins,verifyDependencyPins} from '../../liquidator/src/isolated/dependencies.mjs';

const address=x=>typeof x==='string'&&/^0x[\da-f]{40}$/i.test(x)&&!/^0x0{40}$/i.test(x);
const hash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const fail=code=>{const e=new Error(code);e.name=code;throw e;};
const demand=(ok,code)=>{if(!ok)fail(code);};
const word=n=>'0x'+n.toString(16).padStart(64,'0');
const ceil=(a,b)=>(a+b-1n)/b;
const ONE=10n**18n,Q192=1n<<192n;
const tokenAbi=parseAbi(['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)',
 'function uiMultiplier() view returns(uint256)','function effectiveAt() view returns(uint256)','function oraclePaused() view returns(bool)']);
const poolAbi=parseAbi(['function token0() view returns(address)','function token1() view returns(address)',
 'function factory() view returns(address)','function fee() view returns(uint24)','function liquidity() view returns(uint128)',
 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)',
 'function observations(uint256) view returns(uint32,int56,uint160,bool)',
 'function observe(uint32[]) view returns(int56[],uint160[])']);
const factoryAbi=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const engineAbi=parseAbi(['function primary() view returns(address)','function stockGuard() view returns(address)',
 'function usdgPrimary() view returns(address)','function usdgSecondary() view returns(address)',
 'function usdgPrimaryMaxAge() view returns(uint32)','function usdgSecondaryMaxAge() view returns(uint32)',
 'function usdgMaxDeviationBps() view returns(uint16)','function usdgMaxTimestampSkew() view returns(uint32)']);
const guardAbi=parseAbi(['function primaryOracle() view returns(address)','function collateral() view returns(address)',
 'function MAX_PRICE_AGE() view returns(uint256)']);
const feedAbi=parseAbi(['function decimals() view returns(uint8)',
 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const exitAbi=parseAbi(['function engine() view returns(address)','function factory() view returns(address)',
 'function salePool() view returns(address)','function poolFee() view returns(uint24)',
 'function firstPool() view returns(address)','function secondPool() view returns(address)',
 'function intermediate() view returns(address)','function collateralFunded() view returns(bool)']);
const probeAbi=parseAbi(['function sell(address,address,address,uint256) returns(uint256)']);

// Exact integer port of contracts/src/research/IsolatedTickMath.sol, itself the
// pinned Uniswap v3 TickMath implementation. Do not use floating point for prices.
const tickRatios=[
 'fffcb933bd6fad37aa2d162d1a594001','fff97272373d413259a46990580e213a','fff2e50f5f656932ef12357cf3c7fdcc',
 'ffe5caca7e10e4e61c3624eaa0941cd0','ffcb9843d60f6159c9db58835c926644','ff973b41fa98c081472e6896dfb254c0',
 'ff2ea16466c96a3843ec78b326b52861','fe5dee046a99a2a811c461f1969c3053','fcbe86c7900a88aedcffc83b479aa3a4',
 'f987a7253ac413176f2b074cf7815e54','f3392b0822b70005940c7a398e4b70f3','e7159475a2c29b7443b29c7fa6e889d9',
 'd097f3bdfd2022b8845ad8f792aa5825','a9f746462d870fdf8a65dc1f90e061e5','70d869a156d2a1b890bb3df62baf32f7',
 '31be135f97d08fd981231505542fcfa6','9aa508b5b7a84e1c677de54f3e99bc9','5d6af8dedb81196699c329225ee604',
 '2216e584f5fa1ea926041bedfe98','48a170391f7dc42444e8fa2'].map(x=>BigInt('0x'+x));
export function weekendSqrtRatioAtTick(tick){
 demand(Number.isInteger(tick)&&Math.abs(tick)<=887272,'WeekendTickInvalid');
 const n=Math.abs(tick);let ratio=1n<<128n;
 for(let i=0;i<tickRatios.length;i++)if(n&(1<<i))ratio=ratio*tickRatios[i]>>128n;
 if(tick>0)ratio=((1n<<256n)-1n)/ratio;
 return (ratio>>32n)+(ratio% (1n<<32n)===0n?0n:1n);
}
function priceAtSqrt(sqrt,inputIs0){
 demand(typeof sqrt==='bigint'&&sqrt>=4295128739n&&sqrt<1461446703485210103287273052203988822378723970342n,'WeekendPoolPriceInvalid');
 return inputIs0?sqrt*sqrt*10n**30n/Q192:Q192*10n**30n/(sqrt*sqrt);
}
function twap(result,seconds,inputIs0){
 demand(Array.isArray(result)&&result.length===2&&result.every(a=>Array.isArray(a)&&a.length===2&&a.every(v=>typeof v==='bigint')),'WeekendTwapInvalid');
 const delta=BigInt.asIntN(56,result[0][1]-result[0][0]),window=BigInt(seconds);
 let tick=delta/window;if(delta<0n&&delta%window!==0n)tick--;
 const spl=BigInt.asUintN(160,result[1][1]-result[1][0]);
 demand(spl>0n,'WeekendTwapLiquidityInvalid');
 const price=priceAtSqrt(weekendSqrtRatioAtTick(Number(tick)),inputIs0);
 demand(price>0n,'WeekendTwapInvalid');
 return {available:true,windowSeconds:seconds,arithmeticMeanTick:Number(tick),priceUsdgPerTokenE18:String(price),
  harmonicMeanLiquidity:String((window<<128n)/spl)};
}
function feedObservation(result,maxAge,completedAt){
 if(result.status!=='fulfilled')return {available:false,valid:false,fresh:false,code:'feed_unavailable'};
 const [r,d]=result.value;
 if(!Array.isArray(r)||r.length!==5||!r.every(x=>typeof x==='bigint')||!Number.isInteger(d)||d<0||d>18)
  return {available:false,valid:false,fresh:false,code:'feed_invalid'};
 const [round,answer,,updated,answered]=r;
 const valid=round>0n&&answer>0n&&answer<=(1n<<128n)-1n&&answered>=round&&updated>0n&&updated<=BigInt(completedAt);
 const age=BigInt(completedAt)-updated;
 return {available:true,valid,fresh:valid&&age<BigInt(maxAge),roundId:String(round),rawAnswer:String(answer),decimals:d,
  priceUsdE18:answer>0n?String(answer*10n**BigInt(18-d)):null,updatedAt:String(updated),ageSeconds:String(age),maxAgeSeconds:maxAge,
  code:!valid?'feed_invalid':age>=BigInt(maxAge)?'feed_stale':'fresh'};
}

/** Read-only diagnostics. Never produces health proofs or authorizes borrowing.
 * The caller supplies a validated production manifest and a read-only client.
 * Synthetic inventory exists only inside eth_call; no transactions are sent.
 */
export async function observeWeekendOnchain({client,manifest,head,notionalsUsdg=['10','50','100','1000'],now=()=>Math.floor(Date.now()/1000)}){
 const m=manifest?.markets?.[0],r=manifest?.continuousSessionAdmission?.route;
 demand(manifest?.kind==='stock-pool'&&manifest.chainId===4663&&manifest.markets?.length===1&&m?.symbol==='AAPL'
  &&[undefined,1,2].includes(manifest.accountingVersion)&&r,'WeekendManifestInvalid');
 const identities=[[manifest.vault,manifest.vaultCodeHash],[manifest.pool,manifest.poolCodeHash],
  [manifest.usdg,manifest.usdgCodeHash],[m.collateral,m.collateralCodeHash],[m.primaryOracle,m.primaryCodeHash],
  [m.adapter,m.adapterCodeHash],[manifest.usdgPrimary,manifest.usdgPrimaryCodeHash],
  [manifest.usdgSecondary,manifest.usdgSecondaryCodeHash],[r.executor,r.executorCodeHash],
  [r.salePool,r.poolCodeHash],[r.factory,r.factoryCodeHash]];
 demand(identities.every(([a,h])=>address(a)&&hash(h))&&hash(r.balanceMappingSlot)
  &&Number.isInteger(r.poolFee)&&r.poolFee>0&&r.poolFee<=10000,'WeekendManifestInvalid');
 demand(new Set([manifest.vault,manifest.pool,manifest.usdg,m.collateral,m.adapter,r.executor,r.salePool,r.factory].map(x=>x.toLowerCase())).size===8,'WeekendManifestInvalid');
 const pins=parseDependencyPins(JSON.stringify(manifest.dependencies),{collateral:m.collateral,usdg:manifest.usdg,
  primary:m.primaryOracle,usdgPrimary:manifest.usdgPrimary},{required:true});
 demand(Array.isArray(notionalsUsdg)&&notionalsUsdg.length>0&&notionalsUsdg.length<=8
  &&notionalsUsdg.every(x=>typeof x==='string'&&/^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(x)),'WeekendNotionalInvalid');
 const notionals=notionalsUsdg.map(x=>parseUnits(x,6));
 demand(notionals.every(x=>x>0n&&x<=100000n*10n**6n)&&new Set(notionals.map(String)).size===notionals.length,'WeekendNotionalInvalid');
 const startedAt=now(),blockNumber=head?.number;
 demand(typeof blockNumber==='bigint'&&blockNumber>0n&&typeof head.timestamp==='bigint'&&hash(head.hash)
  &&Number.isSafeInteger(startedAt)&&head.timestamp<=BigInt(startedAt)&&BigInt(startedAt)-head.timestamp<=30n,'WeekendSnapshotExpired');
 const read=(a,abi,n,args=[])=>client.readContract({address:a,abi,functionName:n,args,blockNumber});
 const checks=await Promise.all([client.getChainId(),verifyDependencyPins(client,pins,blockNumber),...identities.map(async([a,h])=>{
  const code=await client.getCode({address:a,blockNumber});return typeof code==='string'&&code!=='0x'&&same(keccak256(code),h);
 })]);
 demand(checks[0]===4663,'WeekendChainMismatch');demand(checks.slice(1).every(Boolean),'WeekendDependencyChanged');
 const v2=manifest.accountingVersion===2;
 const values=await Promise.all([
  ...['token0','token1','factory','fee','slot0','liquidity'].map(n=>read(r.salePool,poolAbi,n)),
  read(r.factory,factoryAbi,'getPool',[m.collateral,manifest.usdg,r.poolFee]),
  ...['decimals','uiMultiplier','effectiveAt','oraclePaused'].map(n=>read(m.collateral,tokenAbi,n)),read(manifest.usdg,tokenAbi,'decimals'),
  ...['engine','factory',v2?'firstPool':'salePool',...(v2?['secondPool','intermediate','collateralFunded']:['poolFee'])].map(n=>read(r.executor,exitAbi,n)),
  ...['primary','stockGuard','usdgPrimary','usdgSecondary','usdgPrimaryMaxAge','usdgSecondaryMaxAge','usdgMaxDeviationBps','usdgMaxTimestampSkew'].map(n=>read(manifest.vault,engineAbi,n)),
  ...['primaryOracle','collateral','MAX_PRICE_AGE'].map(n=>read(m.adapter,guardAbi,n)),
 ]);
 const [token0,token1,factory,fee,slot0,liquidity,factoryPool,collateralDecimals,multiplier,effectiveAt,paused,usdgDecimals]=values;
 demand((same(token0,m.collateral)&&same(token1,manifest.usdg)||same(token1,m.collateral)&&same(token0,manifest.usdg))
  &&same(factory,r.factory)&&fee===r.poolFee&&same(factoryPool,r.salePool),'WeekendPoolIdentityChanged');
 demand(collateralDecimals===18&&usdgDecimals===6,'WeekendTokenDecimalsChanged');
 let cursor=12;
 demand(same(values[cursor++],manifest.vault)&&same(values[cursor++],r.factory)&&same(values[cursor++],r.salePool),'WeekendExecutorChanged');
 if(v2)demand(/^0x0{40}$/i.test(values[cursor++])&&/^0x0{40}$/i.test(values[cursor++])&&values[cursor++]===true,'WeekendExecutorChanged');
 else demand(values[cursor++]===r.poolFee,'WeekendExecutorChanged');
 demand(same(values[cursor++],m.primaryOracle)&&same(values[cursor++],m.adapter)&&same(values[cursor++],manifest.usdgPrimary)
  &&same(values[cursor++],manifest.usdgSecondary),'WeekendOracleIdentityChanged');
 const primaryAge=Number(values[cursor++]),secondaryAge=Number(values[cursor++]),usdDeviation=Number(values[cursor++]),usdSkew=Number(values[cursor++]);
 demand(same(values[cursor++],m.primaryOracle)&&same(values[cursor++],m.collateral),'WeekendOracleIdentityChanged');
 const stockAge=Number(values[cursor++]);
 demand([primaryAge,secondaryAge,stockAge,usdDeviation,usdSkew].every(x=>Number.isSafeInteger(x)&&x>0)
  &&primaryAge<=90000&&secondaryAge<=90000&&stockAge<=86400&&usdDeviation<=200
  &&stockAge===m.maxPriceAgeSeconds,'WeekendOraclePolicyChanged');
 demand(typeof multiplier==='bigint'&&multiplier>0n&&multiplier<=10n**30n&&typeof effectiveAt==='bigint'&&effectiveAt>=0n
  &&typeof paused==='boolean','WeekendTokenMetadataInvalid');
 const inputIs0=same(token0,m.collateral),blockers=[];
 let spot=null;
 try{spot=priceAtSqrt(slot0?.[0],inputIs0);demand(spot>0n,'WeekendPoolPriceInvalid');}catch{blockers.push('pool_price_invalid');}
 const liquid=typeof liquidity==='bigint'&&liquidity>0n&&slot0?.[6]===true;
 if(!liquid)blockers.push('pool_liquidity_unavailable');
 if(paused)blockers.push('collateral_oracle_paused');
 const windows=[300,1800];
 const [twapReads,feedReads,observationRead]=await Promise.all([
  Promise.allSettled(windows.map(s=>read(r.salePool,poolAbi,'observe',[[s,0]]))),
  Promise.allSettled([m.primaryOracle,manifest.usdgPrimary,manifest.usdgSecondary].map(a=>Promise.all([
   read(a,feedAbi,'latestRoundData'),read(a,feedAbi,'decimals')]))),
  Promise.allSettled([read(r.salePool,poolAbi,'observations',[BigInt(slot0?.[2]??0)])]),
 ]);
 let latestObservation={available:false,code:'latest_observation_unavailable'};
 const last=observationRead[0];
 if(last.status==='fulfilled'&&Array.isArray(last.value)&&Number.isInteger(last.value[0])&&last.value[0]>=0
  &&last.value[0]<=0xffffffff&&last.value[3]===true){
  const age=BigInt.asUintN(32,head.timestamp-BigInt(last.value[0]));
  if(age<=head.timestamp)latestObservation={available:true,updatedAt:String(head.timestamp-age),ageSeconds:Number(age),index:slot0[2]};
  else blockers.push('latest_observation_unavailable');
 }else blockers.push('latest_observation_unavailable');
 const twaps=twapReads.map((x,i)=>{
  try{if(x.status!=='fulfilled')throw new Error();return twap(x.value,windows[i],inputIs0);}
  catch{blockers.push(`twap_${windows[i]}_unavailable`);return {available:false,windowSeconds:windows[i],code:'observation_history_unavailable_or_invalid'};}
 });
 const poolSlot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[r.salePool,BigInt(r.balanceMappingSlot)]));
 const [balance,stored]=await Promise.all([read(m.collateral,tokenAbi,'balanceOf',[r.salePool]),client.getStorageAt({address:m.collateral,slot:poolSlot,blockNumber})]);
 demand(typeof balance==='bigint'&&balance>0n&&typeof stored==='string'&&/^0x[\da-f]+$/i.test(stored)&&BigInt(stored)===balance,'WeekendBalanceLayoutChanged');
 const executorSlot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[r.executor,BigInt(r.balanceMappingSlot)]));
 let quotes=[];
 if(spot&&liquid){
  quotes=await Promise.all(notionals.map(async(notional,i)=>{
   const amount=ceil(notional*10n**30n,spot),reference=amount*spot/10n**30n;
   const item={notionalUsdg:notionalsUsdg[i],notionalUsdgUnits:String(notional),inputCollateralUnits:String(amount),referenceOutputUsdgUnits:String(reference),simulation:true};
   try{
    demand(amount>0n&&amount<=(1n<<255n)-1n,'WeekendSaleInputInvalid');
    const {result:output}=await client.simulateContract({address:r.executor,abi:probeAbi,functionName:'sell',args:[r.salePool,m.collateral,manifest.usdg,amount],
     blockNumber,gas:3000000n,stateOverride:[{address:r.executor,code:probe.runtime,stateDiff:[{slot:word(0n),value:word(0n)}]},
      {address:m.collateral,stateDiff:[{slot:executorSlot,value:word(amount)}]}]});
    demand(typeof output==='bigint'&&output>0n,'WeekendSaleEmpty');
    return {...item,ok:true,outputUsdgUnits:String(output),effectivePriceUsdgPerTokenE18:String(output*10n**30n/amount),
     shortfallBps:String((reference-output)*10000n/reference),shortfallBpsE6:String((reference-output)*10n**10n/reference),
     outputAfterTwoPercentHaircutUsdgUnits:String(output*9800n/10000n)};
   }catch{return {...item,ok:false,code:'sale_simulation_failed'};}
  }));
  if(quotes.some(x=>!x.ok))blockers.push('sale_simulation_failed');
 }
 const canonical=await client.getBlock({blockNumber}),completedAt=now();
 demand(same(canonical.hash,head.hash)&&canonical.number===head.number&&canonical.timestamp===head.timestamp,'WeekendSnapshotReorg');
 demand(Number.isSafeInteger(completedAt)&&completedAt>=startedAt&&BigInt(completedAt)-head.timestamp<=30n,'WeekendSnapshotExpired');
 if(latestObservation.available)latestObservation.ageSeconds=completedAt-Number(latestObservation.updatedAt);
 const prices={stock:feedObservation(feedReads[0],stockAge,completedAt),usdgPrimary:feedObservation(feedReads[1],primaryAge,completedAt),
  usdgSecondary:feedObservation(feedReads[2],secondaryAge,completedAt)};
 for(const [key,p]of Object.entries(prices))if(!p.fresh)blockers.push(`${key}_${p.code}`);
 const corporatePending=effectiveAt<=BigInt(completedAt)&&(!prices.stock.valid||BigInt(prices.stock.updatedAt)<effectiveAt);
 if(corporatePending)blockers.push('corporate_action_pending');
 let conservativeUsdgUsd=null;
 if(prices.usdgPrimary.valid&&prices.usdgSecondary.valid){
  const a=BigInt(prices.usdgPrimary.priceUsdE18),b=BigInt(prices.usdgSecondary.priceUsdE18),low=a<b?a:b,high=a>b?a:b;
  const ta=BigInt(prices.usdgPrimary.updatedAt),tb=BigInt(prices.usdgSecondary.updatedAt);
  if((high-low)*10000n>low*BigInt(usdDeviation))blockers.push('usdg_price_disagreement');
  else if((ta>tb?ta-tb:tb-ta)>BigInt(usdSkew))blockers.push('usdg_timestamp_skew');
  else if(prices.usdgPrimary.fresh&&prices.usdgSecondary.fresh)conservativeUsdgUsd=high;
 }
 prices.usdg={conservativePriceUsdE18:conservativeUsdgUsd===null?null:String(conservativeUsdgUsd),maxDeviationBps:usdDeviation,maxTimestampSkew:usdSkew};
 return {mode:'observation',borrowingEligible:false,checkedAt:completedAt,
  block:{number:String(blockNumber),hash:head.hash,timestamp:String(head.timestamp),ageSeconds:completedAt-Number(head.timestamp)},
  identity:{chainId:4663,engine:manifest.vault,collateral:m.collateral,usdg:manifest.usdg,pool:r.salePool,executor:r.executor,accountingVersion:manifest.accountingVersion??1,codeHashesVerified:true,implementationPinsVerified:true},
  token:{symbol:'AAPL',collateralDecimals,usdgDecimals,multiplier:String(multiplier),multiplierScale:'1000000000000000000',effectiveAt:String(effectiveAt),oraclePaused:paused,corporateActionPending:corporatePending},
  pool:{token0,token1,feePips:fee,liquidity:typeof liquidity==='bigint'?String(liquidity):null,unlocked:slot0?.[6]===true,
   sqrtPriceX96:typeof slot0?.[0]==='bigint'?String(slot0[0]):null,tick:slot0?.[1]??null,observationCardinality:slot0?.[3]??null,
   spotPriceUsdgPerTokenE18:spot===null?null:String(spot),spotPriceUsdPerTokenE18:spot&&conservativeUsdgUsd?String(spot*conservativeUsdgUsd/ONE):null,twaps,latestObservation},
  prices,quotes,blockers:[...new Set(blockers)],limitations:[
   'Observation only; no borrowing approval or alternative contract valuation.',
   'TWAP history does not prove recent trading, resistance to manipulation, or future liquidity.',
   'Sale simulations use synthetic collateral inventory and real pool state; they are not fills or complete keeper liquidations.',
   'Sale outputs include pool fees and price impact, exclude gas, and are sized from the current pool spot price.',
   'Runtime and proxy implementation pins are verified only at this observed block; upgrades after it invalidate the observation.',
  ]};
}
