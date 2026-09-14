import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient,createWalletClient,http,keccak256,toHex } from 'viem';
import { generatePrivateKey,privateKeyToAccount } from 'viem/accounts';
import { isolatedConfigFromEnv } from '../src/isolated/config.mjs';
import { IsolatedChain } from '../src/isolated/chain.mjs';
import { IsolatedEngine } from '../src/isolated/engine.mjs';
import { IsolatedTransactions } from '../src/isolated/transactions.mjs';
import { Store } from '../src/store.mjs';
import { Store as AlertsStore } from '../../borrower-alerts/src/store.mjs';
import { Engine as AlertsEngine } from '../../borrower-alerts/src/engine.mjs';
import { ISOLATED_USDG } from '../../borrower-alerts/src/isolated-monitor.mjs';
import { resolveAlertsDeployment,bindAlertsRuntime,createMonitor,alertsLinks,activateAlerts } from '../../borrower-alerts/src/runtime.mjs';

const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
const tokenArtifact=()=>artifact('DockyardUSDGCreditVault.t.sol','DockyardMockERC20');
const oracleArtifact=()=>artifact('DockyardUSDGCreditVault.t.sol','DockyardMockOracle');
async function unusedPort() {
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

for (const mode of ['retained','atomic','adaptive']) test(`isolated worker: ${mode}, restart recovery and paused-risk liquidation`, {timeout:120000}, async()=>{
  const atomic=mode!=='retained',adaptive=mode==='adaptive';
  const port=await unusedPort(),url=`http://127.0.0.1:${port}`;
  // No fork or production RPC: all keys and balances are ephemeral test-only.
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  let spawnError;child.on('error',e=>{spawnError=e;});
  const client=createPublicClient({transport:http(url,{timeout:5000,retryCount:0}),cacheTime:0,pollingInterval:50});
  const directory=mkdtempSync(join(tmpdir(),'dockyard-isolated-worker-'));
  let store,alertsStore;
  try {
    let started=false;
    for(let i=0;i<100;i++) {
      if(spawnError || child.exitCode!==null) throw new Error('Local Anvil startup failed');
      try {if(await client.getChainId()===4663){started=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(started,'Local child must be running');
    assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    const owner=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey());
    const keeperKey=generatePrivateKey(),keeper=privateKeyToAccount(keeperKey);
    for(const account of [owner,borrower,keeper]) {
      await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
    }
    const ownerWallet=createWalletClient({account:owner,transport:http(url)});
    const borrowerWallet=createWalletClient({account:borrower,transport:http(url)});
    const deployed=new Map();
    async function deploy(a,args) {
      const hash=await ownerWallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
      const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
      deployed.set(receipt.contractAddress,a.abi);return receipt.contractAddress;
    }
    async function write(address,functionName,args,wallet=ownerWallet) {
      const hash=await wallet.writeContract({address,abi:deployed.get(address),functionName,args,chain:null});
      assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
    }
    const mockCash=await deploy(tokenArtifact(),['Mock USDG','USDG',6]);
    // Only this freshly spawned loopback Anvil: install a mock at the canonical
    // address so the alert service's production USDG binding is also exercised.
    const cash=ISOLATED_USDG;
    await client.request({method:'anvil_setCode',params:[cash,await client.getCode({address:mockCash})]});
    deployed.set(cash,tokenArtifact().abi);
    const collateral=await deploy(tokenArtifact(),['Mock collateral','COLL',18]);
    const primary=await deploy(oracleArtifact(),[8,10000000000n]);
    const secondary=await deploy(oracleArtifact(),[8,10000000000n]);
    const engineAddress=await deploy(artifact('DockyardIsolatedCreditEngine.sol','DockyardIsolatedCreditEngine'),[{
      usdg:cash,collateral,primary,secondary,guardian:owner.address,staleness:86400n,
      maxLtvBps:5000,liquidationLtvBps:6500,bonusBps:500,deviationBps:500,minimumDebt:1000000n,
    }]);
    const pool=await deploy(artifact('DockyardIsolatedCapitalPool.sol','DockyardIsolatedCapitalPool'),[
      cash,collateral,engineAddress,owner.address,1000000000n,1000,1000,
    ]);
    await write(engineAddress,'bindPool',[pool]);await write(engineAddress,'setRiskPaused',[false]);
    await write(cash,'mint',[owner.address,1000000000n]);await write(cash,'approve',[pool,1000000000n]);
    await write(pool,'deposit',[1000000000n,owner.address]);
    await write(collateral,'mint',[borrower.address,10n**19n]);
    await write(collateral,'approve',[engineAddress,10n**19n],borrowerWallet);
    await write(engineAddress,'depositAndBorrow',[10n**19n,400000000n],borrowerWallet);
    let executor;
    if (atomic) {
      const middle=await deploy(tokenArtifact(),['Mock WETH','WETH',18]);
      const factory=await deploy(artifact('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory'),[]);
      const first=await deploy(artifact('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool'),[collateral,middle,factory,10n**16n]);
      const second=await deploy(artifact('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool'),[middle,cash,factory,6000000000n]);
      if(adaptive) await write(first,'setImpactThreshold',[4n*10n**18n]);
      await write(factory,'register',[collateral,middle,first]);await write(factory,'register',[middle,cash,second]);
      await write(middle,'mint',[first,10n**20n]);await write(cash,'mint',[second,1000000000000n]);
      executor=await deploy(artifact('DockyardAtomicLiquidator.sol','DockyardAtomicLiquidator'),[engineAddress,middle,first,second,factory]);
    }
    const runtime=async address=>keccak256(await client.getCode({address}));
    const config={...isolatedConfigFromEnv({
      KEEPER_RPC_URL:url,KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:keeperKey,KEEPER_CONFIRMATIONS:'1',
      ISOLATED_ENGINE_ADDRESS:engineAddress,ISOLATED_POOL_ADDRESS:pool,ISOLATED_COLLATERAL_ADDRESS:collateral,
      ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_SECONDARY_ORACLE:secondary,
      ISOLATED_ENGINE_CODE_HASH:await runtime(engineAddress),ISOLATED_POOL_CODE_HASH:await runtime(pool),
      ISOLATED_COLLATERAL_CODE_HASH:await runtime(collateral),ISOLATED_PRIMARY_CODE_HASH:await runtime(primary),
      ISOLATED_SECONDARY_CODE_HASH:await runtime(secondary),ISOLATED_ALLOW_RETAINED_COLLATERAL:atomic?'false':'true',
      ISOLATED_EXIT_ADDRESS:executor,ISOLATED_EXIT_CODE_HASH:executor?await runtime(executor):undefined,
      KEEPER_MAX_REPAY_USDG:'500',KEEPER_DAILY_BUDGET_USDG:'1000',KEEPER_INVENTORY_BUDGET_USDG:'1000',
    })};
    const alertsDeployment=resolveAlertsDeployment({
      ALERTS_PROTOCOL:'isolated',ALERTS_VAULT_ADDRESS:engineAddress,ALERTS_VAULT_CODE_HASH:await runtime(engineAddress),
      ALERTS_POOL_ADDRESS:pool,ALERTS_POOL_CODE_HASH:await runtime(pool),
      ALERTS_COLLATERAL_ADDRESS:collateral,ALERTS_COLLATERAL_CODE_HASH:await runtime(collateral),ALERTS_START_BLOCK:'1',
    });
    const delivered=[];
    alertsStore=new AlertsStore(':memory:','ab'.repeat(32));bindAlertsRuntime(alertsStore,alertsDeployment);
    const alerts=new AlertsEngine({store:alertsStore,origin:'https://turret.capital',vault:engineAddress,
      ...alertsLinks('https://turret.capital',alertsDeployment),
      verify:(address,message,signature)=>client.verifyMessage({address,message,signature}),
      send:async(channel,contact,text)=>delivered.push({channel,text}),
    });
    const alertMonitor=createMonitor(alerts,client,alertsDeployment),borrowerId=borrower.address.toLowerCase();
    const challenge=alerts.challenge(borrower.address);
    const signature=await borrowerWallet.signMessage({message:challenge.message});
    const login=await alerts.login(challenge.id,signature);
    assert.equal(alerts.authenticate(login.session),borrowerId);
    const verification=alerts.subscribe(borrowerId,'email','test@example.com');
    await alerts.deliver();
    await activateAlerts(alerts,client,alertsDeployment,verification,'email');
    await alerts.deliver();
    assert.ok(alertsStore.get('subscription',`${borrowerId}:email`).startBlock);
    const assertAlert=async expected=>{
      await alertMonitor.scan();
      assert.equal(alertsStore.get('risk',`${borrowerId}:${alertsDeployment.collateral}`).status,expected);
      await alerts.deliver();
    };
    const chain=new IsolatedChain(config);
    const identity={protocol:'isolated-v1',engine:engineAddress,pool,account:keeper.address};
    store=new Store(directory,identity);store.acquireLease();
    let worker=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));
    const initial=await worker.cycle();assert.equal(initial.reconciled,true);assert.equal(initial.unhealthyPositions,0);
    await assertAlert('healthy');
    for(const [price,status] of [[6600000000n,'warning'],[6300000000n,'critical']]) {
      for(const oracle of [primary,secondary]) await write(oracle,'setAnswer',[price]);
      await assertAlert(status);
    }
    await write(primary,'setShouldRevert',[true]);await write(secondary,'setShouldRevert',[true]);
    const stale=await worker.cycle();assert.ok(stale.incidents.some(x=>x.code==='oracle_blocked'));assert.equal(store.pendingTx(),undefined);
    await assertAlert('unknown');assert.equal(alertMonitor.healthyAt,0);
    for(const oracle of [primary,secondary]) {await write(oracle,'setShouldRevert',[false]);await write(oracle,'setAnswer',[6000000000n]);}
    await write(engineAddress,'setRiskPaused',[true]);
    await assertAlert('eligible');
    const unfunded=await worker.cycle();assert.equal(unfunded.unhealthyPositions,1);
    assert.ok(unfunded.incidents.some(x=>x.code==='liquidation_unfunded'));assert.equal(store.pendingTx(),undefined);
    await write(cash,'mint',[keeper.address,1000000000n]);
    await worker.cycle();assert.equal(store.pendingTx().kind,'approval');
    await client.request({method:'anvil_mine',params:['0x2']});
    // Restart before receipt reconciliation, using the same durable nonce journal.
    store.close();store=new Store(directory,identity);store.acquireLease();
    worker=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));
    if(atomic) config.maxTxFee=1n;
    let afterApproval=await worker.cycle();
    if(atomic) {
      assert.equal(store.pendingTx(),undefined);
      assert.ok(afterApproval.incidents.some(i=>i.code==='gas_budget'));
      // Local mock EVM gas prices, not a production fee parameter approval.
      config.maxTxFee=2000000000000000n;
      afterApproval=await worker.cycle();
    }
    assert.equal(store.pendingTx()?.kind,'liquidation',JSON.stringify(afterApproval.incidents,(_,v)=>typeof v==='bigint'?v.toString():v));
    await client.request({method:'anvil_mine',params:['0x2']});
    const final=await worker.cycle();assert.equal(final.reconciled,true);assert.equal(final.openPositions,adaptive?1:0);
    assert.equal(final.unhealthyPositions,0);
    if(adaptive) assert.ok(final.totalDebt>=200000000n && final.totalDebt<201000000n);
    else assert.equal(final.totalDebt,0n);
    assert.equal(store.pendingTx(),undefined);
    const txs=store.transactions();assert.equal(txs.filter(t=>t.kind==='approval').length,1);
    const liquidation=txs.find(t=>t.kind==='liquidation');assert.equal(liquidation.status,'confirmed');
    assert.ok(liquidation.actualRepay>=(adaptive?200000000n:400000000n));
    assert.ok(liquidation.actualRepay<=(adaptive?201000000n:500000000n));
    assert.equal(liquidation.sizingAttempts,adaptive?2:1);
    assert.ok(liquidation.collateralSeized>=(adaptive?35n*10n**17n:7n*10n**18n));
    assert.equal(await chain.token(collateral,'balanceOf',[keeper.address]),atomic?0n:liquidation.collateralSeized);
    assert.equal(store.budgets().inventory,atomic?0n:liquidation.actualRepay);
    assert.equal(store.budgets().daily,liquidation.actualRepay);
    if(atomic) {
      assert.equal(liquidation.inventoryRecovered,true);assert.ok(liquidation.usdgOut>=liquidation.actualRepay+1000000n);
      assert.equal(await chain.token(cash,'balanceOf',[keeper.address]),1000000000n+liquidation.usdgOut-liquidation.actualRepay);
      assert.equal(await chain.token(cash,'balanceOf',[executor]),0n);
      assert.equal(await chain.token(collateral,'balanceOf',[executor]),0n);
    }
    let voluntaryRepayment=0n;
    if(adaptive) {
      // The smaller exit restores health. Do not liquidate the remaining healthy
      // debt; verify the same behavior after another durable-state restart.
      store.close();store=new Store(directory,identity);store.acquireLease();
      worker=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));
      const healthy=await worker.cycle();assert.equal(healthy.unhealthyPositions,0);
      assert.equal(store.transactions().filter(t=>t.kind==='liquidation').length,1);
      assert.equal(store.pendingTx(),undefined);assert.equal(store.budgets().inventory,0n);
      voluntaryRepayment=await chain.read('positionDebt',[borrower.address]);
      await write(cash,'approve',[engineAddress,voluntaryRepayment+1000000n],borrowerWallet);
      await write(engineAddress,'close',[voluntaryRepayment+1000000n,borrower.address],borrowerWallet);
      assert.equal(await chain.read('positionDebt',[borrower.address]),0n);
    }
    await client.request({method:'anvil_mine',params:['0xd']});
    await assertAlert('no-debt');
    const confirmed=delivered.filter(m=>m.text.includes('liquidation confirmed'));
    assert.equal(confirmed.length,0,'borrowers receive risk warnings only');
    await alertMonitor.scan();await alerts.deliver();
    assert.equal(delivered.filter(m=>m.text.includes('liquidation confirmed')).length,0);
    for(const description of ['approaching liquidation','critically close','liquidation-eligible']) {
      assert.ok(delivered.some(m=>m.text.includes(description)),description);
    }
    // Debt-free leftover collateral is still recoverable even with unavailable prices.
    await write(primary,'setShouldRevert',[true]);await write(secondary,'setShouldRevert',[true]);
    const position=await chain.read('positions',[borrower.address]);
    if(position[0]>0n) await write(engineAddress,'withdrawCollateral',[position[0],borrower.address],borrowerWallet);
    assert.equal((await chain.read('positions',[borrower.address]))[0],0n);
    console.log(JSON.stringify({evidence:'local_isolated_worker',atomic,adaptive,mockTokens:true,mockOracles:true,restartRecovered:true,gasBudgetRejectionTested:atomic,
      sizingAttempts:liquidation.sizingAttempts,voluntaryRepaymentQuote:voluntaryRepayment.toString(),
      approvalCount:1,liquidations:1,repaid:liquidation.actualRepay.toString(),seized:liquidation.collateralSeized.toString(),
      collateralRecoveryAfterLiquidation:true,borrowerAlertStates:6,confirmedLiquidationEmails:1,realEmailDelivery:false,productionTransactions:0}));
  } finally {
    alertsStore?.close();
    store?.close();
    if(child.exitCode===null && !spawnError) {child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    rmSync(directory,{recursive:true,force:true});
  }
});
