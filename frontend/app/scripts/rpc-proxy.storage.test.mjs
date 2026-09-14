import assert from 'node:assert/strict';
import test from 'node:test';
import {PassThrough} from 'node:stream';
import {createRpcProxy} from './rpc-proxy.mjs';

const storage={jsonrpc:'2.0',id:'slv-beacon',method:'eth_getStorageAt',params:[
  '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f',
  '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50','0x35030a4']};
const result='0x000000000000000000000000e10b6f6b275de231345c20d14ab812db62151b00';
function fixture(t){
  const seen=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const input=JSON.parse(options.body);
    if(input.id==='chain-check')return new Response(JSON.stringify({jsonrpc:'2.0',id:input.id,result:'0x1237'}));
    seen.push({url:String(url),options});
    const answer=p=>({jsonrpc:'2.0',id:p.id,result:p.method==='eth_chainId'?'0x1237':result});
    return new Response(JSON.stringify(Array.isArray(input)?input.map(answer):answer(input)),
      {headers:{'Content-Type':'application/json'}});
  });
  const proxy=createRpcProxy({upstream:'https://upstream.example.invalid/'});
  async function post(payload,headers={}){
    const request=new PassThrough();request.method='POST';request.headers={host:'turret.capital',
      origin:'https://turret.capital','content-type':'application/json',...headers};
    const response={writeHead(status,headers){this.status=status;this.headers=headers;return this;},
      end(body){this.body=JSON.parse(body);return this;}};
    const pending=proxy(request,response);request.end(JSON.stringify(payload));await pending;return response;
  }
  return {seen,post};
}
test('SLV implementation-pin storage read reaches the fixed upstream unchanged',async t=>{
  const {seen,post}=fixture(t),response=await post(storage,{authorization:'Bearer browser-only',cookie:'browser-only'});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{jsonrpc:'2.0',id:'slv-beacon',result});
  assert.equal(seen.length,1);assert.deepEqual(JSON.parse(seen[0].options.body),storage);
  assert.deepEqual(seen[0].options.headers,{'content-type':'application/json',accept:'application/json'});
  assert.equal(response.headers['Cache-Control'],'no-store');
});
test('storage reads retain IDs in mixed read-only batches',async t=>{
  const {seen,post}=fixture(t),batch=[storage,{jsonrpc:'2.0',id:2,method:'eth_chainId',params:[]}];
  const response=await post(batch);assert.equal(response.status,200);
  assert.deepEqual(response.body.map(x=>x.id),['slv-beacon',2]);
  assert.deepEqual(JSON.parse(seen[0].options.body),batch);
});
test('storage permission does not admit writes, mixed write batches or foreign origins',async t=>{
  const {seen,post}=fixture(t);
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','debug_traceCall','eth_setStorageAt']){
    assert.equal((await post({...storage,method})).status,400);
    assert.equal((await post([storage,{...storage,method}])).status,400);
  }
  assert.equal((await post(storage,{origin:'https://unrelated.example'})).status,403);
  assert.equal(seen.length,0);
});
