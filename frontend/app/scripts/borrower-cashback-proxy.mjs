/** Read-only proxy. Request data can never choose the upstream or forward site credentials. */
export function createBorrowerCashbackProxy({ url = process.env.BORROWER_CASHBACK_URL, fetcher = fetch, timeoutMs = 10000 } = {}) {
  let upstream;
  if (url) {
    upstream = new URL(url);
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash)
      throw new Error('Invalid cashback upstream');
  }
  return async (request, response) => {
    const incoming = new URL(request.url || '/', 'http://localhost');
    const mount = '/api/borrower-cashback';
    if (!incoming.pathname.startsWith(`${mount}/`)) return false;
    const path = incoming.pathname.slice(mount.length);
    const send = (status, value) => { response.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store',
      'x-content-type-options':'nosniff' }); response.end(JSON.stringify(value)); return true; };
    if (request.method !== 'GET' || incoming.search || !/^\/v1\/(campaign|rewards\/0x[0-9a-fA-F]{40})$/.test(path))
      return send(404, { error:'Unknown cashback endpoint' });
    if (!upstream) return send(200, { status:'inactive', campaign:null });
    try {
      const result = await fetcher(`${upstream.href.replace(/\/$/,'')}${path}`, { method:'GET', redirect:'error',
        signal:AbortSignal.timeout(timeoutMs), headers:{ accept:'application/json' } });
      const reader = result.body?.getReader();
      const chunks = []; let bytes = 0;
      if (reader) for (;;) {
        const {done,value} = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 524288) { await reader.cancel(); throw new Error('Oversized cashback response'); }
        chunks.push(Buffer.from(value));
      }
      return send(result.status, JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { return send(503, { status:'unavailable', error:'Cashback information is unavailable' }); }
  };
}
