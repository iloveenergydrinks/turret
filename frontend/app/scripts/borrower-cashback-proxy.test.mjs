import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBorrowerCashbackProxy } from './borrower-cashback-proxy.mjs';
test('cashback proxy permits only fixed read endpoints and strips browser credentials', async () => {
  const upstream = createServer((req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ path:req.url,
    cookie:req.headers.cookie ?? null, authorization:req.headers.authorization ?? null })); });
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const proxy = createBorrowerCashbackProxy({ url:`http://127.0.0.1:${upstream.address().port}` });
  const server = createServer((req,res) => void proxy(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/borrower-cashback`;
  try {
    const res=await fetch(`${url}/v1/campaign`,{headers:{cookie:'session=secret',authorization:'Bearer secret'}});
    assert.equal(res.status,200);assert.deepEqual(await res.json(),{path:'/v1/campaign',cookie:null,authorization:null});
    assert.equal((await fetch(`${url}/v1/publish`,{method:'POST'})).status,404);
    assert.equal((await fetch(`${url}/v1/campaign?url=https://example.com`)).status,404);
  } finally { await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>upstream.close(resolve))]); }
});
