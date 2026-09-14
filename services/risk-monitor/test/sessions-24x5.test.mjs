import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSessionOpen,sessionAt} from '../src/calendar.mjs';
import {evaluateMarket,makeProof,proofParameters,RecoveryTracker} from '../src/policy.mjs';
import {privateKeyToAccount,decodeAbiParameters} from '../src/deps.mjs';

const unix=s=>Date.parse(s)/1000;
const session=s=>sessionAt(unix(s),'equities-24x5');
const sample=(s,feed)=>{
 const now=unix(s),t=new Date(now*1000).toISOString();
 return {now,input:{sessionPolicy:'equities-24x5',sourceFeed:feed,
  snapshot:{latestTrade:{p:100,t},latestQuote:{bp:99.99,ap:100.01,t}},
  primary:[2n,100n*10n**18n,0n,BigInt(now-1),2n],multiplier:10n**18n,effectiveAt:0n,tokenPaused:false}};
};

for(const [at,kind,tradeDate]of [
 ['2026-09-03T02:00:00Z','overnight','2026-09-03'],
 ['2026-09-03T07:59:59Z','overnight','2026-09-03'],
 ['2026-09-03T08:00:00Z','premarket','2026-09-03'],
 ['2026-09-03T13:30:00Z','regular','2026-09-03'],
 ['2026-09-03T20:00:00Z','postmarket','2026-09-03'],
 ['2026-09-04T00:00:00Z','overnight','2026-09-04'],
 ['2026-11-02T01:00:00Z','overnight','2026-11-02'],
 ['2026-11-03T09:00:00Z','premarket','2026-11-03'],
 ['2026-11-03T14:30:00Z','regular','2026-11-03'],
])test(`24x5 session ${at}: ${kind}`,()=>{
 const s=session(at);assert.equal(s.open,true);assert.equal(s.kind,kind);assert.equal(s.tradeDate,tradeDate);
 assert.ok(s.sessionOpen<=unix(at)&&s.sessionClose>unix(at));
});

test('weekends, holiday nights, half-day postmarket and unreviewed years stay closed',()=>{
 for(const at of ['2026-09-05T00:00:00Z','2026-09-06T15:00:00Z','2026-09-07T00:00:00Z',
  '2026-09-07T15:00:00Z','2026-11-26T01:00:00Z','2026-11-27T18:00:00Z'])assert.equal(session(at).open,false,at);
 assert.equal(session('2026-09-08T00:00:00Z').open,true,'Holiday evening belongs to next trading day');
 assert.equal(session('2026-11-27T01:00:00Z').open,true,'Eight-hour overnight before a half-day');
 assert.equal(session('2029-01-02T15:00:00Z').reason,'calendar_expired');
 assert.equal(sessionAt(unix('2026-09-03T08:00:00Z')).open,false,'Legacy policy is unchanged');
 assert.throws(()=>sessionAt(unix('2026-09-03T08:00:00Z'),'always-open'));
});

test('closed markets expose the next exact supported opening',()=>{
 assert.equal(nextSessionOpen(unix('2026-09-03T22:00:00Z'),'regular'),unix('2026-09-04T13:35:00Z'));
 assert.equal(nextSessionOpen(unix('2026-09-04T21:00:00Z'),'regular'),unix('2026-09-08T13:35:00Z'),'Labor Day weekend remains closed');
 assert.equal(nextSessionOpen(unix('2026-09-05T01:00:00Z'),'equities-24x5'),unix('2026-09-08T00:00:00Z'));
 assert.equal(nextSessionOpen(unix('2029-01-02T15:00:00Z'),'regular'),null,'Unreviewed calendars fail closed');
});

test('fresh SIP pre/postmarket and BOATS overnight can qualify; IEX cannot stand in for either',()=>{
 for(const [at,feed]of [['2026-09-03T08:10:00Z','sip'],['2026-09-03T21:10:00Z','sip'],['2026-09-03T02:10:00Z','boats']]){
  const {input,now}=sample(at,feed);assert.equal(evaluateMarket(input,now).ok,true);
  assert.equal(evaluateMarket({...input,sourceFeed:'iex'},now).code,'SessionFeedMismatch');
  assert.equal(evaluateMarket({...input,sourceFeed:'overnight'},now).code,'SessionFeedMismatch','Indicative/delayed free feed is not BOATS');
 }
 const {input,now}=sample('2026-09-03T15:00:00Z','iex');assert.equal(evaluateMarket(input,now).ok,true);
});

test('24x5 admission retains quote age, price disagreement, halt and corporate-action checks',()=>{
 const {input,now}=sample('2026-09-03T02:10:00Z','boats');
 const stale=structuredClone(input);stale.snapshot.latestTrade.t=new Date((now-900)*1000).toISOString();
 assert.equal(evaluateMarket(stale,now).code,'QuoteStale');
 assert.equal(evaluateMarket({...input,tokenPaused:true},now).code,'PrimaryInvalid');
 assert.equal(evaluateMarket({...input,primary:[2n,200n*10n**18n,0n,BigInt(now-1),2n]},now).code,'PriceDisagreement');
 assert.equal(evaluateMarket({...input,effectiveAt:BigInt(now)},now).code,'CorporateActionPending');
});

test('an old-session quote cannot qualify a newly opened session',()=>{
 const {input,now}=sample('2026-09-03T08:00:00Z','sip');
 input.snapshot.latestQuote.t=new Date((now-1)*1000).toISOString();
 assert.equal(evaluateMarket(input,now).code,'QuoteOutsideSession');
});

test('overnight proofs fit the deployed guard duration while remaining inside the actual session',async()=>{
 const {input,now}=sample('2026-09-03T02:10:00Z','boats'),result=evaluateMarket(input,now);
 const account=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
 const proof=await makeProof(account,'0x1111111111111111111111111111111111111111',result,{epoch:0n,recoveryAt:0n},now);
 const [message]=decodeAbiParameters(proofParameters,proof.encoded);
 assert.ok(message.sessionClose-message.sessionOpen<=23400n);
 assert.ok(message.sessionOpen>=BigInt(result.sessionOpen)&&message.sessionClose<=BigInt(result.sessionClose));
 assert.ok(message.sessionOpen<=BigInt(now)&&message.validUntil>BigInt(now));
 assert.equal(proof.validUntil,now+45);
});

test('switching data source or trading session restarts continuous recovery',()=>{
 const tracker=new RecoveryTracker();let result;
 for(let n=1000;n<=1120;n+=5)result=tracker.observe('AAPL',{ok:true,sessionKey:'2026-09-03:overnight:boats'},n);
 assert.equal(result,true);
 assert.equal(tracker.observe('AAPL',{ok:true,sessionKey:'2026-09-03:premarket:sip'},1125),false);
 for(let n=1130;n<1245;n+=5)assert.equal(tracker.observe('AAPL',{ok:true,sessionKey:'2026-09-03:premarket:sip'},n),false);
 assert.equal(tracker.observe('AAPL',{ok:true,sessionKey:'2026-09-03:premarket:sip'},1245),true);
});
