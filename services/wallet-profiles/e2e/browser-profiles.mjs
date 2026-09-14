import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { mnemonicToAccount } from 'viem/accounts';
import { ProfileEngine } from '../src/engine.mjs';
import { ProfileStore } from '../src/store.mjs';
import { createProfileServer } from '../src/http.mjs';
import { createOwnershipVerifier } from '../src/verify.mjs';
import { defaultWalletAvatar, renderWalletAvatar } from '../../../shared/wallet-avatar.mjs';

const ROOT = resolve(new URL('../../../', import.meta.url).pathname), OUT = resolve(new URL('../evidence/', import.meta.url).pathname);
const stage = process.argv[2];
assert(stage && /^\/(private\/tmp|var\/folders|tmp)\//.test(stage), 'Pass the reviewed temporary full-app stage');
const base = 'http://127.0.0.1:3166', node = '/opt/homebrew/Cellar/node@24/24.18.1/bin/node';
const keyphrase = 'test test test test test test test test test test test junk';
const actors = { owner: mnemonicToAccount(keyphrase), other: mnemonicToAccount(keyphrase, { addressIndex: 1 }) };
const addresses = Object.fromEntries(Object.entries(actors).map(([name, actor]) => [name, actor.address.toLowerCase()]));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { passed: false, publicNetworkTransactions: 0, localChainTransactions: 0, startedAt: new Date().toISOString(),
  stage, url: base + '/portfolio', checks: [], walletRequests: [], signatures: [], browserErrors: [], resourceErrors: [], blockedExternalRequests: [], servedFiles: [] };
report.serviceSourceHashes = JSON.parse(await readFile(join(OUT, 'build-manifest.json'))).sourceHashes;
for (const [path, digest] of Object.entries(report.serviceSourceHashes)) assert.equal(sha(await readFile(join(ROOT, path))), digest);
report.stagedProxySha256 = sha(await readFile(join(stage, 'frontend/app/scripts/profile-proxy.mjs')));
const releasePath = join(ROOT, 'output/platform-loading-profiles/frontend-integration/release.json');
const releaseBytes = await readFile(releasePath), release = JSON.parse(releaseBytes);
assert.equal(release.stage, stage, 'Use the current final frontend release stage');
report.frontendReleaseSha256 = sha(releaseBytes); report.frontendSourceHashes = release.sourceHashes;
const dir = await mkdtemp(join(tmpdir(), 'turret-profile-browser-'));
let anvil, frontend, service, browser, page, store, unavailable = false;
const children = [], contexts = [], serverMessages = [], assetJobs = [], assetErrors = [];
async function port() {
  const server = createNetServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function waitFor(fn, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await fn().catch(() => false)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out: ' + label);
}
function child(command, args, options = {}) {
  const process = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(process);
  process.stdout.on('data', data => serverMessages.push(data.toString())); process.stderr.on('data', data => serverMessages.push(data.toString())); return process;
}
function mark(name, details = {}) { report.checks.push({ name, ...details }); console.log(name); }
try {
  const rpcUrl = `http://127.0.0.1:${await port()}`;
  anvil = child('anvil', ['--host', '127.0.0.1', '--port', new URL(rpcUrl).port, '--chain-id', '4663', '--silent']);
  await waitFor(async () => (await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })).json()).result === '0x1237', 'owned local Anvil');
  const token = randomBytes(32).toString('hex');
  store = new ProfileStore(join(dir, 'profiles.sqlite'));
  const engine = new ProfileEngine({ store, origin: base, verify: createOwnershipVerifier({ rpcUrl }) });
  service = createProfileServer({ engine, store, proxyToken: token });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const serviceUrl = `http://127.0.0.1:${service.address().port}`;
  frontend = child(node, [join(stage, 'frontend/app/scripts/serve-mvp.mjs')], { cwd: stage,
    env: { ...process.env, NODE_ENV: 'development', PORT: '3166', TURRET_SITE_GATE: '0', PROFILE_SERVICE_URL: serviceUrl,
      PROFILE_PROXY_TOKEN: token, PROFILE_APP_ORIGIN: base, DOCKYARD_RPC_URL: rpcUrl, RAILWAY_ENVIRONMENT_ID: '' } });
  await waitFor(async () => (await fetch(base + '/portfolio')).status === 200, 'staged portfolio');
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  async function viewer() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }); contexts.push(context);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === base || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      report.blockedExternalRequests.push({ url: url.origin + url.pathname, method: route.request().method() }); return route.abort('blockedbyclient');
    });
    await context.exposeBinding('__profileSign', async (_, { actor, message }) => {
      assert(actors[actor]); assert.match(message, /^0x[0-9a-f]+$/i);
      const text = Buffer.from(message.slice(2), 'hex').toString('utf8');
      assert(text.startsWith(base + ' wants you to sign in with your Ethereum account:'));
      assert(text.includes('Chain ID: 4663')); assert(text.includes('Save this public Turret wallet avatar.'));
      report.signatures.push({ actor, messageSha256: sha(Buffer.from(text)), message: text });
      return actors[actor].signMessage({ message: { raw: message } });
    });
    await context.exposeBinding('__profileWalletAudit', (_, method) => { report.walletRequests.push(method); });
    await context.addInitScript(({ addresses }) => {
      const listeners = new Map(); let actor = 'owner', connected = sessionStorage.getItem('profile-test-connected') === '1';
      let reject = false, switchDuringSign = false;
      const emit = (name, value) => { for (const callback of listeners.get(name) || []) callback(value); };
      const provider = { isMetaMask: true, chainId: '0x1237', selectedAddress: connected ? addresses[actor] : null,
        isConnected: () => connected, _metamask: { isUnlocked: async () => true },
        async request({ method, params = [] }) {
          await window.__profileWalletAudit(method);
          if (['eth_sendTransaction', 'eth_sendRawTransaction', 'wallet_sendCalls', 'eth_sign', 'eth_signTypedData_v4'].includes(method)) throw new Error('Transactions and unrelated signing are forbidden in the avatar fixture');
          if (method === 'eth_chainId') return '0x1237';
          if (method === 'net_version') return '4663';
          if (method === 'eth_accounts') return connected ? [addresses[actor]] : [];
          if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
            connected = true; sessionStorage.setItem('profile-test-connected', '1'); provider.selectedAddress = addresses[actor];
            emit('connect', { chainId: '0x1237' }); emit('accountsChanged', [addresses[actor]]);
            return method === 'eth_requestAccounts' ? [addresses[actor]] : [{ parentCapability: 'eth_accounts' }];
          }
          if (method === 'wallet_getPermissions') return connected ? [{ parentCapability: 'eth_accounts' }] : [];
          if (method === 'wallet_revokePermissions') { connected = false; sessionStorage.removeItem('profile-test-connected'); return null; }
          if (method === 'personal_sign') {
            if (reject) { reject = false; throw Object.assign(new Error('User rejected the request'), { code: 4001 }); }
            const signingActor = actor;
            if (params[1].toLowerCase() !== addresses[actor]) throw new Error('Unexpected signing account');
            const result = window.__profileSign({ actor: signingActor, message: params[0] });
            if (switchDuringSign) { switchDuringSign = false; actor = 'other'; provider.selectedAddress = addresses[actor]; emit('accountsChanged', [addresses[actor]]); }
            return result;
          }
          if (method === 'wallet_switchEthereumChain') return null;
          throw new Error('Unsupported test wallet method: ' + method);
        },
        on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); return provider; },
        removeListener(name, callback) { listeners.get(name)?.delete(callback); return provider; },
        removeAllListeners(name) { if (name) listeners.delete(name); else listeners.clear(); return provider; },
      };
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
      window.__profileWallet = { rejectNext: () => { reject = true; }, switchOnSign: () => { switchDuringSign = true; },
        setActor(name) { actor = name; provider.selectedAddress = connected ? addresses[actor] : null; emit('accountsChanged', connected ? [addresses[actor]] : []); } };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({
        info: { uuid: 'cb1e37dc-0287-46c9-9344-dfb16eaf766b', name: 'MetaMask', rdns: 'io.metamask',
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" fill="%23333"/></svg>' }, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce); announce();
    }, { addresses });
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== base) return;
      if (response.status() >= 400) report.resourceErrors.push({ path: url.pathname, status: response.status(), expected: unavailable && url.pathname.startsWith('/api/profiles/') });
      if (url.pathname === '/portfolio' || url.pathname.startsWith('/platform-assets/')) assetJobs.push((async () => {
        let bytes, capturedBy = 'browser-response';
        try { bytes = await response.body(); }
        catch { bytes = Buffer.from(await (await fetch(response.url())).arrayBuffer()); capturedBy = 'direct-http-after-browser-request'; }
        const path = url.pathname === '/portfolio' ? 'portfolio.html' : url.pathname.slice(1);
        assert.equal(sha(bytes), sha(await readFile(join(stage, 'frontend/app/out', path))));
        report.servedFiles.push({ path, sha256: sha(bytes), bytes: bytes.length, capturedBy });
      })().catch(error => assetErrors.push(error.message)));
    });
    await page.goto(base + '/portfolio', { waitUntil: 'domcontentloaded' });
    return page;
  }
  async function connect(page) {
    const connected = page.getByRole('button', { name: 'Change profile picture', exact: true });
    try { await connected.waitFor({ timeout: 1500 }); return; } catch {}
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).first().click();
    const metamask = page.getByRole('button', { name: /MetaMask/i }).first();
    await Promise.race([metamask.waitFor(), connected.waitFor()]);
    if (await connected.isVisible()) { await page.keyboard.press('Escape'); return; }
    await metamask.click(); await connected.waitFor();
  }
  async function edit(page) {
    await page.getByRole('button', { name: 'Change profile picture', exact: true }).click();
    await page.getByRole('heading', { name: 'Your profile picture', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign and save picture', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.wallet-profile-save')?.disabled);
  }
  const profile = address => fetch(base + '/api/profiles/' + address).then(response => response.json());
  page = await viewer(); await connect(page); await edit(page);
  const original = await profile(addresses.owner); assert.equal(original.revision, 0);
  await page.getByRole('button', { name: 'Generate another', exact: true }).click();
  await page.getByRole('button', { name: 'Violet picture', exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.locator('.wallet-profile-dialog').evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth }));
    assert(dimensions.width <= width && dimensions.scrollWidth <= width);
    await page.screenshot({ path: join(OUT, `profile-browser-editor-${width}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Sign and save picture', exact: true }).click();
  await page.getByText('Profile picture saved.', { exact: true }).waitFor();
  const generated = await profile(addresses.owner);
  assert.equal(generated.revision, 1); assert.equal(generated.avatar.palette, 5); assert.notEqual(generated.avatar.seed, original.avatar.seed);
  mark('Portfolio generated-avatar edit is signed, verified on local EVM, and persisted through the real proxy/backend');
  await page.screenshot({ path: join(OUT, 'profile-browser-generated.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(OUT, 'profile-browser-portfolio-390.png'), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1100 });

  const second = await viewer(); await connect(second);
  const firstSrc = await page.locator('.wallet-profile-trigger img').getAttribute('src');
  await second.waitForFunction(expected => document.querySelector('.wallet-profile-trigger img')?.getAttribute('src') === expected, firstSrc);
  assert.deepEqual(await profile(addresses.owner), generated);
  mark('Independent browser context displays the same saved public avatar without a new signature');

  await edit(page);
  const photo = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 400;
    const context = canvas.getContext('2d'); context.fillStyle = '#ad1457'; context.fillRect(0, 0, 600, 400);
    context.fillStyle = '#fef3c7'; context.fillRect(150, 70, 260, 260);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'local-test-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photo, 'base64') });
  await page.waitForFunction(() => document.querySelector('.wallet-profile-preview img')?.getAttribute('src')?.startsWith('data:image/png;base64,')
    && !document.querySelector('.wallet-profile-save')?.disabled);
  await page.getByRole('button', { name: 'Sign and save picture', exact: true }).click();
  await page.getByText('Profile picture saved.', { exact: true }).waitFor();
  const uploaded = await profile(addresses.owner); assert.equal(uploaded.revision, 2); assert.equal(uploaded.avatar.kind, 'image');
  const png = await (await fetch(base + `/api/profiles/avatar/${uploaded.avatar.hash}.png`)).arrayBuffer();
  assert.equal(sha(Buffer.from(png)), uploaded.avatar.hash); assert.equal(Buffer.from(png).readUInt32BE(16), 256); assert.equal(Buffer.from(png).readUInt32BE(20), 256);
  await second.reload({ waitUntil: 'domcontentloaded' }); await connect(second);
  await second.waitForFunction(hash => document.querySelector('.wallet-profile-trigger img')?.getAttribute('src')?.includes(hash), uploaded.avatar.hash);
  const reopened = new ProfileStore(join(dir, 'profiles.sqlite')); assert.deepEqual(reopened.profile(addresses.owner), uploaded); assert.ok(reopened.image(uploaded.avatar.hash)); reopened.close();
  mark('Real JPEG selection is canvas-cropped to PNG, hash-bound to a signature, and visible to a fresh viewer with durable bytes');
  await page.screenshot({ path: join(OUT, 'profile-browser-photo.png'), fullPage: true });

  await edit(page); await page.getByRole('button', { name: 'Generate another', exact: true }).click();
  await page.evaluate(() => window.__profileWallet.rejectNext());
  await page.getByRole('button', { name: 'Sign and save picture', exact: true }).click();
  await page.getByText('Signature declined. Your profile picture has not changed.', { exact: true }).waitFor();
  assert.deepEqual(await profile(addresses.owner), uploaded);
  mark('Declining the wallet signature leaves the saved public picture unchanged');
  await page.getByRole('button', { name: 'Close profile editor', exact: true }).click();

  await edit(page); await page.getByRole('button', { name: 'Generate another', exact: true }).click();
  await page.evaluate(() => window.__profileWallet.switchOnSign());
  await page.getByRole('button', { name: 'Sign and save picture', exact: true }).click();
  await page.waitForFunction(() => window.ethereum.selectedAddress !== null && !document.querySelector('dialog.wallet-profile-dialog')?.open);
  assert.deepEqual(await profile(addresses.owner), uploaded); assert.equal((await profile(addresses.other)).revision, 0);
  mark('Changing wallet while the signature prompt is pending prevents the old avatar save');

  unavailable = true; await new Promise(resolve => service.close(resolve)); service = null;
  const fallback = await viewer(); await connect(fallback);
  const defaultSvg = renderWalletAvatar(defaultWalletAvatar(addresses.owner));
  await fallback.waitForFunction(() => document.querySelector('.wallet-profile-trigger img')?.complete);
  const fallbackSrc = await fallback.locator('.wallet-profile-trigger img').getAttribute('src');
  assert(fallbackSrc.startsWith('data:image/svg+xml'));
  assert.equal(decodeURIComponent(fallbackSrc.slice(fallbackSrc.indexOf(',') + 1)), defaultSvg);
  await fallback.getByRole('button', { name: 'Change profile picture', exact: true }).click();
  await fallback.locator('.wallet-profile-dialog [role=alert]').waitFor(); assert.equal(await fallback.getByRole('button', { name: 'Sign and save picture', exact: true }).isDisabled(), true);
  mark('Profile service outage falls back to deterministic identity and clearly disables saving');

  await Promise.all(assetJobs);
  assert.deepEqual(assetErrors, []);
  for (const [path, digest] of Object.entries(report.serviceSourceHashes)) assert.equal(sha(await readFile(join(ROOT, path))), digest);
  assert.equal(sha(await readFile(releasePath)), report.frontendReleaseSha256, 'Frontend release changed during the final browser run');
  const finalBlock = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) })).json();
  assert.equal(finalBlock.result, '0x0'); report.localChainRemainedAtGenesis = true;
  assert.deepEqual(report.browserErrors, []);
  assert.deepEqual(report.resourceErrors.filter(error => !error.expected), []);
  report.savedProfile = uploaded; report.passed = true; report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = error.stack ?? String(error); if (page && !page.isClosed()) {
    report.failureText = await page.locator('body').innerText().catch(() => null);
    await page.screenshot({ path: join(OUT, 'profile-browser-failure.png'), fullPage: true }).catch(() => {});
  }
  console.error(report.error); process.exitCode = 1;
} finally {
  await browser?.close(); if (service) await new Promise(resolve => service.close(resolve));
  for (const process of children.reverse()) { if (process.exitCode === null) { process.kill('SIGTERM'); await new Promise(resolve => process.once('exit', resolve)); } }
  store?.close(); await rm(dir, { recursive: true, force: true });
  await writeFile(join(OUT, 'profile-browser.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(OUT, 'profile-browser-server.log'), serverMessages.join(''));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, signatures: report.signatures.length, error: report.error }));
}
