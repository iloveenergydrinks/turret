const routes = new Map([
  ['/capabilities', ['GET']], ['/healthz', ['GET']], ['/challenge', ['POST']], ['/session', ['POST']],
  ['/verify', ['POST']], ['/subscriptions', ['GET','POST','DELETE']],
]);

/** Mount after the website access gate. The upstream is operator configuration, never request data. */
export function createP2PAlertsProxy({ url = process.env.P2P_ALERTS_URL, fetcher = fetch, timeoutMs = 15000, mountPath = '/api/p2p-alerts' } = {}) {
  if (!['/api/p2p-alerts','/api/nft-alerts'].includes(mountPath)) throw new Error('Invalid alert proxy mount');
  let upstream;
  if (url) {
    upstream = new URL(url);
    if (!['https:','http:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid configured P2P alert upstream');
  }
  return async function p2pAlertsProxy(request,response) {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    if (requestUrl.pathname !== mountPath && !requestUrl.pathname.startsWith(`${mountPath}/`)) return false;
    response.setHeader('cache-control','no-store');response.setHeader('content-type','application/json');response.setHeader('x-content-type-options','nosniff');
    const finish=(status,body)=>{response.writeHead(status);response.end(JSON.stringify(body));return true;};
    const path=requestUrl.pathname.slice(mountPath.length);
    if(requestUrl.search || !routes.get(path)?.includes(request.method))return finish(404,{error:'Unknown P2P alert endpoint'});
    if(!upstream)return finish(503,{error:'P2P alerts are not configured'});
    if(request.headers.authorization && (typeof request.headers.authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(request.headers.authorization)))return finish(400,{error:'Invalid session'});
    try {
    let body;
    if(['POST','DELETE'].includes(request.method)) {
      if(!request.headers['content-type']?.startsWith('application/json'))return finish(400,{error:'JSON required'});
      const chunks=[];let bytes=0;
      for await(const chunk of request){bytes+=chunk.length;if(bytes>12000)return finish(413,{error:'Request too large'});chunks.push(chunk);}
      body=Buffer.concat(chunks);
    }
      const result=await fetcher(`${upstream.href.replace(/\/$/,'')}${path}`,{method:request.method,redirect:'error',
        signal:AbortSignal.timeout(timeoutMs),headers:{...(body?{'content-type':'application/json'}:{}),
          ...(request.headers.authorization?{authorization:request.headers.authorization}:{}),
          ...(request.headers.origin?{origin:request.headers.origin}:{})},...(body?{body}: {})});
      const reader=result.body?.getReader();let bytes=0,chunks=[];
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536){await reader.cancel();throw new Error('Oversized P2P alert response');}chunks.push(Buffer.from(value));}
      const encoded=Buffer.concat(chunks).toString();JSON.parse(encoded);
      response.writeHead(result.status);response.end(encoded);return true;
    }catch{if(response.destroyed||response.writableEnded)return true;return finish(503,{error:'P2P alert service is unavailable. Retry later.'});}
  };
}
