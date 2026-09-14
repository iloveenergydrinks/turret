import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, maxUint256, keccak256 } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { CashbackLedger } from '../src/ledger.mjs';
import { readCanonicalBlock, readCanonicalRange, syncLedger } from '../src/chain.mjs';
import { preparePublication } from '../src/publication.mjs';
import { createRewardsServer } from '../src/http.mjs';
import { verifyRuntimeConfig } from '../src/config.mjs';
import { startRuntime } from '../src/runtime.mjs';
import { saveAllocation } from '../src/archive.mjs';
import { buildAllocation } from '../src/merkle.mjs';
import { readPublicEnrollment, submitPublicEnrollment, verifyPublicEnrollment } from '../../../frontend/app/src/borrower-cashback/enrollment.ts';
import { CashbackClaimReverted, previewCashbackClaim, submitCashbackClaim, verifyCashbackClaim } from '../../../frontend/app/src/borrower-cashback/transactions.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const rewards = join(root, 'contracts/rewards');
const central = join(root, 'output/central-credit-20260908/contracts');
const artifact = (base, file, name) => JSON.parse(readFileSync(join(base, 'out', file, `${name}.json`), 'utf8'));
const day = 86400;

test('real loan receipts fund cashback while preserving lender interest and staker fee routing', { timeout: 120000 }, async () => {
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
    const proof = allocation.claims[0];
    const claimConfig = { chainId: 31337, rewardToken: usdg, deployment: { address: campaign,
      runtimeHash: keccak256(await client.getCode({ address: campaign })) } };
    const claim = { ...proof, root: allocation.root };
    await new Promise(resolve => api.close(resolve));
    assert.equal(await previewCashbackClaim({ client, config: claimConfig, claim, account: borrower.address }), 500000n);
    const claimHash = await submitCashbackClaim({ client, wallet, config: claimConfig, claim, account: borrower.address });
    const claimReceipt = await mined(claimHash);
    const verifiedClaim = await verifyCashbackClaim({ client, config: claimConfig, claim, account: borrower.address, hash: claimHash });
    assert.equal(verifiedClaim.received, 500000n);
    await new Promise(resolve => api.listen(apiPort, '127.0.0.1', resolve));
    assert.equal(await read(usdg, tokenABI, 'balanceOf', [borrower.address]), 500000n);
    const afterClaim = await (await fetch(apiURL)).json();
    assert.equal(afterClaim.accounts[0].claimed, '500000');
    assert.equal(afterClaim.accounts[0].claimable, '0');
    const runtimePolicy = { ...policy, engines: { [engine.toLowerCase()]: { aprBps:1000, pool,
      runtimeHash:keccak256(await client.getCode({address:engine})), poolRuntimeHash:keccak256(await client.getCode({address:pool})) } } };
    const runtimeConfig = { chainId:31337, distributor:campaign, rewardToken:usdg,
      runtimeHash:claimConfig.deployment.runtimeHash, policy:runtimePolicy, startBlock:1, confirmations:0,
      rpcUrl:chain.rpcUrls.default.http[0] };
    const runtimeDirectory = join(directory,'runtime');
    saveAllocation(join(runtimeDirectory,'allocations'), { ...allocation, throughBlock:checkpoint.number, blockHash:checkpoint.hash });
    runtime = await startRuntime({ config:runtimeConfig, directory:runtimeDirectory, port:0, host:'127.0.0.1', pollMs:1000 });
    await runtime.sync();
    const runtimeResult = await (await fetch(`${runtime.url}/v1/rewards/${borrower.address}`)).json();
    assert.equal(runtimeResult.accounts[0].confirmedRebate,'500000');
    assert.equal(runtimeResult.accounts[0].claimed,'500000');
    await runtime.close(); runtime = null;
    runtime = await startRuntime({ config:runtimeConfig, directory:runtimeDirectory, port:0, host:'127.0.0.1', pollMs:1000 });
    await runtime.sync();
    assert.equal((await (await fetch(`${runtime.url}/v1/rewards/${borrower.address}`)).json()).accounts[0].claimed,'500000');
    await runtime.close(); runtime = null;
    await assert.rejects(send(campaign, campaignABI, 'claim', [allocation.root,
      proof.borrower, proof.engine, proof.cumulative, proof.proof]));
    const revertedHash = await wallet.writeContract({ address:campaign, abi:campaignABI.abi, functionName:'claim',
      args:[allocation.root,proof.borrower,proof.engine,proof.cumulative,proof.proof], account:borrower.address, gas:1000000n });
    assert.equal((await client.waitForTransactionReceipt({hash:revertedHash})).status,'reverted');
    await assert.rejects(verifyCashbackClaim({client,config:claimConfig,claim,account:borrower.address,hash:revertedHash}),CashbackClaimReverted);
    await send(router, routerABI, 'collect', [pool]);
    const staking = await read(router, routerABI, 'staking');
    assert.equal(await read(staking, stakingABI, 'totalFunded'), 150000n);
    assert.equal(await read(usdg, tokenABI, 'balanceOf', [operator.address]), 150000n);
    assert.equal(await read(pool, poolABI, 'totalAssets'), 1002_700000n);
    // A separate loan is liquidated using the actual production Price signature path.
    // Its full receipt contains Repaid and Liquidated; the reader must retain both.
    const secondBorrower = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 2 });
    const secondStart = Number((await client.getBlock()).timestamp) + 100;
    const secondPolicy = { ...policy, startsAt: secondStart, endsAt: secondStart + 10 * day,
      settlementDeadline: secondStart + 40 * day, claimDeadline: secondStart + 70 * day };
    const secondCampaign = await deploy(campaignABI, [usdg, operator.address, operator.address,
      secondStart, secondPolicy.endsAt, secondPolicy.settlementDeadline, secondPolicy.claimDeadline]);
    await send(usdg, tokenABI, 'mint', [operator.address, 500_000000n]);
    await send(usdg, tokenABI, 'approve', [secondCampaign, maxUint256]);
    await send(secondCampaign, campaignABI, 'fund', [100_000000n]);
    await send(secondCampaign, campaignABI, 'enroll', [secondBorrower.address, engine, 10_000000n]);
    await send(engine, engineABI, 'setRiskPaused', [false]);
    await send(collateral, collateralABI, 'mint', [secondBorrower.address, 20n * 10n ** 18n]);
    await send(collateral, collateralABI, 'approve', [engine, maxUint256], secondBorrower);
    const secondApproval = { ...approval, borrower: secondBorrower.address, observedAt: secondStart, deadline: secondStart + 60 };
    const secondSignature = await operator.sign({ hash: await read(engine, engineABI, 'approvalDigest', [secondApproval]) });
    await setTime(secondStart);
    await send(engine, engineABI, 'executeApproved', [secondApproval, secondSignature], secondBorrower);
    await send(usdg, tokenABI, 'approve', [engine, maxUint256]);
    const liquidationTime = secondStart + 10 * day;
    const price = { value: 20n * 10n ** 18n, observedAt: liquidationTime, deadline: liquidationTime + 60, epoch: 0n };
    const priceSignature = await operator.sign({ hash: await read(engine, engineABI, 'priceDigest', [price]) });
    await setTime(liquidationTime);
    const liquidationReceipt = await send(engine, engineABI, 'liquidateApproved', [secondBorrower.address,
      maxUint256, 1n, price, priceSignature]);
    const liquidationLedger = new CashbackLedger({ path: ':memory:', policy: secondPolicy, startBlock: 1 });
    try {
      for (let number = 1; number <= Number(liquidationReceipt.blockNumber); number++) {
        liquidationLedger.ingest(await readCanonicalBlock({ client, number, campaign: secondCampaign, engines: [engine] }));
      }
      const excluded = liquidationLedger.account(secondBorrower.address)[0];
      assert.equal(excluded.confirmedRebate, 0n);
      assert.equal(excluded.estimatedRebate, 0n);
      assert.equal(excluded.principal, 0n);
    } finally { liquidationLedger.close(); }
    // A separate distributor checks JavaScript proofs with multiple leaves and an
    // odd leaf count against Solidity. These synthetic awards test Merkle transport,
    // not receipt eligibility (which the loan flow above checks independently).
    const merkleStart = Number((await client.getBlock()).timestamp) + 100;
    const merkleCampaign = await deploy(campaignABI,[usdg,operator.address,operator.address,
      merkleStart,merkleStart+day,merkleStart+2*day,merkleStart+3*day]);
    await send(usdg,tokenABI,'mint',[operator.address,10_000000n]);
    await send(usdg,tokenABI,'approve',[merkleCampaign,maxUint256]);
    await send(merkleCampaign,campaignABI,'fund',[10_000000n]);
    const merkleBorrowers = [borrower,secondBorrower,
      mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex:3})];
    for (const owner of merkleBorrowers) await send(merkleCampaign,campaignABI,'enroll',[owner.address,engine,3_000000n]);
    const multiple = buildAllocation({chainId:31337,distributor:merkleCampaign,
      accounts:merkleBorrowers.map((owner,i)=>({borrower:owner.address,engine,cap:3_000000n,confirmedRebate:BigInt(i+1)*500000n}))});
    const merkleHead=await client.getBlock();
    await send(merkleCampaign,campaignABI,'publish',[multiple.root,merkleHead.number,merkleHead.hash]);
    assert.ok(multiple.claims.every(claim=>claim.proof.length>0));
    for (const claim of multiple.claims) {
      const before=await read(usdg,tokenABI,'balanceOf',[claim.borrower]);
      await send(merkleCampaign,campaignABI,'claim',[multiple.root,claim.borrower,claim.engine,claim.cumulative,claim.proof]);
      assert.equal(await read(usdg,tokenABI,'balanceOf',[claim.borrower]),before+claim.cumulative);
    }
    const first=multiple.claims[0];
    await assert.rejects(send(merkleCampaign,campaignABI,'claim',[multiple.root,first.borrower,first.engine,first.cumulative+1n,first.proof]));
    // Public enrollment uses the actual wallet helper, full engine history and one funded wallet cap.
    const publicABI=artifact(rewards,'TurretPublicBorrowerCashback.sol','TurretPublicBorrowerCashback');
    const publicStart=Number((await client.getBlock()).timestamp)+100;
    const publicPolicy={...policy,startsAt:publicStart,endsAt:publicStart+30*day,settlementDeadline:publicStart+60*day,
      claimDeadline:publicStart+90*day,walletCap:'25000000'};
    const publicCampaign=await deploy(publicABI,[usdg,operator.address,operator.address,publicStart,publicPolicy.endsAt,
      publicPolicy.settlementDeadline,publicPolicy.claimDeadline,[engine]]);
    await send(usdg,tokenABI,'mint',[operator.address,1000_000000n]);
    await send(usdg,tokenABI,'approve',[publicCampaign,1000_000000n]);
    await send(publicCampaign,publicABI,'fund',[1000_000000n]);
    await setTime(publicStart);await client.request({method:'evm_mine',params:[]});
    const publicClaimConfig={chainId:31337,rewardToken:usdg,deployment:{address:publicCampaign,
      runtimeHash:keccak256(await client.getCode({address:publicCampaign})),publicEnrollment:true}};
    const publicInput={client,config:publicClaimConfig,account:borrower.address,engine};
    const borrowerWallet=createWalletClient({chain,transport,account:borrower});
    const joinHash=await submitPublicEnrollment({...publicInput,wallet:borrowerWallet});await mined(joinHash);
    assert.equal((await verifyPublicEnrollment({...publicInput,hash:joinHash})).joined,true);
    assert.equal((await readPublicEnrollment(publicInput)).slots,39);
    await assert.rejects(submitPublicEnrollment({...publicInput,wallet:borrowerWallet}));
    await send(engine,engineABI,'setRiskPaused',[false]);
    const publicLoanTime=Number((await client.getBlock()).timestamp)+10;
    const publicApproval={...approval,nonce:await read(engine,engineABI,'approvalNonces',[borrower.address]),observedAt:publicLoanTime,deadline:publicLoanTime+60};
    const publicSig=await operator.sign({hash:await read(engine,engineABI,'approvalDigest',[publicApproval])});
    await setTime(publicLoanTime);await send(engine,engineABI,'executeApproved',[publicApproval,publicSig],borrower);
    await send(usdg,tokenABI,'mint',[borrower.address,4_000000n]);
    await setTime(publicLoanTime+10*day);await send(engine,engineABI,'close',[maxUint256,borrower.address],borrower);
    const publicLedger=new CashbackLedger({path:':memory:',policy:publicPolicy,startBlock:1});
    try {
      await syncLedger({client,ledger:publicLedger,startBlock:1,campaign:publicCampaign,engines:[engine],confirmations:0});
      const row=publicLedger.account(borrower.address)[0];assert.equal(row.confirmedRebate,500000n);
      const sparse=new CashbackLedger({path:':memory:',policy:publicPolicy,startBlock:1});
      try {
        const end=publicLedger.head().number;
        sparse.ingestRange(await readCanonicalRange({client,from:1,to:end,campaign:publicCampaign,engines:[engine]}));
        assert.deepEqual(sparse.accounts(),publicLedger.accounts());
        const resumed=new CashbackLedger({path:':memory:',policy:publicPolicy,startBlock:1});
        try {
          let result;do {result=await syncLedger({client,ledger:resumed,startBlock:1,campaign:publicCampaign,engines:[engine],confirmations:0,historicalRange:20,maxReorgDepth:5,maxBlocks:7});}while(result.more);
          assert.deepEqual(resumed.accounts(),publicLedger.accounts());
        }finally{resumed.close();}
      }finally{sparse.close();}
      const publicRuntimeConfig={...publicationConfig,distributor:publicCampaign,runtimeHash:publicClaimConfig.deployment.runtimeHash,
        policy:{...publicPolicy,engines:publicationConfig.policy.engines}};
      await verifyRuntimeConfig(client,publicRuntimeConfig);
      const publicApi=createRewardsServer({client,ledger:publicLedger,allocations:[],config:publicRuntimeConfig});
      await new Promise(resolve=>publicApi.listen(0,'127.0.0.1',resolve));
      try {
        const response=await fetch(`http://127.0.0.1:${publicApi.address().port}/v1/rewards/${borrower.address}`);
        assert.equal(response.status,200);const body=await response.json();
        assert.equal(body.joined,true);assert.equal(body.publicEnrollment.walletCap,'25000000');
        assert.equal(body.accounts[0].confirmedRebate,'500000');
      }finally{await new Promise(resolve=>publicApi.close(resolve));}

      const allocation=buildAllocation({chainId:31337,distributor:publicCampaign,accounts:publicLedger.accounts()});
      const head=publicLedger.head();await send(publicCampaign,publicABI,'publish',[allocation.root,BigInt(head.number),head.hash]);
      const claim=allocation.claims[0];const input={client,config:publicClaimConfig,account:borrower.address,claim:{...claim,root:allocation.root,cumulative:BigInt(claim.cumulative)}};
      const claimHash=await submitCashbackClaim({...input,wallet:borrowerWallet});await mined(claimHash);
      assert.equal((await verifyCashbackClaim({...input,hash:claimHash})).received,500000n);
      assert.equal(await read(publicCampaign,publicABI,'walletClaimed',[borrower.address]),500000n);
      writeFileSync(join(root,'output/borrower-cashback-20260911/public-chain-evidence.json'),JSON.stringify({localOnly:true,publicCampaign,joinHash,claimHash,
        walletCap:'25 USDG',budget:'1000 USDG',reservedWallets:1,remainingSlots:39,paidInterest:'1 USDG',cashback:'0.5 USDG'},null,2)+'\n');
    }finally{publicLedger.close();}
    const report = { chainId: 31337, localOnly: true, borrower: borrower.address, engine, pool, campaign,
      borrow: borrowReceipt.transactionHash, repayment: repayReceipt.transactionHash, claim: claimReceipt.transactionHash,
      paidInterestUSDG: '3.000000', cashbackUSDG: '0.500000', lenderInterestUSDG: '2.700000',
      stakerReserveUSDG: '0.150000', treasuryUSDG: '0.150000', transactionCount: transactions.length,
      liquidation: liquidationReceipt.transactionHash, liquidationCashbackUSDG: '0.000000',
      multiLeafClaimsVerified:multiple.claims.length,
      campaignRuntimeHash: keccak256(await client.getCode({ address: campaign })) };
    writeFileSync(join(root, 'output/borrower-cashback-20260911/local-chain-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (runtime) await runtime.close();
    if (api) await new Promise(resolve => api.close(resolve));
    ledger?.close();
    anvil.kill('SIGTERM');
    await new Promise(resolve => { if (anvil.exitCode !== null) resolve(); else anvil.once('exit', resolve); });
    rmSync(directory, { recursive: true, force: true });
  }
});
