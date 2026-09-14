import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import CrcCalculator from 'pngjs/lib/crc.js';
import { mnemonicToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { parseSiweMessage } from 'viem/siwe';
import { defaultWalletAvatar, renderWalletAvatar, validateWalletAvatar } from '../../../shared/wallet-avatar.mjs';
import { ProfileStore } from '../src/store.mjs';
import { ProfileEngine, avatarHash } from '../src/engine.mjs';
import { createProfileServer } from '../src/http.mjs';
import { validateProfileImage } from '../src/image.mjs';

const mnemonic = 'test test test test test test test test test test test junk';
const account = mnemonicToAccount(mnemonic), attacker = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const origin = 'https://turret.capital', token = 'a'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const png = () => PNG.sync.write({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 4, 211) });
function setup(t, verifier = async (address, message, signature) => verifyMessage({ address, message, signature })) {
  const dir = mkdtempSync(join(tmpdir(), 'turret-profile-test-')), path = join(dir, 'profiles.sqlite');
  let now = Date.parse('2026-09-07T00:00:00Z');
  const store = new ProfileStore(path), engine = new ProfileEngine({ store, verify: verifier, now: () => now });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, path, tick: milliseconds => { now += milliseconds; } };
}
const request = (avatar = defaultWalletAvatar(account.address), expectedRevision = 0) => ({ address: account.address, avatar, expectedRevision });
const signed = async (challenge, signer = account) => ({ nonce: challenge.nonce, signature: await signer.signMessage({ message: challenge.message }) });

test('generated avatars are deterministic, canonical and contain only our SVG shapes', () => {
  const avatar = defaultWalletAvatar(account.address);
  assert.deepEqual(avatar, defaultWalletAvatar(account.address.toLowerCase()));
  assert.notDeepEqual(avatar, defaultWalletAvatar(attacker.address));
  const svg = renderWalletAvatar(avatar);
  assert.equal(svg, renderWalletAvatar(avatar));
  assert.match(svg, /^<svg /); assert.ok(!/script|foreignObject|href|style=|onload|<image/.test(svg));
  for (const bad of [{ ...avatar, seed: '<script>' }, { ...avatar, palette: 8 }, { ...avatar, html: 'x' },
    { kind: 'image', version: 1, hash: 'https://x.example/a.png' }]) assert.throws(() => validateWalletAvatar(bad));
  assert.throws(() => renderWalletAvatar({ kind: 'image', version: 1, hash: 'a'.repeat(64) }));
});

test('SIWE binds exact avatar, origin, wallet, chain, expiry and revision; successful save is public and persistent', async t => {
  const { store, engine, path } = setup(t), avatar = { ...defaultWalletAvatar(account.address), palette: 4 };
  assert.equal(store.profile(account.address).revision, 0);
  const challenge = engine.challenge(request(avatar)), message = parseSiweMessage(challenge.message);
  assert.equal(message.address.toLowerCase(), account.address.toLowerCase());
  assert.equal(message.domain, 'turret.capital'); assert.equal(message.scheme, 'https'); assert.equal(message.chainId, 4663);
  assert.equal(message.expirationTime - message.issuedAt, 300_000);
  assert.ok(message.resources.includes(`urn:turret:avatar:sha256:${avatarHash(avatar)}`));
  assert.ok(message.resources.includes('urn:turret:avatar:revision:0'));
  const submission = await signed(challenge), profile = await engine.save(submission);
  assert.equal(profile.revision, 1); assert.deepEqual(profile.avatar, avatar);
  await assert.rejects(engine.save(submission), /expired|already used/);
  const reopened = new ProfileStore(path); assert.deepEqual(reopened.profile(account.address), profile); reopened.close();
  assert.throws(() => engine.challenge(request(avatar, 0)), /changed/);
});

test('wrong wallet, changed message, added save fields, expiry and concurrent replay cannot modify a profile', async t => {
  const { store, engine, tick } = setup(t);
  assert.throws(() => engine.challenge({ ...request(), address: '0x' + '0'.repeat(40) }), /Invalid wallet/);
  let challenge = engine.challenge(request());
  await assert.rejects(engine.save(await signed(challenge, attacker)), /does not match/);
  challenge = engine.challenge(request());
  const changedMessage = { ...challenge, message: challenge.message.replace('Chain ID: 4663', 'Chain ID: 1') };
  await assert.rejects(engine.save(await signed(changedMessage)), /does not match/);
  challenge = engine.challenge(request());
  await assert.rejects(engine.save({ ...await signed(challenge), avatar: defaultWalletAvatar(attacker.address) }), /Invalid/);
  tick(300_000); await assert.rejects(engine.save(await signed(challenge)), /expired/);
  assert.equal(store.profile(account.address).revision, 0);
  challenge = engine.challenge(request());
  const payload = await signed(challenge), results = await Promise.allSettled([engine.save(payload), engine.save(payload)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(store.profile(account.address).revision, 1);
});

test('independent stale signatures and expiration during verification are rejected atomically', async t => {
  const { store, engine, tick } = setup(t);
  const first = engine.challenge(request()), second = engine.challenge(request({ ...defaultWalletAvatar(account.address), palette: 6 }));
  await engine.save(await signed(first));
  await assert.rejects(engine.save(await signed(second)), /expired|already used/);
  const challenge = engine.challenge(request(defaultWalletAvatar(account.address), 1));
  engine.verify = async () => { tick(300_000); return true; };
  await assert.rejects(engine.save(await signed(challenge)), /expired/);
  assert.equal(store.profile(account.address).revision, 1);
});

test('two service instances sharing SQLite cannot both consume an update revision', async t => {
  const { store, engine, path } = setup(t), secondStore = new ProfileStore(path);
  t.after(() => secondStore.close());
  const secondEngine = new ProfileEngine({ store: secondStore, now: engine.now,
    verify: async (address, message, signature) => verifyMessage({ address, message, signature }) });
  const one = await signed(engine.challenge(request())), two = await signed(secondEngine.challenge(request()));
  const results = await Promise.allSettled([engine.save(one), secondEngine.save(two)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(store.profile(account.address).revision, 1);
});

test('valid photo is stored only after ownership proof and survives restart; existing hash can be reused', async t => {
  const { store, engine, path } = setup(t), bytes = png(), hash = digest(bytes), avatar = { kind: 'image', version: 1, hash };
  assert.throws(() => engine.challenge(request(avatar)), /Upload/);
  const challenge = engine.challenge({ ...request(avatar), image: bytes.toString('base64') });
  assert.equal(store.image(hash), null);
  const profile = await engine.save(await signed(challenge)); assert.deepEqual(store.image(hash), bytes);
  const reopened = new ProfileStore(path); assert.deepEqual(reopened.profile(account.address), profile); assert.deepEqual(reopened.image(hash), bytes); reopened.close();
  await engine.save(await signed(engine.challenge(request(avatar, 1))));
  assert.equal(store.profile(account.address).revision, 2);
  assert.throws(() => engine.challenge({ ...request(defaultWalletAvatar(account.address), 2), image: bytes.toString('base64') }), /do not accept/);
});

test('persistent image cap rolls back replacement while existing images and generated saves remain available', async t => {
  const { store, engine } = setup(t), first = png(), firstHash = digest(first);
  store.maxStoredImageBytes = first.length;
  const firstAvatar = { kind: 'image', version: 1, hash: firstHash };
  await engine.save(await signed(engine.challenge({ ...request(firstAvatar), image: first.toString('base64') })));
  const replacement = PNG.sync.write({ width: 256, height: 256, data: Buffer.alloc(256 * 256 * 4, 112) });
  const secondHash = digest(replacement), secondAvatar = { kind: 'image', version: 1, hash: secondHash };
  const pending = engine.challenge({ ...request(secondAvatar, 1), image: replacement.toString('base64') });
  await assert.rejects(engine.save(await signed(pending)), error => error.status === 429 && /storage is full/.test(error.message));
  assert.equal(store.profile(account.address).revision, 1); assert.deepEqual(store.profile(account.address).avatar, firstAvatar);
  assert.equal(store.image(secondHash), null); assert.deepEqual(store.image(firstHash), first);
  // Deduplicated reuse does not consume any additional quota.
  await engine.save(await signed(engine.challenge(request(firstAvatar, 1))));
  // A full image store cannot block switching back to a generated avatar.
  await engine.save(await signed(engine.challenge(request(defaultWalletAvatar(account.address), 2))));
  assert.equal(store.profile(account.address).avatar.kind, 'generated'); assert.equal(store.profile(account.address).revision, 3);
});

test('profile-count cap rejects new insertion atomically while existing wallet updates still work', async t => {
  const { store, engine } = setup(t); store.maxProfiles = 1;
  const other = { address: attacker.address, avatar: defaultWalletAvatar(attacker.address), expectedRevision: 0 };
  const first = engine.challenge(request()), pendingOther = engine.challenge(other);
  await engine.save(await signed(first));
  await assert.rejects(engine.save(await signed(pendingOther, attacker)), error => error.status === 429 && /at capacity/.test(error.message));
  assert.equal(store.profile(attacker.address).revision, 0);
  assert.throws(() => engine.challenge(other), error => error.status === 429 && /at capacity/.test(error.message));
  await engine.save(await signed(engine.challenge(request({ ...defaultWalletAvatar(account.address), palette: 4 }, 1))));
  assert.equal(store.profile(account.address).revision, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM profiles').get().count, 1);
});

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); result.write(type, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(CrcCalculator.crc32(result.subarray(4, -4)) >>> 0, result.length - 4); return result;
}
function rawPng({ width = 256, height = 256, depth = 8, color = 6, interlace = 0, inflated, tail = Buffer.alloc(0), extra = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color; header[12] = interlace;
  const packed = Buffer.concat([deflateSync(inflated ?? Buffer.alloc((256 * 4 + 1) * 256)), tail]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), extra, chunk('IDAT', packed), chunk('IEND', Buffer.alloc(0))]);
}
test('strict image validation rejects malformed CRC, dimensions, bombs, metadata, animation and trailing data', () => {
  const good = png(); assert.deepEqual(validateProfileImage(good.toString('base64'), digest(good)), good);
  const crc = Buffer.from(good); crc[crc.length - 1] ^= 1;
  const invalid = [crc, Buffer.concat([good, Buffer.from('script')]), rawPng({ width: 65_535 }), rawPng({ depth: 16 }),
    rawPng({ interlace: 1 }), rawPng({ color: 3 }), rawPng({ inflated: Buffer.alloc(4_000_000) }),
    rawPng({ tail: Buffer.from('trailing') }), rawPng({ extra: chunk('tEXt', Buffer.from('private metadata')) }),
    rawPng({ extra: chunk('acTL', Buffer.alloc(8)) }), Buffer.alloc(300 * 1024 + 1)];
  for (const bytes of invalid) assert.throws(() => validateProfileImage(bytes.toString('base64'), digest(bytes)), /valid 256/);
  assert.throws(() => validateProfileImage(good.toString('base64'), 'a'.repeat(64)), /valid 256/);
  assert.throws(() => validateProfileImage(`data:image/png;base64,${good.toString('base64')}`, digest(good)), /valid 256/);
});

test('private HTTP rejects unauthenticated/spoofed/oversized requests and serves identical profiles across viewers', async t => {
  const { engine, store } = setup(t), server = createProfileServer({ engine, store, proxyToken: token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-profile-client-ip': '192.0.2.1', 'x-profile-origin': origin, 'content-type': 'application/json' };
  const post = (path, data, customHeaders = headers) => fetch(base + path, { method: 'POST', headers: customHeaders, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/profiles/' + account.address)).status, 401);
  assert.equal((await post('/profiles/challenge', request(), { ...headers, authorization: 'Bearer bad' })).status, 401);
  assert.equal((await post('/profiles/challenge', request(), { ...headers, 'x-profile-client-ip': 'spoof,1.1.1.1' })).status, 400);
  assert.equal((await post('/profiles/challenge', request(), { ...headers, 'x-profile-origin': 'https://evil.example' })).status, 403);
  assert.equal((await post('/profiles/challenge', { data: 'a'.repeat(420_001) })).status, 413);
  assert.equal((await post('/profiles/save', { data: 'a'.repeat(12_289) })).status, 413);
  assert.equal((await post('/profiles/challenge', request(), { ...headers, 'content-type': 'text/plain' })).status, 415);
  const challenge = await (await post('/profiles/challenge', request())).json();
  const saved = await (await post('/profiles/save', await signed(challenge))).json();
  const otherViewer = await fetch(base + '/profiles/' + account.address, { headers: { ...headers, 'x-profile-client-ip': '192.0.2.2' } });
  assert.deepEqual(await otherViewer.json(), saved); assert.equal(otherViewer.headers.get('cache-control'), 'no-store');
  const bytes = png(), hash = digest(bytes);
  const imageChallenge = await (await post('/profiles/challenge', { ...request({ kind: 'image', version: 1, hash }, 1), image: bytes.toString('base64') })).json();
  await post('/profiles/save', await signed(imageChallenge));
  const imageResponse = await fetch(base + `/profiles/avatar/${hash}.png`, { headers });
  assert.equal(imageResponse.headers.get('content-type'), 'image/png'); assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), bytes);
  assert.equal((await fetch(base + `/profiles/avatar/${hash}.png`)).status, 401);
});

test('verification capacity and challenge rates are bounded; RPC failure does not save', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const { engine, store } = setup(t, async () => { await wait; throw new Error('RPC failed'); });
  const pending = [];
  for (let index = 0; index < 4; index++) pending.push(engine.save(await signed(engine.challenge(request()))));
  await assert.rejects(engine.save(await signed(engine.challenge(request()))), /busy/);
  release(); for (const result of pending) await assert.rejects(result, /RPC failed/);
  assert.equal(store.profile(account.address).revision, 0);
  for (let index = 5; index < 20; index++) engine.challenge(request());
  assert.throws(() => engine.challenge(request()), /Too many/);
});
