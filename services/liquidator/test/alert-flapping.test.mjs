import test from 'node:test';
import assert from 'node:assert/strict';
import {Alerts,incident} from '../src/alerts.mjs';
import {configFromEnv} from '../src/config.mjs';

test('default operator policy does not repeat an unchanged outage every four hours',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 const data=new Map(),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)},sent=[];
 const config=configFromEnv({KEEPER_RPC_URL:'http://localhost:1111',KEEPER_ALERT_WEBHOOK_URL:'https://example.invalid'});
 let alerts=new Alerts(store,config);alerts.deliver=async e=>{sent.push(e);return true;};
 const outage=incident('execution_liveness_unavailable','critical','Execution proof unavailable');
 await alerts.update([outage]);
 for(let i=0;i<3;i++){
  now+=14400001;
  alerts=new Alerts(store,config);alerts.deliver=async e=>{sent.push(e);return true;};
  const active=await alerts.update([outage]);assert.equal(active[0].severity,'critical');
 }
 assert.equal(sent.length,1);
 assert.equal(store.get('alertDelivery').delivered,true);
});
test('a flapping liveness incident sends one outage, not repeated outage/recovery emails',async t=>{
 let now=1800000000000; t.mock.method(Date,'now',()=>now);
 const data=new Map(),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)},sent=[];
 const config={alertWebhook:'https://example.invalid',alertReminderMs:3600000};
 const event=incident('execution_liveness_unavailable','critical','Execution proof unavailable');
 let alerts=new Alerts(store,config);alerts.deliver=async e=>{sent.push(e);return true;};
 for(let i=0;i<4;i++){
  await alerts.update([event]);now+=120000;await alerts.update([]);now+=15000;
  // Restart/redeploy must preserve incident suppression in the persistent store.
  alerts=new Alerts(store,config);alerts.deliver=async e=>{sent.push(e);return true;};
 }
 assert.equal(sent.length,1);
});
test('transient scan and oracle failures must persist before sending email',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 const data=new Map(),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)},sent=[];
 const alerts=new Alerts(store,{alertWebhook:'https://example.invalid',alertReminderMs:0,alertDebounceMs:30000});
 alerts.deliver=async e=>{sent.push(e);return true;};
 const outage=incident('scan_failed','critical','Scan failed');
 const active=await alerts.update([outage]);
 assert.equal(active[0].code,'scan_failed','execution health changes on the first failed cycle');
 assert.equal(sent.length,0,'a single failed cycle does not page the operator');
 now+=29999;await alerts.update([outage]);assert.equal(sent.length,0);
 now+=1;await alerts.update([outage]);assert.equal(sent.length,1);
 await alerts.update([]);
 now+=1000;await alerts.update([incident('oracle_blocked','critical','Oracle call failed')]);
 now+=1000;await alerts.update([]);
 assert.equal(sent.length,1,'a recovered oracle blip never reaches email');
});
test('cooldowns preserve real health, new critical incidents, escalation and reminders',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 const data=new Map(),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)},sent=[];
 const alerts=new Alerts(store,{alertWebhook:'https://example.invalid',alertReminderMs:14400000});alerts.deliver=async e=>{sent.push(e);return true;};
 await alerts.update([incident('rpc','warning','RPC degraded')]);
 await alerts.update([incident('rpc','critical','RPC failed')]);assert.equal(sent.length,2);
 assert.deepEqual(await alerts.update([]),[]);assert.deepEqual(store.get('alerts'),{});
 await alerts.update([incident('rpc','critical','RPC failed')]);assert.equal(sent.length,2);
 now+=14400001;await alerts.update([incident('rpc','critical','RPC failed')]);assert.equal(sent.length,3);
 await alerts.update([incident('funds','critical','USDG low')]);assert.equal(sent.length,4);
 await alerts.update([incident('liquidity_unknown:token','warning','No configured sale quote')]);assert.equal(sent.length,4);
});
