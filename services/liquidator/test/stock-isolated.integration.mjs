import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicClient,createWalletClient,http,keccak256,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {isolatedConfigFromEnv} from '../src/isolated/config.mjs';
import {IsolatedChain} from '../src/isolated/chain.mjs';
import {IsolatedEngine} from '../src/isolated/engine.mjs';
import {IsolatedTransactions} from '../src/isolated/transactions.mjs';
import {Store} from '../src/store.mjs';
import {roundHash} from '../../risk-monitor/src/policy.mjs';
import {makeStockProof} from '../../risk-monitor/src/stock-policy.mjs';
import {makeLivenessProof} from '../../risk-monitor/src/liveness.mjs';
import {Store as AlertStore} from '../../borrower-alerts/src/store.mjs';
import {Engine as AlertEngine} from '../../borrower-alerts/src/engine.mjs';
import {IsolatedMonitor as AlertMonitor} from '../../borrower-alerts/src/isolated-monitor.mjs';

const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
for(const route of ['retained','two-hop','direct','direct-small'])test(`guarded stock worker: ${route}, outage and restart`,{timeout:120000},async()=>{
  const atomic=route!=='retained';
  const small=route==='direct-small',loanAmount=small?1000000n:400000000n,depositAmount=small?25000000000000000n:10n**19n;
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  const url=`http://127.0.0.1:${port}`,client=createPublicClient({transport:http(url,{timeout:5000,retryCount:0}),cacheTime:0,pollingInterval:25});
  const directory=mkdtempSync(join(tmpdir(),'dockyard-stock-worker-'));let store,alertStore,spawnError;
  child.on('error',error=>{spawnError=error;});
  try{
    let started=false;
    for(let i=0;i<100;i++){
      if(spawnError||child.exitCode!==null)throw new Error('Local Anvil unavailable');
      try{if(await client.getChainId()===4663){started=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(started);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
    const owner=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey()),guardian=privateKeyToAccount(generatePrivateKey());
    const keeperKey=generatePrivateKey(),keeper=privateKeyToAccount(keeperKey);
    for(const account of [owner,borrower,keeper])await client.request({method:'anvil_setBalance',params:[account.address,toHex(10n**19n)]});
    const wallet=createWalletClient({account:owner,transport:http(url)}),borrowerWallet=createWalletClient({account:borrower,transport:http(url)});
    const deployed=new Map();
    const deploy=async(file,name,args=[])=>{
      const a=artifact(file,name),hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
      const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');
      deployed.set(receipt.contractAddress,a.abi);return receipt.contractAddress;
    };
    const write=async(address,functionName,args=[],sender=wallet)=>{
      const hash=await sender.writeContract({address,abi:deployed.get(address),functionName,args,chain:null});
      assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');
    };
    const read=(address,functionName,args=[])=>client.readContract({address,abi:deployed.get(address),functionName,args});
    const token=(name,decimals)=>deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',[name,name,decimals]);
    const oracle=(decimals,price)=>deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[decimals,price]);
    const mockCash=await token('USDG',6),cash='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    await client.request({method:'anvil_setCode',params:[cash,await client.getCode({address:mockCash})]});deployed.set(cash,deployed.get(mockCash));
    const collateral=await deploy('DockyardOracleV2.t.sol','ScaledStockFixture');
    const primary=await oracle(8,10000000000n),usdA=await oracle(8,100000000n),usdB=await oracle(18,10n**18n);
    const guard=await deploy('DockyardHeartbeatGuard.sol','DockyardHeartbeatGuard',[collateral,primary,guardian.address,86400]);
    const gate=await deploy('DockyardExecutionGate.sol','DockyardExecutionGate',[guardian.address]);
    const healthySince=Number((await client.getBlock()).timestamp);
    const engine=await deploy('DockyardStockCreditEngine.sol','DockyardStockCreditEngine',[
      {usdg:cash,collateral,primary,secondary:guard,guardian:owner.address,staleness:86400n,maxLtvBps:5000,liquidationLtvBps:6500,bonusBps:500,deviationBps:200,minimumDebt:1000000n},
      gate,{primary:usdA,secondary:usdB,primaryMaxAge:300,secondaryMaxAge:300,maxDeviationBps:200,maxTimestampSkew:60}]);
    const pool=await deploy('DockyardStockCapitalPool.sol','DockyardStockCapitalPool',[cash,collateral,engine,owner.address,1000000000n,1000,1000]);
    await write(engine,'bindPool',[pool]);await write(cash,'mint',[owner.address,1000000000n]);await write(cash,'approve',[pool,1000000000n]);
    await write(pool,'deposit',[1000000000n,owner.address]);
    await client.request({method:'evm_increaseTime',params:[120]});await client.request({method:'evm_mine',params:[]});
    const live=async()=>makeLivenessProof(guardian,gate,{ok:true,healthySince,observedAt:Number((await client.getBlock()).timestamp)},await read(gate,'epoch'));
    await write(gate,'submitLiveness',[(await live()).encoded]);await write(engine,'setRiskPaused',[false]);
    const now=Number((await client.getBlock()).timestamp),[value,time,round]=await read(guard,'currentData');
    const health=await makeStockProof(guardian,engine,guard,{ok:true,roundId:round,roundHash:roundHash(round,value,time),sourceTime:now,sessionOpen:now-120,sessionClose:now+3600},{epoch:0n,recoveryAt:0n},now);
    await write(collateral,'mint',[borrower.address,10n**19n]);await write(collateral,'approve',[engine,10n**19n],borrowerWallet);
    await write(engine,'depositAndBorrowChecked',[depositAmount,loanAmount,health.encoded,(await live()).encoded],borrowerWallet);
    let executor;
    if(route.startsWith('direct')){
      const factory=await deploy('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory');
      const direct=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[collateral,cash,factory,60000000n]);
      await write(factory,'register',[collateral,cash,direct]);await write(cash,'mint',[direct,1000000000000n]);
      executor=await deploy('DockyardStockDirectLiquidator.sol','DockyardStockDirectLiquidator',[engine,direct,factory]);
    }else if(atomic){
      const middle=await token('WETH',18),factory=await deploy('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory');
      const first=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[collateral,middle,factory,10n**16n]);
      const second=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[middle,cash,factory,6000000000n]);
      await write(factory,'register',[collateral,middle,first]);await write(factory,'register',[middle,cash,second]);
      await write(middle,'mint',[first,10n**20n]);await write(cash,'mint',[second,1000000000000n]);
      executor=await deploy('DockyardStockAtomicLiquidator.sol','DockyardStockAtomicLiquidator',[engine,middle,first,second,factory]);
    }
    const runtime=async address=>keccak256(await client.getCode({address}));
    const config=isolatedConfigFromEnv({KEEPER_RPC_URL:url,KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:keeperKey,KEEPER_CONFIRMATIONS:'1',
      ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:engine,ISOLATED_POOL_ADDRESS:pool,ISOLATED_COLLATERAL_ADDRESS:collateral,
      ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_SECONDARY_ORACLE:guard,ISOLATED_ENGINE_CODE_HASH:await runtime(engine),ISOLATED_POOL_CODE_HASH:await runtime(pool),
      ISOLATED_COLLATERAL_CODE_HASH:await runtime(collateral),ISOLATED_PRIMARY_CODE_HASH:await runtime(primary),ISOLATED_SECONDARY_CODE_HASH:await runtime(guard),
      KEEPER_EXECUTION_GATE:gate,KEEPER_LIVENESS_URL:'http://127.0.0.1/liveness',STOCK_GUARDIAN_ADDRESS:guardian.address,
      STOCK_USDG_PRIMARY_ORACLE:usdA,STOCK_USDG_SECONDARY_ORACLE:usdB,STOCK_EXECUTION_GATE_CODE_HASH:await runtime(gate),STOCK_USDG_CODE_HASH:await runtime(cash),
      STOCK_USDG_PRIMARY_CODE_HASH:await runtime(usdA),STOCK_USDG_SECONDARY_CODE_HASH:await runtime(usdB),ISOLATED_ALLOW_RETAINED_COLLATERAL:atomic?'false':'true',
      ISOLATED_EXIT_ADDRESS:executor,ISOLATED_EXIT_CODE_HASH:executor?await runtime(executor):undefined,
      ISOLATED_MIN_PROFIT_USDG:small?'0.000001':'1',ISOLATED_MIN_PROFIT_BPS:small?'50':'0',
      KEEPER_MAX_REPAY_USDG:'500',KEEPER_DAILY_BUDGET_USDG:'1000',KEEPER_INVENTORY_BUDGET_USDG:'1000',KEEPER_MAX_TX_FEE_ETH:'0.002'});
    const chain=new IsolatedChain(config);let available=true;
    // Inject only head selection and proof transport for the accelerated local
    // clock. Real contract signatures/bindings, quotes, transactions and receipts
    // are exercised; this does not establish production RPC quorum or health data.
    chain.select=async()=>{chain.consistent=true;chain.probeStatus=[];return client.getBlock();};
    chain.stockLiveness=async()=>{if(!available)throw new Error('proof service unavailable');return (await live()).encoded;};
    let alertNow=Number((await client.getBlock()).timestamp)*1000;
    const emails=[];alertStore=new AlertStore(':memory:','ab'.repeat(32));
    const alertEngine=new AlertEngine({store:alertStore,origin:'http://localhost',vault:engine,verify:async()=>true,
      now:()=>alertNow,send:async(...args)=>emails.push(args)});
    alertStore.put('subscription',`${borrower.address.toLowerCase()}:email`,{wallet:borrower.address.toLowerCase(),channel:'email',
      contact:'local-fixture@example.test',created:0,startBlock:'0',failed:false});
    const alertMonitor=new AlertMonitor(alertEngine,client,{kind:'isolated',vault:engine,codeHash:config.codeHash,pool,poolCodeHash:config.poolCodeHash,
      collateral,collateralCodeHash:config.collateralCodeHash,startBlock:1n,
      stock:{executionGate:gate,executionGateCodeHash:config.stock.executionGateCodeHash,livenessUrl:'http://127.0.0.1/liveness'}},
      async()=>available?new Response(JSON.stringify({chainId:4663,vault:engine,executionGate:gate,...await live()})):new Response('{}',{status:503}));
    const scanAlerts=async()=>{alertNow=Number((await client.getBlock()).timestamp)*1000;await alertMonitor.scan();await alertEngine.deliver();};
    const identity={protocol:'stock-isolated-v1',engine,pool,account:keeper.address};
    store=new Store(directory,identity);store.acquireLease();
    const worker=()=>new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));
    const beforeGate=await read(gate,'liveness');await worker().cycle();assert.deepEqual(await read(gate,'liveness'),beforeGate);
    await write(primary,'setAnswer',[6000000000n]);await write(engine,'setRiskPaused',[true]);
    await client.request({method:'evm_increaseTime',params:[46]});await client.request({method:'evm_mine',params:[]});
    await scanAlerts();assert.equal(alertMonitor.healthyAt,alertNow,'fresh simulated liveness values risk despite expired cached proof');
    assert.equal(alertStore.get('risk',`${borrower.address.toLowerCase()}:${collateral}`).status,'eligible');
    assert.ok(emails.length>0,'eligible stock position queues and delivers a fixture email');
    available=false;
    await scanAlerts();assert.equal(alertMonitor.healthyAt,0);assert.equal(alertStore.get('risk',`${borrower.address.toLowerCase()}:${collateral}`).status,'unknown');
    const outage=await worker().cycle();assert.ok(outage.incidents.some(i=>i.code==='execution_liveness_unavailable'));assert.equal(store.pendingTx(),undefined);
    available=true;
    const unfunded=await worker().cycle();assert.equal(unfunded.unhealthyPositions,1);assert.equal(store.pendingTx(),undefined);
    await write(cash,'mint',[keeper.address,2500000000n]);await worker().cycle();assert.equal(store.pendingTx()?.kind,'approval');
    await client.request({method:'anvil_mine',params:['0x2']});store.close();store=new Store(directory,identity);store.acquireLease();
    available=false;await worker().cycle();assert.equal(store.pendingTx(),undefined,'approval receipt reconciles during proof outage');
    available=true;const next=await worker().cycle();assert.equal(store.pendingTx()?.kind,'liquidation',JSON.stringify(next.incidents));
    await client.request({method:'anvil_mine',params:['0x2']});available=false;
    const final=await worker().cycle();assert.equal(final.totalDebt,0n);assert.equal(store.pendingTx(),undefined);
    await client.request({method:'anvil_mine',params:['0xe']});await scanAlerts();
    assert.equal(emails.filter(row=>row[2].includes('liquidation confirmed')).length,0,'borrower notifications are limited to liquidation risk');
    const tx=store.transactions().find(t=>t.kind==='liquidation');assert.equal(tx.status,'confirmed');assert.ok(tx.actualRepay>=loanAmount);
    if(small){assert.ok(tx.minProfit>=5000n&&tx.minProfit<=5010n);assert.ok(tx.usdgOut>=tx.actualRepay+tx.minProfit);}
    assert.equal(store.transactions().filter(t=>t.kind==='approval').length,1);
    assert.equal(store.budgets().inventory,atomic?0n:tx.actualRepay);
    assert.equal(await read(collateral,'balanceOf',[keeper.address]),atomic?0n:tx.collateralSeized);
    if(atomic)assert.equal(await read(cash,'balanceOf',[keeper.address]),2500000000n+tx.usdgOut-tx.actualRepay);
    const position=await read(engine,'positions',[borrower.address]);
    await write(engine,'withdrawCollateral',[position[0],borrower.address],borrowerWallet);
    const shares=await read(pool,'balanceOf',[owner.address]);await write(pool,'redeem',[shares,owner.address,owner.address]);
    assert.equal(await read(pool,'balanceOf',[owner.address]),0n);assert.equal((await read(engine,'positions',[borrower.address]))[0],0n);
    console.log(JSON.stringify({evidence:'stock-worker-local',atomic,route,productionTransactions:0,mockPrices:true,fixtureProofTransport:true,
      restartRecovered:true,outageReceiptRecovery:true,lenderFullyExited:true,liquidations:1,inventoryRecovered:atomic,
      stockAlertLiveness:true,fixtureEmailDelivery:true,smallLoanPolicy:small}));
  }finally{
    store?.close();alertStore?.close();if(child.exitCode===null&&!spawnError){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
    rmSync(directory,{recursive:true,force:true});
  }
});
