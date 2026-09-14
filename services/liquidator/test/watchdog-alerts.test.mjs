import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {watchdogNotice} from '../src/watchdog-alerts.mjs';
test('watchdog suppresses reminders but alerts again after a resolved day',async t=>{
 let now=1800000000000;t.mock.method(Date,'now',()=>now);
 let sent=0;t.mock.method(globalThis,'fetch',async()=>{sent++;return {ok:true};});
 const data=new Map(),store={get:k=>data.get(k),set:(k,v)=>data.set(k,v)};
 const env={WATCHDOG_ALERT_WEBHOOK_URL:'https://example.invalid'};
 await watchdogNotice(env,'keeper',['keeper_unreachable'],false,store);
 now+=4*3600000;await watchdogNotice(env,'keeper',['keeper_unreachable'],false,store);
 assert.equal(sent,1);
 await watchdogNotice(env,'keeper',[],true,store);
 now+=25*3600000;
 await watchdogNotice(env,'keeper',['keeper_unreachable'],false,store);
 assert.equal(sent,2);
});
test('independent watchdog sends outages only; rejected delivery stays unsuccessful',async()=>{
 const messages=[];let reject=false;
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;messages.push(JSON.parse(body));res.writeHead(reject?503:200);res.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={WATCHDOG_ALERT_WEBHOOK_URL:`http://127.0.0.1:${server.address().port}`};
 try{
  assert.deepEqual(await watchdogNotice(env,'keeper',['keeper_unreachable']),{configured:true,delivered:true});
  assert.equal(messages[0].event.severity,'critical');
  assert.deepEqual(await watchdogNotice(env,'keeper',[],true),{configured:true,delivered:true});
  assert.equal(messages.length,1);
  reject=true;assert.deepEqual(await watchdogNotice(env,'risk',['monitor_stalled']),{configured:true,delivered:false});
 }finally{await new Promise(r=>server.close(r));}
});
