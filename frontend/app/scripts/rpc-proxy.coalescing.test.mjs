import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { createRpcProxy } from './rpc-proxy.mjs';

const rpc=(id,method='eth_call',params=[{to:'0x1111111111111111111111111111111111111111',data:'0x12345678'},'latest'])=>({jsonrpc:'2.0',id,method,params});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const answer=call=>({jsonrpc:'2.0',id:call.id,result:call.method==='eth_chainId'?'0x1237':JSON.stringify([call.method,call.params??[]])});
function fixture(t,respond,{timeout=15000}={}){
  const seen=[];let now=Date.now();t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const payload=JSON.parse(options.body);if(payload.id==='chain-check')return response({jsonrpc:'2.0',id:payload.id,result:'0x1237'});seen.push({payload,options,url:String(url)});
    const result=await respond(payload,options,seen.length);
    if(!Array.isArray(payload)&&result.ok){const data=await result.clone().json();if(Array.isArray(data)&&data.length===1)return response(data[0]);}
    return result;
  });
  const proxy=createRpcProxy({upstream:'https://read-only.example.invalid/private-token',timeout});
  const post=async(payload,extra={})=>{
    const request=new PassThrough();request.method='POST';request.headers={host:'turret.capital',origin:'https://turret.capital','content-type':'application/json',...extra};
    const response={writeHead(status,headers){this.status=status;this.headers=headers;return this;},end(body){this.body=JSON.parse(body);return this;}};
    const pending=proxy(request,response);request.end(JSON.stringify(payload));await pending;return response;
  };
  return {seen,post,advance:ms=>now+=ms};
}
const response=payload=>new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}});

test('coalesces simultaneous duplicate calls across and inside batches, remapping out-of-order responses',async t=>{
  const release=[];
  const {seen,post}=fixture(t,async payload=>{await new Promise(resolve=>release.push(resolve));return response((Array.isArray(payload)?payload:[payload]).map(answer).reverse());});
  const one=post([rpc(1),rpc(2),rpc('block','eth_blockNumber',[])]);
  await tick();
  const two=post([rpc('same'),rpc('block-again','eth_blockNumber',[]),rpc('balance','eth_getBalance',['0x2222222222222222222222222222222222222222','latest'])]);
  await tick();
  assert.equal(seen.reduce((sum,x)=>sum+(Array.isArray(x.payload)?x.payload.length:1),0),3,'Only three distinct calls should reach upstream');
  release.forEach(done=>done());
  const [first,second]=await Promise.all([one,two]);
  assert.equal(first.status,200);assert.equal(second.status,200);
  assert.deepEqual(first.body.map(x=>x.id),[1,2,'block']);assert.deepEqual(second.body.map(x=>x.id),['same','block-again','balance']);
  assert.equal(first.body[0].result,first.body[1].result);assert.equal(first.body[0].result,second.body[0].result);
  assert.equal(first.body[2].result,second.body[1].result);
});
test('preserves single/object versus batch/array shape and distinguishes numeric and string IDs',async t=>{
  let release;
  const {seen,post}=fixture(t,async payload=>{await new Promise(resolve=>release=resolve);return response((Array.isArray(payload)?payload:[payload]).map(answer));});
  const single=post(rpc(1));await tick();const batch=post([rpc('1')]);await tick();
  assert.equal(seen.length,1);release();
  const [a,b]=await Promise.all([single,batch]);
  assert.equal(Array.isArray(a.body),false);assert.equal(a.body.id,1);assert.equal(Array.isArray(b.body),true);assert.equal(b.body[0].id,'1');
});
test('never reuses a completed mutable read and separates distinct account, data, and block parameters',async t=>{
  const {seen,post}=fixture(t,async(payload,_options,version)=>response(Array.isArray(payload)?payload.map(call=>({...answer(call),result:version})):({...answer(payload),result:version})));
  assert.equal((await post(rpc(1))).body.result,1);assert.equal((await post(rpc(2))).body.result,2);
  const distinct=[rpc(1),rpc(2,'eth_call',[{to:'0x1111111111111111111111111111111111111111',data:'0x87654321'},'latest']),rpc(3,'eth_call',[{to:'0x2222222222222222222222222222222222222222',data:'0x12345678'},'latest']),rpc(4,'eth_call',[{to:'0x1111111111111111111111111111111111111111',data:'0x12345678'},'0x10'])];
  assert.equal((await post(distinct)).status,200);assert.equal(seen.at(-1).payload.length,4);
});
test('shared upstream errors are evicted and later retries make a fresh request without leaking diagnostics',async t=>{
  let release;
  const {seen,post,advance}=fixture(t,async(payload,_options,version)=>{
    if(version===1){await new Promise(resolve=>release=resolve);return new Response('private-token: private diagnostic',{status:429});}
    return response(answer(payload));
  });
  const first=post(rpc(1));await tick();const second=post(rpc(2));await tick();assert.equal(seen.length,1);release();
  for(const result of await Promise.all([first,second])){assert.equal(result.status,503);assert.deepEqual(result.body,{error:'RPC temporarily unavailable'});}
  advance(10001);assert.equal((await post(rpc(3))).status,200);assert.equal(seen.length,2);
});
test('maps ordinary JSON-RPC errors to each caller and does not cache them',async t=>{
  const error={code:3,message:'execution reverted',data:'0x12345678'};
  const {seen,post}=fixture(t,async payload=>response((Array.isArray(payload)?payload:[payload]).map(call=>({jsonrpc:'2.0',id:call.id,error}))));
  const failed=await post([rpc(1),rpc(2)]);assert.equal(failed.status,200);assert.deepEqual(failed.body,[{jsonrpc:'2.0',id:1,error},{jsonrpc:'2.0',id:2,error}]);
  await post(rpc(3));assert.equal(seen.length,2);
});
test('rejects missing, duplicate, unknown, wrongly typed, and structurally invalid upstream IDs/results',async t=>{
  const variants=[calls=>[answer(calls[0])],calls=>[answer(calls[0]),answer(calls[0])],calls=>[answer(calls[0]),{...answer(calls[1]),id:'unknown'}],calls=>[answer(calls[0]),{...answer(calls[1]),id:String(calls[1].id)}],calls=>[answer(calls[0]),{jsonrpc:'2.0',id:calls[1].id}],calls=>[answer(calls[0]),{...answer(calls[1]),error:{code:3,message:'revert'}}]];
  let variant;
  const {post,advance}=fixture(t,async payload=>response(variant(payload)));
  for(variant of variants){const result=await post([rpc(1),rpc(2,'eth_chainId',[])]);assert.equal(result.status,503);assert.deepEqual(result.body,{error:'RPC temporarily unavailable'});advance(10001);}
  variant=calls=>calls.map(answer).reverse();assert.equal((await post([rpc(1),rpc(2,'eth_chainId',[])])).status,200);
});
test('rejects duplicate client IDs, writes and foreign origins before sharing any work',async t=>{
  const {seen,post}=fixture(t,async payload=>response(answer(payload)));
  assert.equal((await post([rpc(1),rpc(1,'eth_chainId',[])])).status,400);
  for(const method of ['eth_sendTransaction','eth_sendRawTransaction','personal_sign','eth_setStorageAt'])assert.equal((await post(rpc(1,method,[]))).status,400);
  assert.equal((await post(rpc(1),{origin:'https://foreign.example'})).status,403);assert.equal(seen.length,0);
});
test('bounds downstream fan-out and upstream response size even when many IDs share one result',async t=>{
  let size=90_000;
  const {seen,post}=fixture(t,async payload=>response((Array.isArray(payload)?payload:[payload]).map(call=>({jsonrpc:'2.0',id:call.id,result:'x'.repeat(size)}))));
  assert.equal((await post(Array.from({length:50},(_,i)=>rpc(i)))).status,502);assert.equal(seen[0].payload.length,1);
  size=4*1024*1024;assert.equal((await post(rpc(1))).status,503);
});
test('retains the 32-active-request bound while sharing one pending upstream read',async t=>{
  let release;const {seen,post}=fixture(t,async payload=>{await new Promise(resolve=>release=resolve);return response(answer(payload));});
  const pending=Array.from({length:32},(_,i)=>post(rpc(i)));await tick();assert.equal((await post(rpc(33))).status,503);assert.equal(seen.length,1);
  release();assert((await Promise.all(pending)).every(result=>result.status===200));assert.equal((await post(rpc(34,'eth_sendRawTransaction',[]))).status,400);
});
test('times out shared requests and permits a subsequent fresh read',async t=>{
  const {seen,post,advance}=fixture(t,async(payload,options,version)=>{
    if(version===1)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,500);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('private timeout diagnostic'));});});
    return response(answer(payload));
  },{timeout:25});
  const first=post(rpc(1));await tick();const second=post(rpc(2));
  assert((await Promise.all([first,second])).every(result=>result.status===503));assert.equal(seen.length,1);advance(10001);assert.equal((await post(rpc(3))).status,200);
});
test('bounds upstream work after one shared failure releases many browser requests early',async t=>{
  const release=[];
  const {seen,post,advance}=fixture(t,async(payload,_options,version)=>{
    await new Promise(resolve=>release.push(resolve));
    return version===1?new Response('private outage',{status:429}):response((Array.isArray(payload)?payload:[payload]).map(answer));
  });
  const original=post(rpc('shared'));await tick();
  const dependents=Array.from({length:31},(_,i)=>post([rpc('shared-'+i),rpc('unique-'+i,'eth_getBalance',[String(i),'latest'])]));
  await tick();assert.equal(seen.length,32);release[0]();
  assert((await Promise.all([original,...dependents])).every(result=>result.status===503));
  advance(10001);const extra=post(rpc('extra','eth_chainId',[]));await tick();
  const overloaded=post(rpc('overloaded','eth_gasPrice',[]));await tick();
  release.forEach(done=>done());
  assert.equal((await extra).status,200);assert.equal((await overloaded).status,503);
  assert.equal(seen.length,33,'At most32 upstream batches can remain outstanding');
});
