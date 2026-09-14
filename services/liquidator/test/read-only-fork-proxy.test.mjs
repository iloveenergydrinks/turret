import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {allowedForkRequest,readOnlyForkProxy} from './read-only-fork-proxy.mjs';
const req=method=>({jsonrpc:'2.0',id:1,method,params:[]});
test('fork proxy permits only explicit read-only RPC methods, including all members of a batch',()=>{
  assert.equal(allowedForkRequest(req('eth_getStorageAt')),true);
  assert.equal(allowedForkRequest({jsonrpc:'2.0',id:1,method:'eth_chainId'}),true);
  assert.equal(allowedForkRequest([req('eth_getBlockByNumber'),req('eth_getCode')] ),true);
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','anvil_setStorageAt','debug_traceCall','personal_unlockAccount','wallet_sendCalls']) {
    assert.equal(allowedForkRequest(req(method)),false);
    assert.equal(allowedForkRequest([req('eth_chainId'),req(method)]),false);
  }
  for(const invalid of [null,[],{},'eth_chainId',{method:'eth_chainId',params:[]}]) assert.equal(allowedForkRequest(invalid),false);
});

test('fork proxy never forwards writes and redacts upstream errors',async()=>{
  let forwarded=0;
  const upstream=createServer((req,res)=>{forwarded++;res.setHeader('content-type','application/json');
    res.end(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-1,message:'credential-must-not-appear'}}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const proxy=await readOnlyForkProxy(`http://127.0.0.1:${upstream.address().port}`);
  try {
    const send=body=>fetch(proxy.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    for(const body of [req('eth_sendRawTransaction'),[req('eth_chainId'),req('anvil_setCode')]]) {
      assert.equal((await send(body)).status,403);assert.equal(forwarded,0);
    }
    const response=await send(req('eth_chainId'));assert.equal(forwarded,1);
    const text=await response.text();assert.ok(!text.includes('credential-must-not-appear'));
    assert.equal(JSON.parse(text).error.message,'Fork upstream read failed');
  } finally {await proxy.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
