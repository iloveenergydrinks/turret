import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionConfig,feedForSession} from '../src/session-config.mjs';
import {requestSnapshots} from '../src/alpaca.mjs';

const approved=()=>({tradingSessionPolicy:'equities-24x5',marketDataUseApproved:true,
 markets:[{sessionDataVerified:{regular:'iex',premarket:'sip',postmarket:'sip',overnight:'boats'}}]});
test('24x5 execution needs explicit source-specific qualification and data-use approval',()=>{
 assert.equal(sessionConfig({},'execute').policy,'regular');
 assert.equal(sessionConfig({tradingSessionPolicy:'equities-24x5'},'observe').policy,'equities-24x5');
 assert.throws(()=>sessionConfig({tradingSessionPolicy:'equities-24x5',marketDataVerified:true},'execute'),/Qualification/);
 const m=approved();assert.equal(sessionConfig(m,'execute').policy,'equities-24x5');
 assert.throws(()=>sessionConfig({...m,marketDataUseApproved:false},'execute'),/Qualification/);
 for(const kind of ['regular','premarket','postmarket','overnight']){
  const bad=approved();delete bad.markets[0].sessionDataVerified[kind];
  assert.throws(()=>sessionConfig(bad,'execute'),/Qualification/);
 }
 assert.throws(()=>sessionConfig(m,'execute','sip'),/Qualification/,'Changing the regular feed needs requalification');
 m.markets[0].sessionDataVerified.overnight='overnight';
 assert.throws(()=>sessionConfig(m,'execute'),/Qualification/);
 assert.throws(()=>sessionConfig({tradingSessionPolicy:'24/7'},'observe'),/Configuration/);
 assert.throws(()=>sessionConfig({},'observe','overnight'),/Configuration/);
});
test('sessions route to real SIP or BOATS, never indicative or delayed fallback',async()=>{
 const config=sessionConfig(approved(),'execute');
 for(const [kind,feed] of Object.entries(approved().markets[0].sessionDataVerified)){
  assert.equal(feedForSession({open:true,kind},config),feed);
  let calls=0;
  await assert.rejects(requestSnapshots({key:'fixture',secret:'fixture',feed},['AAPL'],async url=>{
   calls++;assert.equal(url.searchParams.get('feed'),feed);return {ok:false,status:403};
  }),{name:'MarketDataAccessDenied'});
  assert.equal(calls,1,'Entitlement failure must not downgrade to another feed');
 }
 assert.equal(feedForSession({open:false},config),null);
 await assert.rejects(requestSnapshots({key:'fixture',secret:'fixture',feed:'overnight'},['AAPL']),{name:'MarketDataConfiguration'});
});
