import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { PNG } from 'pngjs';
import { createProfileProxy } from '../../../frontend/app/scripts/profile-proxy.mjs';
import { createSiteAccess, hashSitePassword } from '../../../frontend/app/scripts/site-access.mjs';

const token = 'a'.repeat(64), address = '0x' + '1'.repeat(40);
const bytes = PNG.sync.write({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 4, 221) });
const hash = createHash('sha256').update(bytes).digest('hex');
async function start(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('frontend proxy scopes routes, overwrites private headers, enforces origin/body limits, and verifies image hashes', async t => {
  const received = [];
  const upstream = await start(createServer(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk);
    received.push({ path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(parts).toString() });
    if (request.url.includes('/avatar/')) { response.setHeader('content-type', 'image/png'); response.end(bytes); }
    else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ address, revision: 0 })); }
  }), t);
  let proxy;
  const base = await start(createServer(async (request, response) => {
    if (!await proxy(request, response)) { response.writeHead(404); response.end('unrelated'); }
  }), t);
  proxy = createProfileProxy({ serviceUrl: upstream, proxyToken: token, appOrigin: base, allowLocal: true, trustRailwayProxy: false });
  const headers = { origin: base, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
    authorization: 'Bearer attacker', cookie: 'private-cookie=not-forwarded', 'x-profile-client-ip': '203.0.113.9',
    'x-real-ip': '203.0.113.10', 'x-profile-origin': 'https://evil.example' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/profiles-other')).status, 404); assert.equal(received.length, 0);
  assert.equal((await fetch(base + '/api/profiles/../rpc')).status, 404); assert.equal(received.length, 0);
  assert.equal((await post('/api/profiles/challenge', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/profiles/challenge', {}, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await fetch(base + '/api/profiles/challenge')).status, 405);
  assert.equal((await post('/api/profiles/save', { extra: 'x'.repeat(12_289) })).status, 413);
  assert.equal((await post('/api/profiles/challenge', { extra: 'x'.repeat(420_001) })).status, 413);
  assert.equal((await post('/api/profiles/challenge', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(received.length, 0);
  const result = await post('/api/profiles/challenge', { address }); assert.equal(result.status, 200);
  assert.equal(received[0].headers.authorization, `Bearer ${token}`);
  assert.equal(received[0].headers['x-profile-client-ip'], '127.0.0.1'); assert.equal(received[0].headers['x-profile-origin'], base);
  assert.equal(received[0].headers.cookie, undefined); assert.equal(received[0].headers.origin, undefined);
  const image = await fetch(base + `/api/profiles/avatar/${hash}.png`); assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes); assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + `/api/profiles/avatar/${'b'.repeat(64)}.png`)).status, 503);
  const head = await fetch(base + `/api/profiles/avatar/${hash}.png`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal((await head.text()).length, 0);
  assert.throws(() => createProfileProxy({ serviceUrl: 'https://public.example', proxyToken: token }), /private/);
  assert.throws(() => createProfileProxy({ serviceUrl: 'http://profiles.railway.internal/path', proxyToken: token }), /origin/);
  assert.throws(() => createProfileProxy({ serviceUrl: 'http://user:pass@profiles.railway.internal', proxyToken: token }), /origin/);
  assert.doesNotThrow(() => createProfileProxy({ serviceUrl: 'https://turret-profiles-production.up.railway.app', proxyToken: token, allowLocal: false }));
  assert.throws(() => createProfileProxy({ serviceUrl: 'http://turret-profiles-production.up.railway.app', proxyToken: token, allowLocal: false }), /private/);
  assert.throws(() => createProfileProxy({ serviceUrl: 'https://a.b.up.railway.app', proxyToken: token, allowLocal: false }), /private/);
  assert.throws(() => createProfileProxy({ serviceUrl: 'https://turret-profiles-production.up.railway.app?secret=x', proxyToken: token }), /origin/);
});

test('upstream failures, redirects and timeouts stay generic; unconfigured profile service leaves other routes alone', async t => {
  const upstream = await start(createServer((request, response) => {
    if (request.url === `/profiles/${address}`) { response.writeHead(302, { location: 'https://evil.example/credential-collection' }); response.end(); }
    else setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{}'); }, 200);
  }), t);
  let proxy;
  const base = await start(createServer(async (request, response) => { if (!await proxy(request, response)) response.end('original app'); }), t);
  proxy = createProfileProxy({ serviceUrl: upstream, proxyToken: token, appOrigin: base, allowLocal: true, timeoutMs: 50 });
  let result = await fetch(base + `/api/profiles/${address}`); assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes('evil.example'));
  result = await fetch(base + `/api/profiles/${'0x' + '2'.repeat(40)}`); assert.equal(result.status, 503);
  proxy = createProfileProxy({ appOrigin: base, allowLocal: true });
  assert.equal(await (await fetch(base + '/earn')).text(), 'original app');
  assert.equal((await fetch(base + `/api/profiles/${address}`)).status, 503);
});

test('existing password gate protects profile JSON/images and overrides authenticated image cache', async t => {
  const upstream = await start(createServer((request, response) => {
    response.setHeader('content-type', 'image/png'); response.end(bytes);
  }), t);
  const gate = createSiteAccess({ enabled: true, passwordHash: await hashSitePassword('synthetic-test-password'), signingKey: 'b'.repeat(64), secure: false });
  let proxy;
  const base = await start(createServer(async (request, response) => {
    if (await gate(request, response)) return;
    if (!await proxy(request, response)) response.end('original app');
  }), t);
  proxy = createProfileProxy({ serviceUrl: upstream, proxyToken: token, appOrigin: base, allowLocal: true });
  const path = `/api/profiles/avatar/${hash}.png`;
  assert.equal((await fetch(base + path)).status, 401);
  const login = await fetch(base + '/__access/login', { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'synthetic-test-password', next: '/portfolio' }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const image = await fetch(base + path, { headers: { cookie } }); assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
});
