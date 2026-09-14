import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createP2PAlertsProxy } from './p2p-alerts-proxy.mjs';

async function fixture(t,options){const proxy=createP2PAlertsProxy(options),server=createServer(async(req,res)=>{if(!await proxy(req,res)){res.writeHead(404);res.end();}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));return `http://127.0.0.1:${server.address().port}`;}
test('only fixed P2P endpoints reach configured upstream and cookies are not forwarded',async t=>{
  const calls=[],base=await fixture(t,{url:'https://private.example/p2p',fetcher:async(...args)=>{calls.push(args);return new Response('{"sent":true}',{status:200});}});
  const body=JSON.stringify({channel:'email',email:'local@example.test'}),authorization=`Bearer ${'ab'.repeat(32)}`;
  const result=await fetch(base+'/api/p2p-alerts/subscriptions',{method:'POST',headers:{'content-type':'application/json',authorization,cookie:'private-site-cookie=x',origin:base},body});
  assert.equal(result.status,200);assert.equal(calls[0][0],'https://private.example/p2p/subscriptions');assert.equal(calls[0][1].headers.authorization,authorization);assert.equal(calls[0][1].headers.cookie,undefined);assert.equal(calls[0][1].redirect,'error');assert.equal(result.headers.get('cache-control'),'no-store');
  for(const path of ['/api/p2p-alerts/anything','/api/p2p-alerts/capabilities?url=https://evil.test','/api/p2p-alerts/transactions','/other'])assert.equal((await fetch(base+path)).status,404);
  assert.equal(calls.length,1);
});
test('unconfigured, oversized and malformed requests fail before upstream delivery',async t=>{
  const unconfigured=await fixture(t,{url:undefined});assert.equal((await fetch(unconfigured+'/api/p2p-alerts/capabilities')).status,503);
  let calls=0;const base=await fixture(t,{url:'http://127.0.0.1:9999',fetcher:async()=>{calls++;return new Response('{}');}});
  assert.equal((await fetch(base+'/api/p2p-alerts/subscriptions',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(12001)})).status,413);
  assert.equal((await fetch(base+'/api/p2p-alerts/subscriptions',{headers:{authorization:'Bearer not-a-session'}})).status,400);
  assert.equal(calls,0);
});
test('provider failure and oversized responses never leak upstream details',async t=>{
  const base=await fixture(t,{url:'https://private.example',fetcher:async()=>{throw new Error('secret upstream diagnostics');}});
  const response=await fetch(base+'/api/p2p-alerts/capabilities');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/secret|private.example/);
  const oversized=await fixture(t,{url:'https://private.example',fetcher:async()=>new Response(JSON.stringify({body:'x'.repeat(65536)}))});assert.equal((await fetch(oversized+'/api/p2p-alerts/capabilities')).status,503);
  assert.throws(()=>createP2PAlertsProxy({url:'https://user:password@example.test'}),/Invalid/);
});
test('an interrupted upload does not reject the HTTP handler or contact the upstream',async t=>{
  let calls=0;const base=await fixture(t,{url:'https://private.example',fetcher:async()=>{calls++;return new Response('{}');}});
  const request=httpRequest(base+'/api/p2p-alerts/subscriptions',{method:'POST',headers:{'content-type':'application/json','content-length':'1000'}});
  request.on('error',()=>{});request.write('{');await new Promise(resolve=>setTimeout(resolve,15));request.destroy();
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(calls,0);
  assert.equal((await fetch(base+'/api/p2p-alerts/capabilities')).status,200);
});
test('NFT and stock alert endpoints cannot cross-route consent',async t=>{
 const calls=[],base=await fixture(t,{url:'https://nft-alerts.example',mountPath:'/api/nft-alerts',fetcher:async(...args)=>{calls.push(args);return new Response('{}');}});
 assert.equal((await fetch(base+'/api/p2p-alerts/capabilities')).status,404);
 assert.equal((await fetch(base+'/api/nft-alerts/capabilities')).status,200);
 assert.equal(calls.length,1);assert.equal(calls[0][0],'https://nft-alerts.example/capabilities');
 assert.throws(()=>createP2PAlertsProxy({mountPath:'/api/arbitrary'}));
});
