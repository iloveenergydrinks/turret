import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ExtendedSessionAdmission,EXTENDED_LIMITS,stressedSaleRequired,verifyExtendedSale,interruptExtendedAdmission} from '../src/extended-sessions.mjs';
import {sessionConfig} from '../src/session-config.mjs';
import {evaluateMarket,makeProof} from '../src/policy.mjs';
import {validateSnapshot,corroboratedRecentTrade,requestSnapshots} from '../src/alpaca.mjs';
import {privateKeyToAccount,keccak256,encodeAbiParameters} from '../src/deps.mjs';
import probe from '../src/sale-probe-bytecode.json' with {type:'json'};

const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=keccak256('0x1234');
const config=()=>({version:1,healthySeconds:900,maxDebtLimit:'50000000',maxLtvBps:3000,saleHaircutBps:200,
 route:{executor:addr(6),salePool:addr(7),factory:addr(8),executorCodeHash:hash,poolCodeHash:hash,factoryCodeHash:hash,balanceMappingSlot:'0x'+'0'.repeat(64),poolFee:500}});
const manifest=()=>({kind:'stock-pool',tradingSessionPolicy:'equities-24x5',marketDataUseApproved:true,
 vault:addr(1),pool:addr(2),usdg:addr(3),executionGate:addr(4),markets:[{symbol:'AAPL',collateral:addr(5),sessionDataVerified:{regular:'sip'}}],
 continuousSessionAdmission:config()});

test('continuous admission requires explicit bounded rollout and qualified regular feed',()=>{
 assert.ok(sessionConfig(manifest(),'execute','sip').continuous);
 for(const change of [m=>{m.marketDataUseApproved=false;},m=>{delete m.continuousSessionAdmission;},
  m=>{m.continuousSessionAdmission.healthySeconds=0;},m=>{m.continuousSessionAdmission.maxDebtLimit='50000001';},
  m=>{m.continuousSessionAdmission.route.executor=m.vault;},m=>{delete m.markets[0].sessionDataVerified.regular;},
  m=>{m.markets[0].symbol='TSLA';}]){
  const m=manifest();change(m);assert.throws(()=>sessionConfig(m,'execute','sip'));
 }
 assert.equal(manifest().markets[0].sessionDataVerified.overnight,undefined,'No fabricated qualification flags');
});

test('each extended session requires 900 continuous seconds, real samples, and requalifies after any fault',()=>{
 const tracker=new ExtendedSessionAdmission(config());
 const observe=(now,key='day:postmarket:sip',ok=true)=>tracker.observe({now,sessionKey:key,ok});
 for(let t=1000;t<1900;t+=5)assert.equal(observe(t).ready,false);
 assert.equal(observe(1900).ready,true);
 assert.equal(observe(1905,'day:overnight:boats').ready,false);
 for(let t=1910;t<=2805;t+=5)observe(t,'day:overnight:boats');
 assert.equal(observe(2805,'day:overnight:boats').ready,true);
 assert.equal(observe(2806,'day:overnight:boats',false).ready,false);
 assert.equal(observe(2810,'day:overnight:boats').ready,false);
 assert.equal(observe(3710,'day:overnight:boats').ready,false,'A long observation gap resets the timer');
 assert.equal(observe(3700,'day:overnight:boats').ready,false,'Clock reversal resets the timer');
 tracker.reset();assert.equal(observe(5000).ready,false);
});

test('extended prices reject stale observations, wider spreads and 1% disagreement without weakening quarantine',async()=>{
 const now=Date.parse('2026-09-04T22:00:00Z')/1000,iso=t=>new Date(t*1000).toISOString();
 const input=()=>({sessionPolicy:'equities-24x5',sourceFeed:'sip',admissionLimits:EXTENDED_LIMITS,
  snapshot:{latestTrade:{p:100,t:iso(now)},latestQuote:{bp:99.99,ap:100.01,t:iso(now)}},
  primary:[2n,100n*10n**18n,0n,BigInt(now-1),2n],multiplier:10n**18n,effectiveAt:0n,tokenPaused:false});
 assert.equal(evaluateMarket(input(),now).ok,true);
 const old=input();old.snapshot.latestTrade.t=iso(now-30);old.snapshot.latestQuote.t=iso(now-30);
 assert.equal(evaluateMarket(old,now).code,'QuoteStale');
 const wide=input();wide.snapshot.latestQuote.ap=100.6;assert.equal(evaluateMarket(wide,now).code,'QuoteSpread');
 const disagreement=input();disagreement.primary[1]=1015n*10n**17n;
 assert.deepEqual(evaluateMarket(disagreement,now),{ok:false,code:'ExtendedPriceDisagreement'});
 disagreement.primary[1]=103n*10n**18n;assert.equal(evaluateMarket(disagreement,now).unsafePrice,true);
 const result=evaluateMarket(input(),now);result.admissionValidUntil=now+20;
 const proof=await makeProof(privateKeyToAccount('0x'+'1'.padStart(64,'0')),addr(9),result,{epoch:0n,recoveryAt:0n},now);
 assert.equal(proof.validUntil,now+20,'Both signatures expire within the sale observation lifetime');
 result.admissionValidUntil=now+14;
 await assert.rejects(makeProof(privateKeyToAccount('0x'+'1'.padStart(64,'0')),addr(9),result,{epoch:0n,recoveryAt:0n},now));
});

test('fresh executions corroborate price when an unchanged book has an older quote event',async()=>{
 const now=Date.parse('2026-09-04T22:32:00Z')/1000,iso=t=>new Date(t*1000).toISOString();
 const snapshot={latestTrade:{p:100.01,t:iso(now-5)},latestQuote:{bp:100,ap:100.1,t:iso(now-80)}};
 assert.throws(()=>validateSnapshot(snapshot,now),{name:'QuoteStale'},'The old midpoint policy rejected this live feed observation');
 const quote=validateSnapshot(snapshot,now,EXTENDED_LIMITS);
 assert.equal(quote.price,10001n*10n**16n,'Price is the execution, not the older midpoint');
 assert.equal(quote.sourceTime,now-5);assert.equal(quote.quoteTime,now-80);
 snapshot.latestTrade.t=iso(now-30);
 assert.throws(()=>validateSnapshot(snapshot,now,EXTENDED_LIMITS),{name:'QuoteStale'});
 snapshot.latestQuote.t=iso(now-2);
 const freshBook=validateSnapshot(snapshot,now,EXTENDED_LIMITS);
 assert.equal(freshBook.price,10005n*10n**16n);
 assert.equal(freshBook.sourceTime,now-2,'A current book price uses its own event timestamp');
 snapshot.latestTrade.t=iso(now-5);snapshot.latestQuote.t=iso(now-180);
 assert.throws(()=>validateSnapshot(snapshot,now,EXTENDED_LIMITS),{name:'QuoteStale'});
 snapshot.latestQuote.t=iso(now-170);
 const input={snapshot,primary:[1n,100n*10n**18n,0n,BigInt(now-1),1n],multiplier:10n**18n,effectiveAt:0n,tokenPaused:false,
  sessionPolicy:'equities-24x5',sourceFeed:'sip',admissionLimits:EXTENDED_LIMITS};
 const result=evaluateMarket(input,now);
 await assert.rejects(makeProof(privateKeyToAccount('0x'+'1'.padStart(64,'0')),addr(9),result,{epoch:0n,recoveryAt:0n},now),
  /QuoteTooOldForApproval/,'A certificate cannot outlive the independent quote sanity check');
 const boundary=Date.parse('2026-09-04T20:00:00Z')/1000;
 snapshot.latestTrade.t=iso(boundary+10);snapshot.latestQuote.t=iso(boundary-1);input.primary[3]=BigInt(boundary);
 assert.equal(evaluateMarket(input,boundary+10).code,'QuoteOutsideSession');
});


test('recent execution corroboration rejects exceptional trades, duplicates, thin volume and price dispersion',()=>{
 const now=Math.floor(Date.now()/1000),iso=t=>new Date(t*1000).toISOString();
 const trades=()=>[1,2,3].map(i=>({i,x:'D',z:'C',c:['@','T','I'],s:4,p:100+i/100,t:iso(now-i)}));
 assert.equal(corroboratedRecentTrade(trades(),now).i,1);
 for(const change of [a=>{a[0].c.push('Z');},a=>{a[0].c.push('P');},a=>{a[0].c.push('U');},
  a=>{a[0].c.push('4');},a=>{a[0].c.push('unknown');},a=>{a[0].i=a[1].i;},a=>{a.forEach(t=>t.s=3);},
  a=>{a[0].t=iso(now-30);},a=>{a[0].t=iso(now+3);},a=>{a[0].p=101;},a=>{a[0].z='A';},
  a=>{a[0].p=0;},a=>{a[0].s=0;},a=>{delete a[0].c;}]){
  const a=trades();change(a);assert.equal(corroboratedRecentTrade(a,now),null);
 }
 assert.equal(corroboratedRecentTrade(null,now),null);
});

test('extended snapshot supplement retains event timestamps and cannot refresh data on a failed request',async()=>{
 const now=Math.floor(Date.now()/1000),iso=t=>new Date(t*1000).toISOString();
 const snapshot={latestTrade:{p:100,t:iso(now-20)},latestQuote:{bp:99.99,ap:100.01,t:iso(now-60)}};
 const trades=[1,2,3].map(i=>({i,x:'D',z:'C',c:['@','T','I'],s:4,p:100,t:iso(now-i)}));
 const calls=[];
 const fetcher=async url=>{calls.push(url);return new Response(JSON.stringify(url.pathname.endsWith('/trades')?{trades}:{AAPL:snapshot}));};
 const settings={key:'fixture',secret:'fixture',feed:'sip',recentExecutions:true};
 const result=(await requestSnapshots(settings,['AAPL'],fetcher)).AAPL;
 assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('feed'),'sip');
 assert.equal(calls[1].searchParams.get('asof'),'-');
 assert.equal(result.latestTrade.t,trades[0].t);assert.equal(result.latestQuote.t,snapshot.latestQuote.t);
 assert.equal(validateSnapshot(result,now,EXTENDED_LIMITS).sourceTime,now-1);
 const failed=(await requestSnapshots(settings,['AAPL'],async url=>url.pathname.endsWith('/trades')
  ?new Response('{}',{status:503}):new Response(JSON.stringify({AAPL:snapshot})))).AAPL;
 assert.deepEqual(failed,snapshot);
 calls.length=0;await requestSnapshots({...settings,recentExecutions:false},['AAPL'],fetcher);
 assert.equal(calls.length,1,'Regular snapshots do not gain an extra dependency');
});

function fixture(){
 const m=manifest(),c=config(),head={number:10n,timestamp:1000n,hash},calls=[];
 const values={maxLtvBps:3000,liquidationLtvBps:4000,bonusBps:500,minimumDebt:1000000n,
  routeHealthy:true,engine:m.vault,salePool:c.route.salePool,factory:c.route.factory,poolFee:500,balanceOf:1000000000000000000n};
 const client={readContract:async({functionName})=>values[functionName],getCode:async()=> '0x1234',
  getStorageAt:async()=> '0x'+values.balanceOf.toString(16),getBlock:async()=>head,
  simulateContract:async call=>{calls.push(call);return {result:call.args[3]*100n/10n**12n};}};
 const capital={debtLimit:50000000n,interestReceivable:0n,pendingInterest:0n};
 const chain={client,capital:async n=>capital[n],stockPrice:async()=>100n*10n**18n};
 const keeper={snapshot:{executor:c.route.executor,executorCodeHash:c.route.executorCodeHash,
  balances:{usdg:'100000000'},profitPolicy:{absoluteFloor:'1',repaymentBps:50}}};
 return {manifest:m,config:c,head,chain,keeper,liveness:'0x01',now:()=>1002,calls,values,capital};
}
test('full cap and minimum-size sales preserve real pool state and require stressed repayment coverage',async()=>{
 const f=fixture(),result=await verifyExtendedSale(f);
 assert.equal(result.samples.length,2);assert.equal(result.debtLimit,'50000000');assert.equal(result.validUntil,1030);
 for(const call of f.calls){
  assert.equal(call.blockNumber,10n);assert.equal(call.stateOverride.length,2);
  assert.equal(call.stateOverride[0].address,f.config.route.executor);
  assert.equal(call.stateOverride[1].address,f.manifest.markets[0].collateral);
  assert.equal(call.stateOverride[1].code,undefined);
  assert.equal(call.stateOverride[1].stateDiff.length,1);
  assert.equal(call.stateOverride[1].stateDiff[0].slot,keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[f.config.route.executor,0n])));
 }
 assert.equal(stressedSaleRequired(50000000n,{absoluteFloor:'1',repaymentBps:50}),51275511n);
});
test('route, liquidity, exposure, funding, clock, reorg and storage faults block admission',async()=>{
 for(const change of [f=>{f.values.maxLtvBps=3001;},f=>{f.capital.debtLimit=50000001n;},
  f=>{f.values.routeHealthy=false;},f=>{f.chain.client.getCode=async()=> '0xabcd';},
  f=>{f.keeper.snapshot.executor=addr(99);},f=>{f.keeper.snapshot.balances.usdg='1';},
  f=>{f.chain.client.simulateContract=async()=>({result:1n});},f=>{f.chain.client.simulateContract=async()=>{throw new Error('TransferPaused');};},
  f=>{f.chain.client.getStorageAt=async()=> '0x0';},f=>{f.now=()=>1016;},
  f=>{f.chain.client.getBlock=async()=>({...f.head,hash:'0x'+'f'.repeat(64)});},
  f=>{f.keeper.snapshot.profitPolicy=null;}]){
  const f=fixture();change(f);await assert.rejects(verifyExtendedSale(f));
 }
});
test('checked-in probe runtime matches the reviewed source and compiled artifact',()=>{
 const source=readFileSync(new URL('../../../contracts/src/research/DockyardReadOnlySaleProbe.sol',import.meta.url));
 assert.equal(createHash('sha256').update(source).digest('hex'),probe.sourceSha256);
 const artifact=JSON.parse(readFileSync(new URL('../../../contracts/out/DockyardReadOnlySaleProbe.sol/DockyardReadOnlySaleProbe.json',import.meta.url)));
 assert.equal(artifact.deployedBytecode.object,probe.runtime);
});

const resumableConfig=()=>({...config(),version:2,corroborationWindowSeconds:60,staleQuoteGraceSeconds:120});
test('explicit version 3 admits every deployed stock with the same bounded extended-session checks',()=>{
 for(const symbol of ['AAPL','MSFT','GOOGL','AMZN','META','NVDA','AMD','MU','TSLA']){
  const m=manifest();m.markets[0].symbol=symbol;m.continuousSessionAdmission={...resumableConfig(),version:3,maxDebtLimit:symbol==='AAPL'?'50000000':'10000000'};
  assert.equal(sessionConfig(m,'execute','sip').continuous.version,3,symbol);
  assert.equal(m.markets[0].sessionDataVerified.overnight,undefined);
 }
 for(const change of [m=>{m.markets[0].symbol='UNKNOWN';},m=>{m.continuousSessionAdmission.maxDebtLimit='50000001';},
  m=>{m.continuousSessionAdmission.maxLtvBps=3001;},m=>{m.continuousSessionAdmission.corroborationWindowSeconds=120;},
  m=>{m.continuousSessionAdmission.staleQuoteGraceSeconds=121;},m=>{m.marketDataUseApproved=false;},
  m=>{m.continuousSessionAdmission.route.executor=m.vault;},m=>{m.continuousSessionAdmission.maxDebtLimit='999999';},
  m=>{m.continuousSessionAdmission.maxDebtLimit='010000000';},m=>{m.continuousSessionAdmission.maxDebtLimit='invalid';}]){
  const m=manifest();m.markets[0].symbol='MSFT';m.continuousSessionAdmission={...resumableConfig(),version:3};change(m);
  assert.throws(()=>sessionConfig(m,'execute','sip'));
 }
 for(const version of [1,2]){
  const m=manifest();m.markets[0].symbol='MSFT';m.continuousSessionAdmission=version===1?config():resumableConfig();
  assert.throws(()=>sessionConfig(m,'execute','sip'),'Older AAPL-only manifests retain their original scope');
 }
});
test('an expanded market is bound to its own existing cap below the global ceiling',async()=>{
 const f=fixture();f.config={...f.config,version:3,maxDebtLimit:'10000000'};f.capital.debtLimit=10000000n;
 assert.equal((await verifyExtendedSale(f)).debtLimit,'10000000');
 f.capital.debtLimit=10000001n;await assert.rejects(verifyExtendedSale(f),{name:'ExtendedExposureLimit'});
});
test('version 3 retains completed qualification through the same bounded gap and fresh-price recovery',()=>{
 const tracker=new ExtendedSessionAdmission({...resumableConfig(),version:3});
 for(let now=1000;now<=1900;now+=5)tracker.observe({sessionKey:'day:overnight:boats',ok:true,now});
 assert.equal(tracker.suspend({sessionKey:'day:overnight:boats',now:1905,stale:true}).qualificationRetained,true);
 for(let now=1910;now<2030;now+=5)assert.equal(tracker.suspend({sessionKey:'day:overnight:boats',now,stale:false}).ready,false);
 assert.equal(tracker.observe({sessionKey:'day:overnight:boats',now:2030,ok:true}).ready,true);
 tracker.reset();assert.equal(tracker.observe({sessionKey:'day:overnight:boats',now:2035,ok:true}).ready,false);
});
const qualify=tracker=>{for(let now=1000;now<=1900;now+=5)tracker.observe({sessionKey:'day:postmarket:sip',ok:true,now});};
test('qualified AAPL session resumes after a short data gap and price recovery without a second 15-minute warmup',()=>{
 const tracker=new ExtendedSessionAdmission(resumableConfig());qualify(tracker);
 for(let now=1905;now<=1930;now+=5)assert.equal(tracker.suspend({sessionKey:'day:postmarket:sip',now,stale:true}).ready,false);
 for(let now=1935;now<2055;now+=5)assert.equal(tracker.suspend({sessionKey:'day:postmarket:sip',now,stale:false}).ready,false);
 assert.equal(tracker.observe({sessionKey:'day:postmarket:sip',now:2055,ok:true}).ready,true);
});
test('qualification retention never starts early or survives long gaps, hard faults, session changes, clock faults or restart',()=>{
 for(const variant of ['initial','legacy','outage','session','clock','stall','hard','restart','idle']){
  const tracker=new ExtendedSessionAdmission(variant==='legacy'?config():resumableConfig());
  if(variant==='initial')tracker.observe({sessionKey:'day:postmarket:sip',now:1900,ok:true});else qualify(tracker);
  let now=1905,key='day:postmarket:sip';
  if(variant==='outage')for(;now<=2025;now+=5)tracker.suspend({sessionKey:key,now,stale:true});
  if(variant==='session')key='next:premarket:sip';
  if(variant==='clock')now=1899;
  if(variant==='stall')now=1931;
  if(['hard','restart'].includes(variant))tracker.reset();
  if(variant==='idle')for(;now<=2805;now+=5)tracker.suspend({sessionKey:key,now,stale:false});
  assert.equal(tracker.suspend({sessionKey:key,now,stale:false}).ready,false);
  assert.equal(tracker.observe({sessionKey:key,now:now+5,ok:true}).ready,false,variant);
 }
});
test('the longer corroboration window requires a fresh newest execution and retains count, volume and dispersion checks',()=>{
 const now=Date.parse('2026-09-04T23:00:00Z')/1000;
 const trades=[2,35,50].map((age,i)=>({i:i+1,x:'D',z:'C',c:['@','T','I'],s:4,p:100,t:new Date((now-age)*1000).toISOString()}));
 assert.equal(corroboratedRecentTrade(trades,now),null);
 assert.equal(corroboratedRecentTrade(trades,now,{windowSeconds:60})?.i,1);
 for(const mutation of [ts=>ts[0].t=new Date((now-30)*1000).toISOString(),ts=>ts[2].t=new Date((now-60)*1000).toISOString(),
  ts=>ts.forEach(t=>t.s=3),ts=>ts[2].p=101,ts=>ts[2].c.push('W')]){
  const ts=structuredClone(trades);mutation(ts);assert.equal(corroboratedRecentTrade(ts,now,{windowSeconds:60}),null);
 }
 assert.equal(corroboratedRecentTrade(trades,now,{windowSeconds:61}),null);
});
test('resumable policy is explicitly versioned and rejects altered bounds',()=>{
 const m=manifest();m.continuousSessionAdmission=resumableConfig();assert.ok(sessionConfig(m,'execute','sip').continuous);
 for(const mutation of [c=>c.corroborationWindowSeconds=180,c=>c.staleQuoteGraceSeconds=121,c=>c.version=4]){
  const n=structuredClone(m);mutation(n.continuousSessionAdmission);assert.throws(()=>sessionConfig(n,'execute','sip'));
 }
});

test('the monitor interruption path retains qualification only for stale quotes with operational dependencies',()=>{
 for(const [code,operational,retained] of [['QuoteStale',true,true],['QuoteStale',false,false],['PriceDisagreement',true,false],
  ['ExtendedPriceDisagreement',true,false],['MarketDataUnavailable',true,false],['PrimaryStale',true,false],['ObservationClockInvalid',true,false]]){
  const tracker=new ExtendedSessionAdmission(resumableConfig());qualify(tracker);
  const state=interruptExtendedAdmission(tracker,{result:{ok:false,code},recovered:false,operational,sessionKey:'day:postmarket:sip',now:1905});
  assert.equal(state.ready,false);assert.equal(state.qualificationRetained===true,retained,code);
 }
});
