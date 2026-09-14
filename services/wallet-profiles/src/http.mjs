import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { normalizeWalletAddress } from '../../../shared/wallet-avatar.mjs';
import { ProfileError } from './store.mjs';

async function readBody(request, limit = 12_288) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new ProfileError('JSON required.', 415);
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new ProfileError('Request too large.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ProfileError('Request too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProfileError('Invalid JSON.'); }
}

export function createProfileServer({ engine, store, proxyToken, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/.test(proxyToken ?? '')) throw new Error('PROFILE_PROXY_TOKEN must contain 32 random bytes in lowercase hex');
  const expected = Buffer.from(`Bearer ${proxyToken}`);
  const reply = (response, status, value) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'",
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    });
    response.end(JSON.stringify(value));
  };
  let lastPrune = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz' && request.method === 'GET') {
        store.db.prepare('SELECT 1').get(); reply(response, 200, { ok: true }); return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ProfileError('Profile proxy authentication required.', 401);
      // The private proxy token is checked before any forwarded metadata is used.
      const clientIp = request.headers['x-profile-client-ip'];
      if (typeof clientIp !== 'string' || !isIP(clientIp)) throw new ProfileError('Valid client IP required.');
      const ipKey = createHmac('sha256', proxyToken).update(clientIp).digest('hex');
      const time = now();
      if (time - lastPrune > 60_000) { store.prune(time); lastPrune = time; }
      store.rate('requests:global', 2_000, 60_000, time);
      store.rate(`requests:${ipKey}`, 240, 60_000, time);
      if (url.search) throw new ProfileError('Unexpected query parameters.');
      const imageRoute = /^\/profiles\/avatar\/([a-f0-9]{64})\.png$/.exec(url.pathname);
      if (request.method === 'GET' && imageRoute) {
        const image = store.image(imageRoute[1]);
        if (!image) throw new ProfileError('Avatar image not found.', 404);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length,
          'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox" });
        response.end(image); return;
      }
      const addressRoute = /^\/profiles\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname);
      if (request.method === 'GET' && addressRoute) {
        reply(response, 200, store.profile(normalizeWalletAddress(addressRoute[1]))); return;
      }
      if (request.method !== 'POST') throw new ProfileError('Profile route not found.', 404);
      if (!['/profiles/challenge', '/profiles/save'].includes(url.pathname)) throw new ProfileError('Profile route not found.', 404);
      if (request.headers['x-profile-origin'] !== engine.origin
        || (request.headers.origin && request.headers.origin !== engine.origin)) throw new ProfileError('Profile origin does not match.', 403);
      store.rate(`writes:${ipKey}`, 40, 60_000, time);
      const body = await readBody(request, url.pathname === '/profiles/challenge' ? 420_000 : 12_288);
      const result = url.pathname === '/profiles/challenge' ? engine.challenge(body) : await engine.save(body);
      reply(response, 200, result);
    } catch (error) {
      request.resume();
      if (!response.headersSent) reply(response, error instanceof ProfileError ? error.status : 503,
        { error: error instanceof ProfileError ? error.message : 'Profiles are temporarily unavailable. Please retry.' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  return server;
}
