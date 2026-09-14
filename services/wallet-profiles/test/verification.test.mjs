import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPublicClient, createWalletClient, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createOwnershipVerifier } from '../src/verify.mjs';

const mnemonic = 'test test test test test test test test test test test junk';
const account = mnemonicToAccount(mnemonic), other = mnemonicToAccount(mnemonic, { addressIndex: 1 });
test('zero-address ecrecover sentinel is rejected before any RPC request', async () => {
  const verify = createOwnershipVerifier({ rpcUrl: 'http://127.0.0.1:9', chainId: 31337 });
  assert.equal(await verify('0x' + '0'.repeat(40), 'Avatar update', '0x' + '0'.repeat(128) + '1b'), false);
});
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('public-client verification checks actual EOA/ERC-1271 state on isolated localhost; revocation is honored', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'turret-profile-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'));
  copyFileSync(new URL('./contracts/Wallet1271.sol', import.meta.url), join(dir, 'src/Wallet1271.sol'));
  execFileSync('forge', ['build', '--root', dir, '--offline', '--use', '0.8.26'], { stdio: 'pipe', timeout: 30_000 });
  const artifact = JSON.parse(readFileSync(join(dir, 'out/Wallet1271.sol/Wallet1271.json')));
  const port = await freePort(), rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  t.after(async () => { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); });
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0, timeout: 1_000 }) });
  let chain;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { chain = await publicClient.getChainId(); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(chain, 31337, 'Test transactions are restricted to the newly spawned localhost chain');
  const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });
  const deployment = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [account.address] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployment });
  assert.equal(receipt.status, 'success');
  const verify = createOwnershipVerifier({ rpcUrl, chainId: 31337 });
  const message = 'Local Turret profile ownership test: no public-network transactions';
  const signature = await account.signMessage({ message }), wrong = await other.signMessage({ message });
  assert.equal(await verify(account.address, message, signature), true);
  assert.equal(await verify(account.address, message, wrong), false);
  assert.equal(await verify(receipt.contractAddress, message, signature), true);
  assert.equal(await verify(receipt.contractAddress, message, wrong), false);
  const revoke = await wallet.writeContract({ address: receipt.contractAddress, abi: artifact.abi, functionName: 'setEnabled', args: [false] });
  await publicClient.waitForTransactionReceipt({ hash: revoke });
  assert.equal(await verify(receipt.contractAddress, message, signature), false);
  // Provider selection now rejects a wrong chain before it can serve a wallet
  // call; exhausted candidates surface the same bounded unavailable response.
  await assert.rejects(createOwnershipVerifier({ rpcUrl })(account.address, message, signature), /unavailable/);
});

test('RPC failures cannot pass via viem ECDSA fallback; transport exposes only bounded reads', async t => {
  const methods = [], calls = [];
  const server = createHttpServer(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts)); methods.push(body.method); calls.push(body.params);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body.method === 'eth_chainId'
      ? { jsonrpc: '2.0', id: body.id, result: '0x7a69' }
      : { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'upstream unavailable' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const verify = createOwnershipVerifier({ rpcUrl: `http://127.0.0.1:${server.address().port}`, chainId: 31337, timeout: 250 });
  const message = 'Local ECDSA fallback rejection test', signature = await account.signMessage({ message });
  await assert.rejects(verify(account.address, message, signature), /unavailable/);
  assert.deepEqual(methods, ['eth_chainId', 'eth_call']);
  assert.equal(calls[1][0].gas, '0x7a120'); assert.equal(calls[1][1], 'latest');
  assert.throws(() => createOwnershipVerifier({ rpcUrl: 'http://remote.example', chainId: 31337 }), /requires HTTPS/);
  assert.throws(() => createOwnershipVerifier({ rpcUrl: 'https://remote.example', chainId: 1 }), /Unsupported/);
});
