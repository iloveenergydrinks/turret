// Local-only browser E2E harness. Uses the public Anvil mnemonic; never deploy this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, maxUint256, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { CashbackLedger } from '../src/ledger.mjs';
import { readCanonicalBlock, syncLedger } from '../src/chain.mjs';
import { preparePublication } from '../src/publication.mjs';
import { createRewardsServer } from '../src/http.mjs';
import { startRuntime } from '../src/runtime.mjs';
import { saveAllocation } from '../src/archive.mjs';
import { CashbackClaimReverted, previewCashbackClaim, submitCashbackClaim, verifyCashbackClaim } from '../../../frontend/app/src/borrower-cashback/transactions.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rewards = join(root, 'contracts/rewards');
const central = join(root, 'output/central-credit-20260908/contracts');
const artifact = (base, file, name) => JSON.parse(readFileSync(join(base, 'out', file, `${name}.json`), 'utf8'));
const day = 86400;

async function run() {
  execFileSync(join(homedir(), '.foundry/bin/forge'), ['build', '--silent'], { cwd: rewards, stdio: 'pipe' });
  execFileSync(join(homedir(), '.foundry/bin/forge'), ['build', '--silent'], { cwd: central, stdio: 'pipe' });
  const portServer = createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), 'turret-cashback-chain-'));
  const anvil = spawn(join(homedir(), '.foundry/bin/anvil'), ['--silent', '--host', '127.0.0.1', '--port', String(port),
    '--chain-id', '31337', '--hardfork', 'cancun'], { stdio: 'ignore' });
  // Standard public Anvil test mnemonic. Never uses a real wallet or environment signing key.
  const operator = mnemonicToAccount('test test test test test test test test test test test junk');
  const borrower = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 });
  const chain = { id: 31337, name: 'Cashback local test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } };
  const transport = http(chain.rpcUrls.default.http[0], { retryCount: 0 });
  const client = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 20 });
  const wallet = createWalletClient({ chain, transport });
  let ledger;
  let api;
  let runtime;
  const transactions = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { assert.equal(await client.getChainId(), 31337); ready = true; break; } catch {}
      if (anvil.exitCode !== null) throw new Error('Local Anvil exited before startup');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'local chain starts');
    const mined = async hash => {
      const receipt = await client.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success'); transactions.push(hash); return receipt;
    };
    const deploy = async (abi, args) => (await mined(await wallet.deployContract({ account: operator,
      abi: abi.abi, bytecode: abi.bytecode.object, args }))).contractAddress;
    const send = async (address, abi, functionName, args, account = operator) => mined(await wallet.writeContract({
      address, abi: abi.abi, functionName, args, account }));
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi: abi.abi, functionName, args });
    const setTime = timestamp => client.request({ method: 'evm_setNextBlockTimestamp', params: [timestamp] });
    const tokenABI = artifact(rewards, 'TurretBorrowerCashback.t.sol', 'CashbackUSDG');
    const engineABI = artifact(central, 'TurretCreditEngine.sol', 'TurretCreditEngine');
    const poolABI = artifact(central, 'TurretCapitalPool.sol', 'TurretCapitalPool');
    const campaignABI = artifact(rewards, 'TurretBorrowerCashback.sol', 'TurretBorrowerCashback');
    const routerABI = artifact(rewards, 'TurretRecoverableFeeRouter.sol', 'TurretRecoverableFeeRouter');
    const stakingABI = artifact(rewards, 'TurretRecoverableStaking.sol', 'TurretRecoverableStaking');
    const collateralABI = artifact(central, 'TurretCredit.t.sol', 'Token');
    const usdg = await deploy(tokenABI, []);
    const collateral = await deploy(collateralABI, [18]);
    const turret = await deploy(collateralABI, [18]);
    const engine = await deploy(engineABI, [{ usdg, collateral, guardian: operator.address,
      maxLtvBps: 3000, liquidationLtvBps: 4000, bonusBps: 500, minimumDebt: 20_000_000n }, operator.address]);
    const pool = await deploy(poolABI, [usdg, collateral, engine, operator.address, 10000_000000n, 1000, 1000]);
    await send(engine, engineABI, 'bindPool', [pool]);
    await send(engine, engineABI, 'setRiskPaused', [false]);
    await send(usdg, tokenABI, 'mint', [operator.address, 1100_000000n]);
    await send(usdg, tokenABI, 'approve', [pool, maxUint256]);
    await send(pool, poolABI, 'deposit', [1000_000000n, operator.address]);
    const router = await deploy(routerABI, [turret, usdg, operator.address, [pool]]);
    await send(usdg, tokenABI, 'approve', [router, maxUint256]);
    const start = Number((await client.getBlock()).timestamp) + 100;
    const policy = { startsAt: start, endsAt: start + 10 * day, settlementDeadline: start + 40 * day,
      claimDeadline: start + 70 * day, rebateBps: 5000, engines: { [engine.toLowerCase()]: { aprBps: 1000 } } };
    const campaign = await deploy(campaignABI, [usdg, operator.address, operator.address,
      start, policy.endsAt, policy.settlementDeadline, policy.claimDeadline]);
    await send(usdg, tokenABI, 'approve', [campaign, maxUint256]);
    await send(campaign, campaignABI, 'fund', [100_000000n]);
    await send(campaign, campaignABI, 'enroll', [borrower.address, engine, 10_000000n]);
    await send(collateral, collateralABI, 'mint', [borrower.address, 20n * 10n ** 18n]);
    await send(collateral, collateralABI, 'approve', [engine, maxUint256], borrower);
    await send(usdg, tokenABI, 'approve', [engine, maxUint256], borrower);
    const approval = { borrower: borrower.address, action: 1, collateralAmount: 20n * 10n ** 18n,
      debtAmount: 365_000000n, maxDebt: 365_000000n, price: 100n * 10n ** 18n,
      nonce: 0n, observedAt: start, deadline: start + 60, epoch: 0n };
    const signature = await operator.sign({ hash: await read(engine, engineABI, 'approvalDigest', [approval]) });
    await setTime(start);
    const borrowReceipt = await send(engine, engineABI, 'executeApproved', [approval, signature], borrower);
    assert.equal(await read(usdg, tokenABI, 'balanceOf', [borrower.address]), 365_000000n);
    await send(usdg, tokenABI, 'mint', [borrower.address, 3_000000n]);
    // A risk-service outage and stopped reward enrollment must not block repayment.
    await send(engine, engineABI, 'setRiskPaused', [true]);
    await send(campaign, campaignABI, 'setEnrollmentPaused', [true]);
    await setTime(start + 30 * day);
    const repayReceipt = await send(engine, engineABI, 'close', [maxUint256, borrower.address], borrower);
    assert.equal(await read(engine, engineABI, 'positionDebt', [borrower.address]), 0n);
    assert.equal(await read(collateral, collateralABI, 'balanceOf', [borrower.address]), 20n * 10n ** 18n);
    assert.equal(await read(pool, poolABI, 'totalAssets'), 1002_700000n);
    assert.equal(await read(pool, poolABI, 'protocolFees'), 300000n);
    ledger = new CashbackLedger({ path: join(directory, 'ledger.sqlite'), policy, startBlock: 1 });
    await syncLedger({ client, ledger, startBlock: 1, campaign, engines: [engine], confirmations: 0 });
    const earned = ledger.account(borrower.address)[0];
    assert.equal(earned.confirmedRebate, 500000n);
    assert.equal(earned.eligiblePaidInterest, 1000000n);
    const publicationConfig = { chainId:31337, distributor:campaign, rewardToken:usdg,
      runtimeHash:keccak256(await client.getCode({address:campaign})),startBlock:1,confirmations:0,
      policy:{...policy,engines:{[engine.toLowerCase()]:{aprBps:1000,pool,
        runtimeHash:keccak256(await client.getCode({address:engine})),poolRuntimeHash:keccak256(await client.getCode({address:pool}))}}} };
    const prepared = await preparePublication({client,ledger,config:publicationConfig,directory:join(directory,'prepared')});
    const allocation = prepared.allocation;
    const checkpoint = ledger.head();
    api = createRewardsServer({ client, ledger, allocations: [allocation], config: { chainId: 31337,
      distributor: campaign, rewardToken: usdg, runtimeHash: keccak256(await client.getCode({ address: campaign })), policy } });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    const apiPort = api.address().port;
    const apiURL = `http://127.0.0.1:${apiPort}/v1/rewards/${borrower.address}`;
    const beforePublication = await fetch(apiURL);
    assert.equal(beforePublication.status, 200);
    const unpublished = await beforePublication.json();
    assert.equal(unpublished.accounts[0].confirmedRebate, '500000');
    assert.equal(unpublished.accounts[0].claimable, '0');
    await mined(await wallet.sendTransaction({...prepared.transaction,account:operator}));
    ledger.protectPublication(allocation.root, checkpoint.number, checkpoint.hash);
    const published = await (await fetch(apiURL)).json();
    assert.equal(published.accounts[0].claimable, '500000');
    assert.equal(published.accounts[0].claim.root, allocation.root);
    const config = { chainId:31337, rewardToken:usdg, deployment:{address:campaign,
      runtimeHash:keccak256(await client.getCode({address:campaign}))} };
    let online = true;
    const control = createHTTPServer(async (req,res) => {
      try {
        const url = new URL(req.url,'http://127.0.0.1');
        const sendJSON = body => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(body)); };
        if (url.pathname === '/fixture' && req.method === 'GET') return sendJSON({config,borrower:borrower.address,
          other:operator.address,rpc:chain.rpcUrls.default.http[0],engine,policy});
        if (url.pathname.startsWith('/api/borrower-cashback/')) {
          if (!online) {res.statusCode=503;return sendJSON({error:'test_outage'});}
          const response = await fetch(`http://127.0.0.1:${apiPort}${url.pathname.replace('/api/borrower-cashback','')}`);
          res.statusCode=response.status;res.setHeader('Content-Type','application/json');return res.end(await response.text());
        }
        if (req.method === 'POST') {
          if (url.pathname === '/control/offline') online=false;
          else if (url.pathname === '/control/online') online=true;
          else if (url.pathname === '/control/pause') await client.request({method:'evm_setAutomine',params:[false]});
          else if (url.pathname === '/control/mine') {
            await client.request({method:'evm_mine',params:[]});
            await client.request({method:'evm_setAutomine',params:[true]});
            await syncLedger({client,ledger,startBlock:1,campaign,engines:[engine],confirmations:0});
          } else {res.statusCode=404;return res.end();}
          return sendJSON({ok:true,online});
        }
        if (url.pathname === '/evidence') {
          return sendJSON({chainId:31337,localOnly:true,borrow:borrowReceipt.transactionHash,repayment:repayReceipt.transactionHash,
            borrower:borrower.address,engine,campaign,claimed:String(await read(campaign,campaignABI,'claimed',[borrower.address,engine])),
            borrowerUSDG:String(await read(usdg,tokenABI,'balanceOf',[borrower.address])),online});
        }
        res.statusCode=404;res.end();
      } catch(error) {res.statusCode=500;res.end(error.message);}
    });
    await new Promise(resolve=>control.listen(4289,'127.0.0.1',resolve));
    console.log('Local browser fixture ready on 127.0.0.1:4289; all assets and accounts are disposable.');
    await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
    await new Promise(resolve=>control.close(resolve));
  } finally {
    if (api) await new Promise(resolve => api.close(resolve));
    ledger?.close(); anvil.kill('SIGTERM');
    await new Promise(resolve => { if (anvil.exitCode !== null) resolve(); else anvil.once('exit', resolve); });
    rmSync(directory,{recursive:true,force:true});
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
