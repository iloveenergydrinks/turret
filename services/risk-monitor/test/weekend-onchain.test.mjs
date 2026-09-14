import test from 'node:test';
import assert from 'node:assert/strict';
import {observeWeekendOnchain,weekendSqrtRatioAtTick} from '../src/weekend-onchain.mjs';
import {keccak256,encodeAbiParameters} from '../src/deps.mjs';
import probe from '../src/sale-probe-bytecode.json' with {type:'json'};
import {IMPLEMENTATION_SLOT,BEACON_SLOT} from '../../liquidator/src/isolated/dependencies.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0'),code='0x1234',hash=keccak256(code),time=2_000_000;
function fixture({reverse=false,version=2}={}){
 const m={symbol:'AAPL',collateral:addr(4),collateralCodeHash:hash,primaryOracle:addr(5),primaryCodeHash:hash,
  adapter:addr(6),adapterCodeHash:hash,maxPriceAgeSeconds:86400};
 const route={executor:addr(9),executorCodeHash:hash,salePool:addr(10),poolCodeHash:hash,factory:addr(11),factoryCodeHash:hash,poolFee:500,balanceMappingSlot:'0x'+'0'.repeat(64)};
 const manifest={kind:'stock-pool',chainId:4663,accountingVersion:version,vault:addr(1),vaultCodeHash:hash,pool:addr(2),poolCodeHash:hash,
  usdg:addr(3),usdgCodeHash:hash,usdgPrimary:addr(7),usdgPrimaryCodeHash:hash,usdgSecondary:addr(8),usdgSecondaryCodeHash:hash,
  markets:[m],continuousSessionAdmission:{route}};
 manifest.dependencies=[{address:m.collateral,kind:'beacon',beacon:addr(20),beaconCodeHash:hash,implementation:addr(21),implementationCodeHash:hash},
  {address:manifest.usdg,kind:'implementation',implementation:addr(22),implementationCodeHash:hash},
  {address:m.primaryOracle,kind:'aggregator',implementation:addr(23),implementationCodeHash:hash},
  {address:manifest.usdgPrimary,kind:'aggregator',implementation:addr(24),implementationCodeHash:hash}];
 const tick=reverse?230270:-230270,slot0=[weekendSqrtRatioAtTick(tick),tick,2,60,60,0,true],liquidity=10n**20n;
 const fields=new Map();
 const set=(a,n,value)=>fields.set(a.toLowerCase()+':'+n,value);
 const get=(a,n)=>fields.get(a.toLowerCase()+':'+n);
 set(addr(20),'implementation',addr(21));set(m.primaryOracle,'aggregator',addr(23));set(manifest.usdgPrimary,'aggregator',addr(24));
 for(const [n,v] of Object.entries({token0:reverse?manifest.usdg:m.collateral,token1:reverse?m.collateral:manifest.usdg,
  factory:route.factory,fee:500,slot0,liquidity,observations:[time-2,0n,1n,true]}))set(route.salePool,n,v);
 set(route.factory,'getPool',route.salePool);
 for(const [n,v] of Object.entries({decimals:18,uiMultiplier:2n*10n**18n,effectiveAt:0n,oraclePaused:false,balanceOf:10n**21n}))set(m.collateral,n,v);
 set(manifest.usdg,'decimals',6);
 for(const [n,v]of Object.entries({engine:manifest.vault,factory:route.factory,firstPool:route.salePool,secondPool:addr(0),intermediate:addr(0),collateralFunded:true,
  salePool:route.salePool,poolFee:500}))set(route.executor,n,v);
 for(const [n,v]of Object.entries({primary:m.primaryOracle,stockGuard:m.adapter,usdgPrimary:manifest.usdgPrimary,usdgSecondary:manifest.usdgSecondary,
  usdgPrimaryMaxAge:90000,usdgSecondaryMaxAge:90000,usdgMaxDeviationBps:200,usdgMaxTimestampSkew:90000}))set(manifest.vault,n,v);
 for(const [n,v]of Object.entries({primaryOracle:m.primaryOracle,collateral:m.collateral,MAX_PRICE_AGE:86400n}))set(m.adapter,n,v);
 for(const a of [m.primaryOracle,manifest.usdgPrimary,manifest.usdgSecondary]){
  set(a,'decimals',8);set(a,'latestRoundData',[1n,a===m.primaryOracle?100n*10n**8n:10n**8n,0n,BigInt(time-5),1n]);
 }
 const head={number:10n,hash,timestamp:BigInt(time)},calls=[],simulations=[];
 const client={
  getChainId:async()=>4663,
  getCode:async call=>{calls.push(call);return code;},
  readContract:async call=>{
   calls.push(call);
   if(call.functionName==='observe'){
    const seconds=call.args[0][0];return [[0n,BigInt(tick*seconds)],[0n,(BigInt(seconds)<<128n)/liquidity]];
   }
   const v=get(call.address,call.functionName);if(v instanceof Error)throw v;
   if(v===undefined)throw new Error('Unexpected '+call.functionName);return v;
  },
  getStorageAt:async call=>{calls.push(call);
   if(call.slot===BEACON_SLOT)return '0x'+'0'.repeat(24)+addr(20).slice(2);
   if(call.slot===IMPLEMENTATION_SLOT)return '0x'+'0'.repeat(24)+addr(22).slice(2);
   return '0x'+get(m.collateral,'balanceOf').toString(16);},
  getBlock:async call=>{calls.push(call);return head;},
  simulateContract:async call=>{
   calls.push(call);simulations.push(call);
   const sqrt=slot0[0],price=reverse?(1n<<192n)*10n**30n/(sqrt*sqrt):sqrt*sqrt*10n**30n/(1n<<192n);
   return {result:call.args[3]*price/10n**30n*999n/1000n};
  },
 };
 return {client,manifest,head,now:()=>time+3,set,get,calls,simulations,slot0,route,m};
}

test('AAPL observation pins every read, verifies identity and simulates real route without a signer',async()=>{
 const f=fixture(),o=await observeWeekendOnchain(f);
 assert.equal(o.borrowingEligible,false);assert.equal(o.mode,'observation');assert.deepEqual(o.blockers,[]);
 assert.equal(o.identity.accountingVersion,2);assert.equal(o.token.multiplier,String(2n*10n**18n));
 assert.equal(o.pool.twaps.length,2);assert.ok(o.pool.twaps.every(x=>x.available));
 assert.equal(o.prices.stock.ageSeconds,'8');assert.equal(o.prices.usdg.conservativePriceUsdE18,String(10n**18n));
 assert.equal(o.pool.latestObservation.updatedAt,String(time-2));
 assert.equal(o.quotes.length,4);assert.ok(o.quotes.every(q=>q.ok));
 assert.doesNotThrow(()=>JSON.stringify(o));
 for(const c of f.calls)assert.equal(c.blockNumber,10n);
 for(const c of f.simulations){
  assert.equal(c.functionName,'sell');assert.equal(c.address,f.route.executor);assert.equal(c.stateOverride.length,2);
  assert.equal(c.stateOverride[0].code,probe.runtime);assert.equal(c.stateOverride[1].code,undefined);
  assert.equal(c.stateOverride[1].address,f.m.collateral);assert.equal(c.stateOverride[1].stateDiff.length,1);
  assert.equal(c.stateOverride[1].stateDiff[0].slot,keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[f.route.executor,0n])));
  assert.ok(!c.stateOverride.some(x=>x.address===f.route.salePool));
 }
 assert.ok(f.calls.every(x=>!['borrowingPrice','stockPrice','submitHealth','submitChecks'].includes(x.functionName)));
});

test('pool orientation gives the same human token price and never multiplies pool price by token multiplier',async()=>{
 const a=await observeWeekendOnchain(fixture()),b=await observeWeekendOnchain(fixture({reverse:true,version:1}));
 const pa=BigInt(a.pool.spotPriceUsdgPerTokenE18),pb=BigInt(b.pool.spotPriceUsdgPerTokenE18);
 assert.ok((pa>pb?pa-pb:pb-pa)<100000000n);
 assert.ok(pa>99n*10n**18n&&pa<101n*10n**18n);
 assert.equal(a.pool.spotPriceUsdPerTokenE18,a.pool.spotPriceUsdgPerTokenE18);
 assert.equal(b.identity.accountingVersion,1);
});

test('identity and malformed configuration fail before any synthetic sale',async()=>{
 for(const alter of [
  f=>f.manifest.markets[0].symbol='MSFT',f=>f.manifest.accountingVersion=3,f=>f.manifest.vaultCodeHash='bad',
  f=>f.manifest.dependencies=[],f=>f.set(addr(20),'implementation',addr(99)),
  f=>f.route.executor=f.manifest.vault,f=>f.client.getChainId=async()=>1,
  f=>f.client.getCode=async()=> '0xabcd',f=>f.set(f.route.salePool,'token0',addr(99)),
  f=>f.set(f.route.salePool,'factory',addr(99)),f=>f.set(f.route.salePool,'fee',3000),
  f=>f.set(f.route.factory,'getPool',addr(99)),f=>f.set(f.m.collateral,'decimals',6),
  f=>f.set(f.manifest.usdg,'decimals',18),f=>f.set(f.route.executor,'engine',addr(99)),
  f=>f.set(f.route.executor,'secondPool',addr(99)),f=>f.set(f.route.executor,'intermediate',addr(99)),
  f=>f.set(f.route.executor,'collateralFunded',false),f=>f.set(f.manifest.vault,'primary',addr(99)),
  f=>f.set(f.m.adapter,'MAX_PRICE_AGE',172800n),f=>f.set(f.m.collateral,'uiMultiplier',0n),
  f=>f.client.getStorageAt=async()=> '0x0',f=>f.notionalsUsdg=['0'],f=>f.notionalsUsdg=['1','1.0'],
 ]){
  const f=fixture();alter(f);await assert.rejects(observeWeekendOnchain(f));assert.equal(f.simulations.length,0);
 }
});

test('missing historical observations do not fabricate TWAP or stop useful sale diagnostics',async()=>{
 const f=fixture(),read=f.client.readContract;
 f.client.readContract=async c=>c.functionName==='observe'&&c.args[0][0]===1800?Promise.reject(new Error('OLD')):read(c);
 const o=await observeWeekendOnchain(f);
 assert.equal(o.pool.twaps[0].available,true);assert.equal(o.pool.twaps[1].available,false);
 assert.ok(o.blockers.includes('twap_1800_unavailable'));assert.equal(o.quotes.length,4);
 assert.ok(o.limitations.some(x=>x.includes('does not prove recent trading')));
});

test('TWAP rounds negative nonintegral ticks down and handles cumulatives wrapping',async()=>{
 const f=fixture(),read=f.client.readContract;
 f.client.readContract=async c=>c.functionName==='observe'?[[ (1n<<55n)-10n, -(1n<<55n)+9n ],[ (1n<<160n)-100n,1n ]]:read(c);
 const o=await observeWeekendOnchain(f);assert.equal(o.pool.twaps[0].arithmeticMeanTick,0);
 const g=fixture(),readG=g.client.readContract;
 g.client.readContract=async c=>c.functionName==='observe'?[[0n,-301n],[0n,100n]]:readG(c);
 const p=await observeWeekendOnchain(g);assert.equal(p.pool.twaps[0].arithmeticMeanTick,-2);
});

test('stale canonical stock price is retained with real age while weekend pool observation continues',async()=>{
 const f=fixture();f.set(f.m.primaryOracle,'latestRoundData',[1n,100n*10n**8n,0n,BigInt(time-90000),1n]);
 const o=await observeWeekendOnchain(f);
 assert.equal(o.prices.stock.fresh,false);assert.equal(o.prices.stock.ageSeconds,'90003');
 assert.ok(o.blockers.includes('stock_feed_stale'));assert.equal(o.quotes.length,4);assert.equal(o.borrowingEligible,false);
});

test('USDG stale, malformed, disagreeing and skewed data never produce a qualified pool USD price',async()=>{
 for(const alter of [
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',[1n,10n**8n,0n,BigInt(time-90000),1n]),
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',[1n,0n,0n,BigInt(time),1n]),
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',[1n,10n**8n,0n,BigInt(time+100),1n]),
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',[2n,10n**8n,0n,BigInt(time),1n]),
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',[1n,2n*10n**8n,0n,BigInt(time),1n]),
  f=>{f.set(f.manifest.vault,'usdgMaxTimestampSkew',1);f.set(f.manifest.usdgPrimary,'latestRoundData',[1n,10n**8n,0n,BigInt(time),1n]);},
  f=>f.set(f.manifest.usdgPrimary,'latestRoundData',new Error('RPC unavailable')),
 ]){
  const f=fixture();alter(f);const o=await observeWeekendOnchain(f);
  assert.equal(o.pool.spotPriceUsdPerTokenE18,null);assert.equal(o.prices.usdg.conservativePriceUsdE18,null);
  assert.ok(o.blockers.length>0);assert.equal(o.quotes.length,4);
 }
});

test('corporate action and token pause stay visible without inventing a replacement oracle value',async()=>{
 const f=fixture();f.set(f.m.collateral,'effectiveAt',BigInt(time-1));f.set(f.m.collateral,'oraclePaused',true);
 const o=await observeWeekendOnchain(f);
 assert.equal(o.token.corporateActionPending,true);assert.equal(o.token.oraclePaused,true);
 assert.ok(o.blockers.includes('corporate_action_pending'));assert.ok(o.blockers.includes('collateral_oracle_paused'));
});

test('zero liquidity, locked pool and failed full-input sells never report executable coverage',async()=>{
 for(const mutate of [f=>f.set(f.route.salePool,'liquidity',0n),f=>f.slot0[6]=false]){
  const f=fixture();mutate(f);const o=await observeWeekendOnchain(f);
  assert.ok(o.blockers.includes('pool_liquidity_unavailable'));assert.deepEqual(o.quotes,[]);assert.equal(f.simulations.length,0);
 }
 const f=fixture();f.client.simulateContract=async()=>{throw new Error('IncompleteSale');};
 const o=await observeWeekendOnchain(f);assert.ok(o.quotes.every(q=>!q.ok));assert.ok(o.blockers.includes('sale_simulation_failed'));
});

test('expired, future, regressing or reorged snapshots are rejected',async()=>{
 for(const alter of [f=>f.now=()=>time+31,f=>f.now=()=>time-1,
  f=>{let n=0;f.now=()=>n++?time+31:time+1;},f=>{let n=0;f.now=()=>n++?time+1:time+2;},
  f=>f.client.getBlock=async()=>({...f.head,hash:'0x'+'f'.repeat(64)}),
  f=>f.client.getBlock=async()=>({...f.head,timestamp:f.head.timestamp+1n}),
 ]){const f=fixture();alter(f);await assert.rejects(observeWeekendOnchain(f));}
});

test('TickMath matches exact pinned contract boundary values',()=>{
 assert.equal(weekendSqrtRatioAtTick(0),1n<<96n);
 assert.equal(weekendSqrtRatioAtTick(-887272),4295128739n);
 assert.equal(weekendSqrtRatioAtTick(887272),1461446703485210103287273052203988822378723970342n);
 assert.throws(()=>weekendSqrtRatioAtTick(887273));assert.throws(()=>weekendSqrtRatioAtTick(1.2));
});
