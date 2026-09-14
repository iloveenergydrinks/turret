import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionAt} from '../src/calendar.mjs';
import {validateSnapshot,requestSnapshots} from '../src/alpaca.mjs';
import {evaluateMarket,RecoveryTracker,makeProof,healthTypes,proofParameters} from '../src/policy.mjs';
import {privateKeyToAccount} from '../src/deps.mjs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {decodeAbiParameters,recoverTypedDataAddress}=require('viem');
const now=Date.parse('2026-09-02T15:00:00Z')/1000;
const iso=t=>new Date(t*1000).toISOString();
function snapshot(time=now){return {latestTrade:{p:100,t:iso(time)},latestQuote:{bp:99.99,ap:100.01,t:iso(time)}};}
function input(){return {snapshot:snapshot(),primary:[2n,100n*10n**18n,0n,BigInt(now-1),2n],multiplier:10n**18n,effectiveAt:0n,tokenPaused:false};}
test('US calendar handles DST, holidays, weekends, early closes and expiry',()=>{
 assert.equal(sessionAt(now).open,true);
 assert.equal(sessionAt(Date.parse('2026-09-07T15:00:00Z')/1000).open,false);
 assert.equal(sessionAt(Date.parse('2026-09-05T15:00:00Z')/1000).open,false);
 assert.equal(sessionAt(Date.parse('2026-09-02T13:34:59Z')/1000).open,false);
 assert.equal(sessionAt(Date.parse('2026-11-03T14:35:00Z')/1000).open,true);
 assert.equal(sessionAt(Date.parse('2026-11-27T17:50:00Z')/1000).open,false);
 assert.equal(sessionAt(Date.parse('2026-12-24T17:49:59Z')/1000).open,true);
 assert.equal(sessionAt(Date.parse('2029-01-02T15:00:00Z')/1000).reason,'calendar_expired');
});
test('healthy quote agrees with canonical price',()=>assert.equal(evaluateMarket(input(),now).ok,true));
test('source timestamps matter even when HTTP response is new',()=>{
 const x=input();x.snapshot=snapshot(now-60);assert.equal(evaluateMarket(x,now).code,'QuoteStale');
 x.snapshot=snapshot(now+3);assert.equal(evaluateMarket(x,now).code,'QuoteStale');
});
test('fresh quotes fetched after RPC reads use wall time, not the earlier block timestamp',()=>{
 const x=input();x.snapshot=snapshot(now+5);
 assert.equal(evaluateMarket(x,now,now+5).ok,true);
 x.snapshot=snapshot(now+8);
 assert.equal(evaluateMarket(x,now,now+5).code,'QuoteStale','Real future timestamps still reject');
 x.snapshot=snapshot(now-55);
 assert.equal(evaluateMarket(x,now,now+5).code,'QuoteStale','Reads cannot extend the 60-second quote lifetime');
});
test('processing delays cannot qualify a stale chain snapshot or cross a trading session',()=>{
 const x=input();x.snapshot=snapshot(now+16);
 assert.equal(evaluateMarket(x,now,now+16).code,'ObservationClockInvalid');
 assert.equal(evaluateMarket(x,now,now-3).code,'ObservationClockInvalid');
 for(const wall of [NaN,Infinity,now+0.5])assert.equal(evaluateMarket(x,now,wall).code,'ObservationClockInvalid');
 const boundary=Date.parse('2026-09-03T20:00:00Z')/1000;
 x.sessionPolicy='equities-24x5';x.snapshot=snapshot(boundary+1);
 x.primary[3]=BigInt(boundary-2);
 assert.equal(evaluateMarket(x,boundary-1,boundary+1).code,'SessionChanged');
});
test('primary age and effective corporate actions are rechecked at observation completion',()=>{
 const x=input();x.snapshot=snapshot(now+5);x.primary[3]=BigInt(now-297);
 assert.equal(evaluateMarket(x,now,now+5).code,'PrimaryStale');
 x.primary[3]=BigInt(now-1);x.effectiveAt=BigInt(now+3);
 assert.equal(evaluateMarket(x,now,now+5).code,'CorporateActionPending');
});
test('wide, crossed, absent and zero quotes reject',()=>{
 for(const q of [{bp:100,ap:102},{bp:101,ap:100},{bp:0,ap:100}]){
  const s=snapshot();Object.assign(s.latestQuote,q);assert.throws(()=>validateSnapshot(s,now));
 }
 assert.throws(()=>validateSnapshot({latestTrade:{p:100,t:iso(now)}},now));
});
test('price disagreement requests liquidation quarantine; missing data does not',()=>{
 const x=input();x.primary[1]=200n*10n**18n;
 assert.deepEqual(evaluateMarket(x,now),{ok:false,code:'PriceDisagreement',unsafePrice:true});
 x.snapshot=null;assert.equal(evaluateMarket(x,now).unsafePrice,undefined);
});
test('raw token scaling is applied exactly once to the independent quote',()=>{
 const x=input();x.multiplier=2n*10n**18n;x.primary[1]=200n*10n**18n;
 assert.equal(evaluateMarket(x,now).ok,true);
 x.primary[1]=400n*10n**18n;assert.equal(evaluateMarket(x,now).code,'PriceDisagreement');
});
test('stale primary and corporate-action mismatch deny approval',()=>{
 const x=input();x.primary[3]=BigInt(now-300);assert.equal(evaluateMarket(x,now).code,'PrimaryStale');
 x.primary[3]=BigInt(now-1);x.effectiveAt=BigInt(now);assert.equal(evaluateMarket(x,now).code,'CorporateActionPending');
});
test('feed heartbeat tolerates unchanged prices while independent data must remain fresh',()=>{
 const x=input();x.maxPriceAgeSeconds=86400;x.primary[3]=BigInt(now-3600);
 assert.equal(evaluateMarket(x,now).ok,true);
 x.snapshot=snapshot(now-60);assert.equal(evaluateMarket(x,now).code,'QuoteStale');
 x.snapshot=snapshot();x.primary[3]=BigInt(now-86400);assert.equal(evaluateMarket(x,now).code,'PrimaryStale');
 x.primary[3]=BigInt(now-1);x.maxPriceAgeSeconds=86401;assert.equal(evaluateMarket(x,now).code,'InvalidHeartbeat');
});
test('recovery requires continuous observations and restarts on a stall or fault',()=>{
 const r=new RecoveryTracker();
 for(let t=0;t<120;t+=15)assert.equal(r.observe('a',{ok:true},t),false);
 assert.equal(r.observe('a',{ok:true},120),true);
 assert.equal(r.observe('a',{ok:true},151),false);
 assert.equal(r.observe('a',{ok:false},152),false);
 assert.equal(r.observe('a',{ok:true},153),false);
 assert.equal(new RecoveryTracker().observe('a',{ok:true},1000),false);
});
test('HTTP failures are classified without exposing credentials or raw response',async()=>{
 const auth={key:'sensitive-key',secret:'sensitive-secret'};
 for(const status of [401,403,429,500])await assert.rejects(requestSnapshots(auth,['AAPL'],async(url,options)=>{
  assert.equal(url.hostname,'data.alpaca.markets');assert.equal(options.redirect,'error');
  return {ok:false,status,text:async()=>auth.secret};
 }),e=>!e.message.includes('sensitive')&&e.name.startsWith('MarketData'));
 await assert.rejects(requestSnapshots({},['AAPL']),{name:'MarketDataCredentialsMissing'});
});
test('REST snapshots do not fall back to a delayed feed',async()=>{
 const data=await requestSnapshots({key:'k',secret:'s'},['AAPL','MSFT'],async(url)=>{
  assert.equal(url.searchParams.get('feed'),'iex');return {ok:true,text:async()=>JSON.stringify({AAPL:snapshot()})};
 });
 assert.equal(data.MSFT,null);assert.ok(data.AAPL.latestTrade);
});
test('encoded permit recovers guardian and is bounded by original quote age',async()=>{
 const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`),adapter='0x1111111111111111111111111111111111111111';
 const result=evaluateMarket(input(),now);result.sourceTime=now-30;
 const proof=await makeProof(account,adapter,result,{epoch:3n,recoveryAt:0n},now);
 assert.equal(proof.validUntil,now+30);
 const [message,signature]=decodeAbiParameters(proofParameters,proof.encoded);
 assert.equal(await recoverTypedDataAddress({domain:{name:'DockyardChainlinkGuard',version:'1',chainId:4663,verifyingContract:adapter},types:healthTypes,primaryType:'Health',message,signature}),account.address);
 result.sourceTime=now-46;await assert.rejects(makeProof(account,adapter,result,{epoch:3n,recoveryAt:0n},now));
});
