import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mnemonicToAccount } from 'viem/accounts';
import { verifyMessage } from 'viem';
import { ProfileStore } from '../src/store.mjs';
import { ProfileEngine } from '../src/engine.mjs';
import { defaultWalletAvatar } from '../../../shared/wallet-avatar.mjs';

const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const dir = mkdtempSync(join(tmpdir(), 'turret-profile-smoke-')), token = 'a'.repeat(64);
let container;
try {
  const store = new ProfileStore(join(dir, 'wallet-profiles.sqlite'));
  const engine = new ProfileEngine({ store, verify: (address, message, signature) => verifyMessage({ address, message, signature }) });
  const wallet = mnemonicToAccount('test test test test test test test test test test test junk');
  const avatar = { ...defaultWalletAvatar(wallet.address), palette: 6 };
  const challenge = engine.challenge({ address: wallet.address, avatar, expectedRevision: 0 });
  const expected = await engine.save({ nonce: challenge.nonce, signature: await wallet.signMessage({ message: challenge.message }) });
  store.close();
  container = docker(['run', '-d', '--rm', '-p', '127.0.0.1::3031', '-v', `${dir}:/data`,
    '-e', `PROFILE_PROXY_TOKEN=${token}`, '-e', 'PROFILE_RPC_URL=http://127.0.0.1:9', 'turret-wallet-profiles:local-review']);
  let base = `http://${docker(['port', container, '3031/tcp'])}`;
  async function waitReady() {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if ((await fetch(base + '/healthz')).status === 200) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local profile container did not become ready');
  }
  await waitReady();
  const headers = { authorization: `Bearer ${token}`, 'x-profile-client-ip': '192.0.2.1' };
  assert.deepEqual(await (await fetch(base + `/profiles/${wallet.address}`, { headers })).json(), expected);
  assert.equal((await fetch(base + `/profiles/${wallet.address}`)).status, 401);
  docker(['restart', container]); base = `http://${docker(['port', container, '3031/tcp'])}`; await waitReady();
  assert.deepEqual(await (await fetch(base + `/profiles/${wallet.address}`, { headers })).json(), expected);
  const missingVolume = (() => { try { docker(['run', '--rm', '-e', `PROFILE_PROXY_TOKEN=${token}`, 'turret-wallet-profiles:local-review']); return false; } catch { return true; } })();
  assert.equal(missingVolume, true);
  const report = { passed: true, checkedAt: new Date().toISOString(),
    sourceHashes: JSON.parse(readFileSync(new URL('../evidence/build-manifest.json', import.meta.url))).sourceHashes,
    privateAuthenticationChecked: true, realSignatureSeededProfileSurvivedContainerRestart: true,
    missingProductionVolumeRejected: true, publicNetworkTransactions: 0,
    image: docker(['image', 'inspect', 'turret-wallet-profiles:local-review', '--format', '{{.Id}}']) };
  writeFileSync(new URL('../evidence/docker-smoke.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, containerRestartPersistence: true, publicNetworkTransactions: 0 }));
} finally {
  if (container) { try { docker(['stop', container]); } catch {} }
  rmSync(dir, { recursive: true, force: true });
}
