import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as reserveServer} from 'node:net';
import {readFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {backup} from 'node:sqlite';
import {createPublicClient,createWalletClient,http,parseAbi,keccak256,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {isolatedConfigFromEnv} from '../src/isolated/config.mjs';
import {IsolatedChain} from '../src/isolated/chain.mjs';
import {IsolatedEngine} from '../src/isolated/engine.mjs';
import {IsolatedTransactions} from '../src/isolated/transactions.mjs';
import {Store} from '../src/store.mjs';
import {roundHash} from '../../risk-monitor/src/policy.mjs';
import {makeStockProof} from '../../risk-monitor/src/stock-policy.mjs';
import {makeLivenessProof} from '../../risk-monitor/src/liveness.mjs';
import {exerciseDaemonRecovery} from './stock-daemon-recovery.mjs';

const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
const WETH='0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',cashVenue='0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca';
const erc20=parseAbi(['function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)',
 'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function deposit() payable']);
const feedAbi=parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)','function decimals() view returns(uint8)']);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function unusedPort(){const s=reserveServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

const daemon=process.env.CANARY_REAL_DAEMON==='1';
for(const loan of daemon?[1000000n]:[1000000n,50000000n])test(`real AAPL pool: ${loan/1000000n} USDG worker survives ${daemon?'SIGKILL and real lease expiry':'ambiguous broadcasts and online-backup restoration'}`,{timeout:daemon?420000:240000},async t=>{
 const upstream=new URL(process.env.STOCK_EARN_FORK_RPC_URL);
 assert.equal(upstream.hostname,'127.0.0.1','Use the read-only proxy runner, not a credential-bearing upstream');
 const forkBlock=process.env.STOCK_EARN_FORK_BLOCK;assert.match(forkBlock??'',/^[1-9][0-9]*$/);
 const m=JSON.parse(process.env.STOCK_CANARY_MANIFEST_JSON);
 const cash=m.riskMonitorCandidate.usdg,collateral=m.frontendCandidate.collateral;
 const port=await unusedPort(),url=`http://127.0.0.1:${port}`;
 const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--fork-url',upstream.href,'--fork-block-number',forkBlock,
  '--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 const directory=mkdtempSync(join(tmpdir(),'dockyard-stock-real-worker-'));
 const originalNow=Date.now;let offset=0,store,server,spawnError;
 child.on('error',e=>{spawnError=e;});
 t.after(async()=>{
  Date.now=originalNow;store?.close();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(child.exitCode===null&&!spawnError){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
  rmSync(directory,{recursive:true,force:true});
 });
 const client=createPublicClient({transport:http(url,{timeout:20000,retryCount:0}),cacheTime:0,pollingInterval:25});
 for(let i=0;i<100;i++){assert.equal(spawnError,undefined);assert.equal(child.exitCode,null);
  try{if(await client.getChainId()===4663)break;}catch{}await pause(100);}
 assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
 assert.equal(await client.getBlockNumber(),BigInt(forkBlock));
 for(const [address,hash]of [[cash,m.hashes.usdg],[collateral,m.hashes.collateral],[m.addresses.engine,m.hashes.engine],
  [m.addresses.pool,m.hashes.pool],[m.directExit.salePool,m.directExit.poolCodeHash],[m.directExit.factory,m.directExit.factoryCodeHash]]){
  assert.equal(keccak256(await client.getCode({address})),hash);
 }
 const owner=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey()),guardian=privateKeyToAccount(generatePrivateKey());
 const keeperKey=generatePrivateKey(),keeper=privateKeyToAccount(keeperKey);
 for(const a of [owner,borrower,keeper])await client.request({method:'anvil_setBalance',params:[a.address,toHex(10n**19n)]});
 const wallet=createWalletClient({account:owner,transport:http(url)}),borrowerWallet=createWalletClient({account:borrower,transport:http(url)});
 const abis=new Map([[WETH,erc20],[cash,erc20],[collateral,erc20],
  [m.addresses.engine,artifact('DockyardStockCreditEngine.sol','DockyardStockCreditEngine').abi],
  [m.addresses.pool,artifact('DockyardStockCapitalPool.sol','DockyardStockCapitalPool').abi],
  [m.frontendCandidate.primary,feedAbi],[m.riskMonitorCandidate.usdgPrimary,feedAbi],[m.riskMonitorCandidate.usdgSecondary,feedAbi]]);
 const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
 const write=async(address,functionName,args=[],sender=wallet,value)=>{
  const request={address,abi:abis.get(address),functionName,args,account:sender.account,chain:null,value,gas:5000000n};
  await client.simulateContract(request);
  const receipt=await client.waitForTransactionReceipt({hash:await sender.writeContract(request)});assert.equal(receipt.status,'success');return receipt;
 };
 const deploy=async(file,name,args=[])=>{const a=artifact(file,name);
  const receipt=await client.waitForTransactionReceipt({hash:await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null})});
  assert.equal(receipt.status,'success');abis.set(receipt.contractAddress,a.abi);return receipt.contractAddress;
 };
	 const liveAvailableCash=await read(m.addresses.pool,'availableCash');
	 assert.ok(liveAvailableCash>=loan,'Pinned production pool must cover the simulated loan size');
	 assert.equal(await read(m.addresses.pool,'outstandingPrincipal'),0n);
	 const liveRiskPaused=await read(m.addresses.engine,'riskPaused');
	 assert.equal(typeof liveRiskPaused,'boolean');
 // Synthetic native ETH only. All USDG and stock inventory comes from actual
 // local-fork swaps: no token mint, balance-slot patch, or holder impersonation.
 const helper=await deploy('DockyardForkSwapHarness.sol','DockyardForkSwapHarness');
 const swap=async(input,venue,amount)=>{await write(input,'approve',[helper,amount]);await write(helper,'swap',[input,venue,amount]);};
 const ethQuote=await read(helper,'spot',[cashVenue,WETH,10n**18n]);assert.ok(ethQuote>0n);
 const wrapped=(1000000000n*10n**18n/ethQuote)*110n/100n+1n;assert.ok(wrapped<5n*10n**18n);
 await write(WETH,'deposit',[],wallet,wrapped);await swap(WETH,cashVenue,wrapped);
 assert.ok(await read(cash,'balanceOf',[owner.address])>1000000000n);
 const actualStock=await read(m.frontendCandidate.primary,'latestRoundData');
 assert.equal(await read(m.frontendCandidate.primary,'decimals'),8);assert.ok(actualStock[1]>0n);
 const posted=loan*10n**12n*2n*10n**8n/actualStock[1];
 await swap(cash,m.directExit.salePool,loan*3n);
 assert.ok(await read(collateral,'balanceOf',[owner.address])>=posted);
 const primary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,actualStock[1]*2n]);
 const usdSources=[];
 for(const source of [m.riskMonitorCandidate.usdgPrimary,m.riskMonitorCandidate.usdgSecondary]){
  const round=await read(source,'latestRoundData');usdSources.push(await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[await read(source,'decimals'),round[1]]));
 }
 const liveRead=name=>read(m.addresses.engine,name),poolRead=name=>read(m.addresses.pool,name);
 const staleness=await liveRead('staleness');
 const guard=await deploy('DockyardHeartbeatGuard.sol','DockyardHeartbeatGuard',[collateral,primary,guardian.address,staleness]);
 const gate=await deploy('DockyardExecutionGate.sol','DockyardExecutionGate',[guardian.address]);
 const healthySince=Number((await client.getBlock()).timestamp);
 const engine=await deploy('DockyardStockCreditEngine.sol','DockyardStockCreditEngine',[
  {usdg:cash,collateral,primary,secondary:guard,guardian:owner.address,staleness,maxLtvBps:await liveRead('maxLtvBps'),
   liquidationLtvBps:await liveRead('liquidationLtvBps'),bonusBps:await liveRead('bonusBps'),deviationBps:await liveRead('deviationBps'),minimumDebt:await liveRead('minimumDebt')},
  gate,{primary:usdSources[0],secondary:usdSources[1],primaryMaxAge:await liveRead('usdgPrimaryMaxAge'),secondaryMaxAge:await liveRead('usdgSecondaryMaxAge'),
   maxDeviationBps:await liveRead('usdgMaxDeviationBps'),maxTimestampSkew:await liveRead('usdgMaxTimestampSkew')}]);
 const pool=await deploy('DockyardStockCapitalPool.sol','DockyardStockCapitalPool',[cash,collateral,engine,owner.address,await poolRead('debtLimit'),await poolRead('revenueFeeBps'),await poolRead('borrowAprBps')]);
 await write(engine,'bindPool',[pool]);await write(cash,'approve',[pool,250000000n]);await write(pool,'deposit',[250000000n,owner.address]);
 await write(cash,'transfer',[keeper.address,300000000n]);await write(collateral,'transfer',[borrower.address,posted]);
 await client.request({method:'evm_increaseTime',params:[120]});await client.request({method:'evm_mine',params:[]});
 const syncClock=async()=>{offset=Number((await client.getBlock()).timestamp)*1000-originalNow();};
 Date.now=()=>originalNow()+offset;await syncClock();
 const live=async()=>makeLivenessProof(guardian,gate,{ok:true,healthySince,observedAt:Number((await client.getBlock()).timestamp)},await read(gate,'epoch'));
 await write(gate,'submitLiveness',[(await live()).encoded]);await write(engine,'setRiskPaused',[false]);
 const now=Number((await client.getBlock()).timestamp),[price,time,round]=await read(guard,'currentData');
 const health=await makeStockProof(guardian,engine,guard,{ok:true,roundId:round,roundHash:roundHash(round,price,time),sourceTime:now,sessionOpen:now-120,sessionClose:now+3600},{epoch:0n,recoveryAt:0n},now);
 await write(collateral,'approve',[engine,posted],borrowerWallet);
 await write(engine,'depositAndBorrowChecked',[posted,loan,health.encoded,(await live()).encoded],borrowerWallet);
 const executor=await deploy('DockyardStockDirectLiquidator.sol','DockyardStockDirectLiquidator',[engine,m.directExit.salePool,m.directExit.factory]);
 let proofAvailable=true,dropNextBroadcast=false,broadcasts=0,ambiguousResponses=0,webhookAlerts=0;
 server=createServer(async(req,res)=>{
  try{
   if(req.url==='/alerts'){for await(const _chunk of req){}webhookAlerts++;res.end('{}');return;}
   if(req.url==='/liveness'){
    if(!proofAvailable){res.writeHead(503);res.end('{}');return;}
    res.end(JSON.stringify({chainId:4663,vault:engine,executionGate:gate,...await live()}));return;
   }
   let body='';for await(const chunk of req)body+=chunk;
   const input=JSON.parse(body);
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body});
   const result=await response.text();
   if(input.method==='eth_sendRawTransaction'){
    broadcasts++;
    if(dropNextBroadcast){dropNextBroadcast=false;ambiguousResponses++;res.writeHead(503);res.end('{}');return;}
   }
   res.end(result);
  }catch{res.writeHead(503);res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const gateway=`http://127.0.0.1:${server.address().port}`;
 const runtime=async address=>keccak256(await client.getCode({address}));
 const fixtureEnv={KEEPER_RPC_URL:gateway,KEEPER_FALLBACK_RPC_URLS:url,KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:keeperKey,KEEPER_CONFIRMATIONS:'12',
  KEEPER_ALERT_WEBHOOK_URL:`${gateway}/alerts`,ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:engine,ISOLATED_ENGINE_CODE_HASH:await runtime(engine),
  ISOLATED_POOL_ADDRESS:pool,ISOLATED_POOL_CODE_HASH:await runtime(pool),ISOLATED_COLLATERAL_ADDRESS:collateral,ISOLATED_COLLATERAL_CODE_HASH:m.hashes.collateral,
  ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_PRIMARY_CODE_HASH:await runtime(primary),ISOLATED_SECONDARY_ORACLE:guard,ISOLATED_SECONDARY_CODE_HASH:await runtime(guard),
  STOCK_GUARDIAN_ADDRESS:guardian.address,KEEPER_EXECUTION_GATE:gate,STOCK_EXECUTION_GATE_CODE_HASH:await runtime(gate),STOCK_USDG_CODE_HASH:m.hashes.usdg,
  STOCK_USDG_PRIMARY_ORACLE:usdSources[0],STOCK_USDG_PRIMARY_CODE_HASH:await runtime(usdSources[0]),STOCK_USDG_SECONDARY_ORACLE:usdSources[1],STOCK_USDG_SECONDARY_CODE_HASH:await runtime(usdSources[1]),
  KEEPER_LIVENESS_URL:`${gateway}/liveness`,ISOLATED_EXIT_ADDRESS:executor,ISOLATED_EXIT_CODE_HASH:await runtime(executor),
  ISOLATED_MIN_PROFIT_USDG:process.env.CANARY_FORK_MIN_PROFIT_OVERRIDE?'1':'0.000001',ISOLATED_MIN_PROFIT_BPS:process.env.CANARY_FORK_MIN_PROFIT_OVERRIDE?'0':'50',
  KEEPER_MAX_REPAY_USDG:'55',KEEPER_DAILY_BUDGET_USDG:'100',KEEPER_INVENTORY_BUDGET_USDG:'100',KEEPER_MAX_TX_FEE_ETH:'0.002'};
 const config=isolatedConfigFromEnv(fixtureEnv);let sale;
 if(daemon){
  await write(primary,'setAnswer',[actualStock[1]]);await write(engine,'setRiskPaused',[true]);await syncClock();
  sale=await exerciseDaemonRecovery({env:fixtureEnv,directory,clockOffset:offset,client,executor,borrower:borrower.address,keeper:keeper.address,
   setProof:value=>{proofAvailable=value;},setDrop:value=>{dropNextBroadcast=value;},broadcastCount:()=>broadcasts,alertCount:()=>webhookAlerts});
 }else{
 const chain=new IsolatedChain(config),identity={protocol:'stock-real-pool-worker',engine,pool,account:keeper.address};
 store=new Store(join(directory,'original'),identity);store.acquireLease();let worker;
 const restart=()=>{worker=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));};restart();
 const cycle=async()=>{await syncClock();store.renewLease();return worker.cycle();};
 assert.equal((await cycle()).unhealthyPositions,0);
 await write(primary,'setAnswer',[actualStock[1]]);await write(engine,'setRiskPaused',[true]);
 proofAvailable=false;const unavailable=await cycle();
 assert.ok(unavailable.incidents.some(i=>i.code==='execution_liveness_unavailable'));assert.equal(store.pendingTx(),undefined);assert.equal(broadcasts,0);
 const restoreBackup=async name=>{
  const pending=store.pendingTx();assert.ok(pending);
  const path=join(directory,name);mkdirSync(path);await backup(store.db,join(path,'keeper.sqlite'));
  store.close();store=new Store(path,identity);
  assert.throws(()=>store.acquireLease(),/Another keeper owns this volume/);
  // Model expiry of the copied process lease; no real service lease is touched.
  store.acquireLease(Date.now()+121000);assert.deepEqual(store.pendingTx(),pending);restart();
 };
 proofAvailable=true;dropNextBroadcast=true;const uncertainApproval=await cycle();
 assert.ok(uncertainApproval.incidents.some(i=>i.code==='broadcast_uncertain'));
 assert.equal(store.pendingTx()?.kind,'approval');await restoreBackup('restored-approval');
 await client.request({method:'anvil_mine',params:['0xd']});proofAvailable=false;await cycle();
 assert.equal(store.pendingTx(),undefined,'Approval reconciles from backup while proofs are unavailable');
 proofAvailable=true;dropNextBroadcast=true;const uncertainSale=await cycle();
 assert.equal(store.pendingTx()?.kind,'liquidation',JSON.stringify(uncertainSale.incidents,(_,v)=>typeof v==='bigint'?v.toString():v));
 assert.ok(uncertainSale.incidents.some(i=>i.code==='broadcast_uncertain'));await restoreBackup('restored-liquidation');
 await client.request({method:'anvil_mine',params:['0xd']});proofAvailable=false;await cycle();
 assert.equal(store.pendingTx(),undefined);const txs=store.transactions(),sales=txs.filter(x=>x.kind==='liquidation');
 assert.equal(sales.length,1);sale=sales[0];assert.equal(sale.status,'confirmed');assert.equal(sale.inventoryRecovered,true);
 assert.equal(store.budgets().inventory,0n);assert.equal(store.budgets().daily,sale.actualRepay);
 }
 assert.ok(sale.actualRepay>=loan&&sale.actualRepay<=loan+1000n,'Bounded elapsed fixture interest must be fully repaid');
 assert.ok(sale.usdgOut>=sale.actualRepay+sale.minProfit);
 assert.equal(await read(cash,'balanceOf',[keeper.address]),300000000n+sale.usdgOut-sale.actualRepay);
 assert.equal(ambiguousResponses,2);assert.equal(broadcasts,2,'No duplicate submission after restored receipts');
 assert.equal(await client.getTransactionCount({address:keeper.address}),2);
 for(const token of [cash,collateral])assert.equal(await read(token,'balanceOf',[executor]),0n);
 assert.equal(await read(cash,'allowance',[executor,engine]),0n);
 assert.equal(await read(engine,'positionDebt',[borrower.address]),0n);assert.equal(await read(pool,'outstandingPrincipal'),0n);
 for(const feed of [primary,...usdSources])await write(feed,'setShouldRevert',[true]);
 const remaining=(await read(engine,'positions',[borrower.address]))[0];
 await write(engine,'withdrawCollateral',[remaining,borrower.address],borrowerWallet);
 assert.equal(await read(collateral,'balanceOf',[borrower.address]),posted-sale.collateralSeized);
 const shares=await read(pool,'balanceOf',[owner.address]),before=await read(cash,'balanceOf',[owner.address]);
 await write(pool,'redeem',[shares,owner.address,owner.address]);
 const withdrawn=(await read(cash,'balanceOf',[owner.address]))-before;assert.ok(withdrawn>=250000000n);
 assert.equal(await read(pool,'cumulativeLoss'),0n);
 console.log(JSON.stringify({evidence:'real-aapl-pool-worker',forkBlock,loan:String(loan),paid:String(sale.actualRepay),saleOutput:String(sale.usdgOut),
	  grossReturnBeforeGas:String(sale.usdgOut-sale.actualRepay),lenderWithdrawal:String(withdrawn),liveAvailableCash:String(liveAvailableCash),liveRiskPaused,durableApprovalAndLiquidation:true,ambiguousBroadcasts:2,
  onlineBackupRestores:daemon?0:2,hardProcessKills:daemon?2:0,copiedLiveLeaseProtected:!daemon,immediateProcessTakeoverRejected:daemon,
  leaseExpiryWaitSimulated:!daemon,realWallClockLeaseWait:daemon,receiptRecoveryDuringProofOutage:true,duplicateBroadcasts:0,
  actualDaemonEntrypoint:daemon,localOperatorWebhookReceived:daemon?webhookAlerts:null,
  actualWorkerImplementation:true,independentProductionRpcProvidersTested:false,syntheticOracleHistory:true,syntheticEthFunding:true,
  realTokenAcquisitionSwaps:true,productionTransactions:0,productionKeyUsed:false}));
});
