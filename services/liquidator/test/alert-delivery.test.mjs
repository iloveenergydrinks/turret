import test from 'node:test';
import assert from 'node:assert/strict';
import {Alerts,incident} from '../src/alerts.mjs';
const memory=()=>{const records=new Map();return {get:k=>records.get(k),set:(k,v)=>records.set(k,v)};};
test('failed severity escalation retries next cycle instead of claiming delivery',async()=>{
 const store=memory(),alerts=new Alerts(store,{alertWebhook:'https://example.invalid',alertReminderMs:3600000});
 let succeeds=true,calls=0;alerts.deliver=async()=>{calls++;return succeeds;};
 await alerts.update([incident('price','warning','price warning')]);
 succeeds=false;await alerts.update([incident('price','critical','price unavailable')]);
 assert.equal(store.get('alertDelivery').delivered,false);
 await alerts.update([incident('price','critical','price unavailable')]);
 assert.equal(calls,3);assert.equal(store.get('alertDelivery').delivered,false);
 succeeds=true;await alerts.update([incident('price','critical','price unavailable')]);
 assert.equal(calls,4);assert.equal(store.get('alertDelivery').delivered,true);
 await alerts.update([incident('price','critical','price unavailable')]);assert.equal(calls,4);
});
test('Resend sends only to configured operator and refuses redirects',async t=>{
 const store=memory(),alerts=new Alerts(store,{alertEmail:{apiKey:'secret-fixture',from:'alerts@example.com',to:'operator@example.com'},alertReminderMs:3600000,alertLabel:'MSFT keeper'});
 let calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;assert.equal(url,'https://api.resend.com/emails');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer secret-fixture');
  const body=JSON.parse(options.body);assert.deepEqual(body.to,['operator@example.com']);assert.equal(body.text.includes('secret-fixture'),false);
  assert.equal(body.subject,'[Turret ops] MSFT keeper: tx_failed');
  assert.match(body.text,/Turret operations — MSFT keeper: CRITICAL tx_failed/);
  return {ok:true};
 });
 await alerts.update([incident('tx_failed','critical','Transaction failed')]);
 assert.equal(calls,1);assert.equal(store.get('alertDelivery').transport,'resend');assert.equal(store.get('alertDelivery').delivered,true);
});
