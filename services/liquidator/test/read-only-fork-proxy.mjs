import { createServer } from 'node:http';

const methods=new Set(['eth_chainId','net_version','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash',
  'eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getProof','eth_call',
  'eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_gasPrice','eth_feeHistory']);
export function allowedForkRequest(body) {
  const requests=Array.isArray(body)?body:[body];
  return requests.length>0 && requests.every(r=>r?.jsonrpc==='2.0' && methods.has(r.method) && (r.params===undefined || Array.isArray(r.params)));
}

// Keep the credential-bearing upstream out of Anvil argv/logs. This proxy cannot
// forward transactions, account management, debug or state-changing methods.
export async function readOnlyForkProxy(upstream) {
  if(!['http:','https:'].includes(new URL(upstream).protocol)) throw new Error('Invalid fork upstream');
  const server=createServer(async(req,res)=>{
    try {
      if(req.method!=='POST') {res.writeHead(405);res.end();return;}
      let body='';
      for await(const chunk of req) {body+=chunk;if(body.length>1000000)throw new Error('Large request');}
      if(!allowedForkRequest(JSON.parse(body))) {res.writeHead(403);res.end();return;}
      const response=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body,
        signal:AbortSignal.timeout(20000),redirect:'error'});
      const result=await response.json();
      // Never pass upstream error text through to child logs.
      const clean=r=>r?.error?{jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'Fork upstream read failed'}}:r;
      res.writeHead(response.ok?200:502,{'content-type':'application/json'});
      res.end(JSON.stringify(Array.isArray(result)?result.map(clean):clean(result)));
    } catch {res.writeHead(502);res.end('{"error":{"code":-32000,"message":"Fork read unavailable"}}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
