import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const PREFIX = '/api/profiles';
const IMAGE_LIMIT = 300 * 1024;

function configuredOrigin(value, { privateService = false, allowLocal = false } = {}) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid profile origin');
  if (privateService) {
    if (!((url.protocol === 'http:' || url.protocol === 'https:') && /^[a-z0-9-]+\.railway\.internal$/.test(url.hostname))
      && !(url.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.up\.railway\.app$/.test(url.hostname))
      && !(allowLocal && local && url.protocol === 'http:')) throw new Error('Profiles require a private service origin');
  } else if (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) throw new Error('Invalid profile app origin');
  return url.origin;
}

async function boundedBody(stream, limit, timeoutMs) {
  const parts = []; let size = 0;
  const timer = timeoutMs && typeof stream.destroy === 'function'
    ? setTimeout(() => stream.destroy(new Error('Profile request body timed out')), timeoutMs) : null;
  timer?.unref();
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
      parts.push(bytes);
    }
    return Buffer.concat(parts);
  } finally { if (timer) clearTimeout(timer); }
}

/** Call after siteAccess. Handles only the fixed wallet-profile API namespace. */
export function createProfileProxy({
  serviceUrl = process.env.PROFILE_SERVICE_URL,
  proxyToken = process.env.PROFILE_PROXY_TOKEN,
  appOrigin = process.env.PROFILE_APP_ORIGIN ?? 'https://turret.capital',
  allowLocal = process.env.NODE_ENV !== 'production',
  trustRailwayProxy = Boolean(process.env.RAILWAY_ENVIRONMENT_ID),
  timeoutMs = 12_000,
  fetchImpl = fetch,
} = {}) {
  const origin = configuredOrigin(appOrigin, { allowLocal });
  let upstream = null;
  if (serviceUrl || proxyToken) {
    if (!serviceUrl || !/^[a-f0-9]{64}$/.test(proxyToken ?? '')) throw new Error('Incomplete profile proxy configuration');
    upstream = configuredOrigin(serviceUrl, { privateService: true, allowLocal });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error('Invalid profile timeout');
  return async function profileProxy(request, response, securityHeaders = {}) {
    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); } catch { return false; }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return false;
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      const image = /^\/api\/profiles\/avatar\/([a-f0-9]{64})\.png$/.exec(url.pathname);
      const profile = /^\/api\/profiles\/0x[0-9a-fA-F]{40}$/.test(url.pathname);
      const mutation = ['/api/profiles/challenge', '/api/profiles/save'].includes(url.pathname);
      if (url.search || !(image || profile || mutation)) { send(404, { error: 'Profile route not found.' }); return true; }
      if ((mutation && request.method !== 'POST') || (!mutation && !['GET', 'HEAD'].includes(request.method))) {
        send(405, { error: 'Method not allowed.' }); return true;
      }
      if (mutation) {
        if (request.headers.origin !== origin || request.headers.host?.toLowerCase() !== new URL(origin).host.toLowerCase()
          || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
          send(403, { error: 'Save your avatar from this website.' }); return true;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          send(415, { error: 'JSON required.' }); return true;
        }
      }
      if (!upstream) { send(503, { error: 'Public profiles are not configured yet.' }); return true; }
      const limit = url.pathname.endsWith('/challenge') ? 420_000 : 12_288;
      if (mutation && Number(request.headers['content-length'] ?? 0) > limit) { send(413, { error: 'Request too large.' }); return true; }
      const body = mutation ? await boundedBody(request, limit, timeoutMs) : undefined;
      if (body) {
        try { JSON.parse(body.toString('utf8')); } catch { send(400, { error: 'Invalid JSON.' }); return true; }
      }
      // Railway documents X-Real-IP as its client IP header. It is trusted only
      // in the explicitly configured Railway environment, never in local tests.
      const forwarded = trustRailwayProxy ? request.headers['x-real-ip'] : null;
      const socketIp = request.socket.remoteAddress;
      const clientIp = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : socketIp;
      if (!clientIp || !isIP(clientIp)) { send(503, { error: 'Unable to verify this profile request.' }); return true; }
      const result = await fetchImpl(upstream + url.pathname.slice('/api'.length), {
        method: mutation ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${proxyToken}`, 'x-profile-client-ip': clientIp,
          ...(mutation ? { 'x-profile-origin': origin, 'content-type': 'application/json' } : {}) },
        body,
      });
      let bytes;
      try { bytes = result.body ? await boundedBody(result.body, image && result.status === 200 ? IMAGE_LIMIT : 12_288) : Buffer.alloc(0); }
      catch { throw new Error('Invalid profile service response'); }
      if (image && result.status === 200) {
        if (!/^image\/png(?:;|$)/i.test(result.headers.get('content-type') ?? '')
          || createHash('sha256').update(bytes).digest('hex') !== image[1]) throw new Error('Invalid profile image response');
        response.writeHead(200, { ...securityHeaders, 'Content-Type': 'image/png', 'Content-Length': bytes.length,
          'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox" });
        response.end(request.method === 'HEAD' ? undefined : bytes); return true;
      }
      if (!/^application\/json(?:;|$)/i.test(result.headers.get('content-type') ?? '')
        || ![200, 400, 401, 403, 404, 409, 413, 415, 429, 503].includes(result.status)) throw new Error('Invalid profile service response');
      const value = JSON.parse(bytes.toString('utf8'));
      if (request.method === 'HEAD') {
        response.writeHead(result.status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end();
      } else send(result.status, value, result.status === 429 ? { 'Retry-After': '60' } : {});
      return true;
    } catch (error) {
      if (!response.headersSent) send(error.status === 413 ? 413 : 503,
        { error: error.status === 413 ? 'Request too large.' : 'Profiles are temporarily unavailable. Please retry.' });
      else response.end();
      return true;
    } finally { request.resume(); }
  };
}
