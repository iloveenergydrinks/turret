import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Dependencies are resolved from the existing app workspace; nothing is installed.
const require = createRequire(new URL('../../../frontend/app/package.json', import.meta.url));
const { createPublicClient, createWalletClient, defineChain, http } = require('viem');
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = new URL('../../../output/p2p-loans/', import.meta.url);
const forge = process.env.P2P_FORGE_BINARY || `${homedir()}/.foundry/bin/forge`;
const anvil = process.env.P2P_ANVIL_BINARY || `${homedir()}/.foundry/bin/anvil`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    process.stdout.on('data', value => output += value);
    process.stderr.on('data', value => output += value);
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} failed: ${output}`)));
  });
}

await run(forge, ['build', '--root', root, '--skip', 'test']);
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
// A new local chain is started by this script. No external RPC URL or key is accepted.
const chainProcess = spawn(anvil, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], {
  stdio: 'ignore',
});
let startupError;
chainProcess.on('error', error => { startupError = error; });
const url = `http://127.0.0.1:${port}`;
const chain = defineChain({ id: 31337, name: 'Turret P2P local test', nativeCurrency: { name: 'Test ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), pollingInterval: 20 });
const transactions = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    if (chainProcess.exitCode !== null) throw new Error('Local chain failed to start');
    try { ready = await client.getChainId() === 31337; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, 'Local chain did not become ready');
  assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
  const accounts = await client.request({ method: 'eth_accounts' });
  const [guardian, lender, borrower, helper] = accounts;
  const wallet = account => createWalletClient({ account, chain, transport: http(url), pollingInterval: 20 });
  const readArtifact = async name => JSON.parse(await readFile(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
  const tokenArtifact = await readArtifact('LocalToken');
  const escrowArtifact = await readArtifact('TurretP2PLending');
  const deploy = async (artifact, args) => {
    const hash = await wallet(guardian).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    transactions.push({ action: 'deploy', hash });
    return receipt.contractAddress;
  };
  const loan = await deploy(tokenArtifact, ['Demo USDG', 'dUSDG', 6]);
  const collateral = await deploy(tokenArtifact, ['Demo Silver', 'dSLV', 18]);
  const escrow = await deploy(escrowArtifact, [loan, collateral, guardian, 100_000000n, 1_000_000000n, [lender]]);
  const send = async (account, address, abi, functionName, args = []) => {
    const { request } = await client.simulateContract({ account, address, abi, functionName, args });
    const hash = await wallet(account).writeContract(request);
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    transactions.push({ action: functionName, hash });
    return receipt;
  };
  const tokenSend = (account, token, fn, args) => send(account, token, tokenArtifact.abi, fn, args);
  const act = (account, fn, args) => send(account, escrow, escrowArtifact.abi, fn, args);
  const get = (fn, args = []) => client.readContract({ address: escrow, abi: escrowArtifact.abi, functionName: fn, args });
  const balance = (token, owner) => client.readContract({ address: token, abi: tokenArtifact.abi, functionName: 'balanceOf', args: [owner] });
  const time = async () => (await client.getBlock()).timestamp;
  const advance = async seconds => {
    await client.request({ method: 'evm_increaseTime', params: [seconds] });
    await client.request({ method: 'evm_mine' });
  };
  await tokenSend(guardian, loan, 'mint', [lender, 1000_000000n]);
  await tokenSend(guardian, loan, 'mint', [borrower, 100_000000n]);
  await tokenSend(guardian, collateral, 'mint', [borrower, 100n * 10n ** 18n]);
  await tokenSend(lender, loan, 'approve', [escrow, 1000_000000n]);
  await tokenSend(borrower, loan, 'approve', [escrow, 1000_000000n]);
  await tokenSend(borrower, collateral, 'approve', [escrow, 100n * 10n ** 18n]);

  const create = async (principal = 100_000000n) => {
    const id = await get('nextOfferId');
    await act(lender, 'createOffer', [borrower, principal, 5n * 10n ** 18n, 2_000000n, 7n * 86400n, (await time()) + 1800n]);
    return id;
  };
  const repaid = await create();
  await act(borrower, 'acceptOffer', [repaid]);
  assert.equal(await balance(loan, borrower), 200_000000n);
  await act(guardian, 'setNewLoansPaused', [true]);
  await act(borrower, 'repay', [repaid]);
  assert.equal(await get('credits', [loan, lender]), 102_000000n);
  await act(lender, 'withdraw', [loan, 102_000000n, lender]);
  await act(borrower, 'withdraw', [collateral, 5n * 10n ** 18n, borrower]);
  await act(guardian, 'setNewLoansPaused', [false]);

  const cancelled = await create(25_000000n);
  await act(lender, 'cancelOffer', [cancelled]);
  await act(lender, 'withdraw', [loan, 25_000000n, lender]);

  const expired = await create(25_000000n);
  await advance(1801);
  await act(helper, 'expireOffer', [expired]);
  await act(lender, 'withdraw', [loan, 25_000000n, lender]);

  const defaulted = await create();
  await act(borrower, 'acceptOffer', [defaulted]);
  await advance(8 * 86400 + 1);
  await act(lender, 'claimDefault', [defaulted]);
  await act(lender, 'withdraw', [collateral, 5n * 10n ** 18n, lender]);
  assert.equal(await get('committedPrincipal'), 0n);
  assert.equal(await get('reservedPrincipal'), 0n);
  assert.equal(await get('lockedCollateral'), 0n);
  assert.equal(await get('totalCredits', [loan]), 0n);
  assert.equal(await get('totalCredits', [collateral]), 0n);
  assert.equal(await balance(loan, escrow), 0n);
  assert.equal(await balance(collateral, escrow), 0n);
  assert.equal(await balance(loan, lender), 902_000000n);
  assert.equal(await balance(collateral, lender), 5n * 10n ** 18n);
  const result = {
    passed: true, chainId: 31337, scope: 'Fresh local Anvil, mock tokens, synthetic balances and time',
    publicNetworkTransactions: 0, realTokensQualified: false,
    checks: ['fund and accept', 'repay and withdraw while paused', 'cancel and refund', 'expire and refund', 'default and claim full collateral', 'zero residual liabilities'],
    contracts: { escrow, loan, collateral }, transactions,
  };
  await mkdir(evidence, { recursive: true });
  await writeFile(new URL('local-lifecycle.json', evidence), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, chainId: 31337, localTransactions: transactions.length, publicNetworkTransactions: 0, checks: result.checks }));
} finally {
  chainProcess.kill('SIGTERM');
}
