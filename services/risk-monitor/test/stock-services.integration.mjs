import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as reserveServer} from 'node:net';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,toHex,decodeFunctionData,decodeAbiParameters,encodeAbiParameters,parseAbiParameters}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const {tsImport}=createRequire(new URL('../../../frontend/app/package.json',import.meta.url))('tsx/esm/api');
const {prepareIsolatedAction,quoteLenderIntent,readIsolatedMarket}=await tsImport('../../../frontend/app/src/isolated-credit.ts',import.meta.url);
const {fetchStockProofs,stockProofsForAction,readStockWorkspace}=await tsImport('../../../frontend/app/src/isolated-stock-proofs.ts',import.meta.url);
const browserHarness=process.env.DOCKYARD_PLAYWRIGHT_MODULE
 ? await import('../../../frontend/app/scripts/stock-browser/lifecycle.mjs'):null;
const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function unusedPort(){const s=reserveServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

const testSession=process.env.STOCK_TEST_SESSION??'regular';
const dataDelayMs=Number(process.env.STOCK_TEST_DATA_DELAY_MS??0);
if(!Number.isSafeInteger(dataDelayMs)||dataDelayMs<0||dataDelayMs>5000)throw new Error('Invalid fixture data delay');
const sessionStarts={regular:'2026-09-03T15:00:00Z',premarket:'2026-09-03T08:10:00Z',postmarket:'2026-09-03T21:10:00Z',overnight:'2026-09-03T02:10:00Z'};
if(!Object.hasOwn(sessionStarts,testSession))throw new Error('Invalid local test session');
const expectedFeed={regular:'iex',premarket:'sip',postmarket:'sip',overnight:'boats'}[testSession];
test(`stock ${testSession}: frontend transactions, monitor and funded keeper preserve lender and borrower exits through operational faults`,{timeout:320000},async t=>{
 const port=await unusedPort(),riskPort=await unusedPort(),keeperPort=await unusedPort();
 const url=`http://127.0.0.1:${port}`,riskUrl=`http://127.0.0.1:${riskPort}`,keeperUrl=`http://127.0.0.1:${keeperPort}`;
 const start=Math.floor(Date.parse(sessionStarts[testSession])/1000),offset=start*1000-Date.now();
 const children=[],servers=[],directory=mkdtempSync(`${tmpdir()}/dockyard-stock-services-`);
 const startChild=(args,env)=>{const p=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});children.push(p);p.output='';
  for(const stream of [p.stdout,p.stderr])stream.on('data',part=>{p.output=(p.output+part.toString()).slice(-16000);});return p;};
 const anvil=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--timestamp',String(start),'--block-time','1','--silent'],{stdio:'ignore'});
 children.push(anvil);
 t.after(async()=>{
  for(const child of children.reverse())if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
  for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(directory,{recursive:true,force:true});
 });
 const client=createPublicClient({transport:http(url,{timeout:3000,retryCount:0}),pollingInterval:25,cacheTime:0});
 for(let i=0;i<100;i++){try{if(await client.getChainId()===4663)break;}catch{}await pause(50);}
 assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
 const owner=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey());
 const publicLender=privateKeyToAccount(generatePrivateKey());
 const guardianKey=generatePrivateKey(),keeperKey=generatePrivateKey(),guardian=privateKeyToAccount(guardianKey),keeper=privateKeyToAccount(keeperKey);
 for(const a of [owner,borrower,guardian,keeper,publicLender])await client.request({method:'anvil_setBalance',params:[a.address,toHex(10n**19n)]});
 const wallet=createWalletClient({account:owner,transport:http(url)}),borrowerWallet=createWalletClient({account:borrower,transport:http(url)});
 const lenderWallet=createWalletClient({account:publicLender,transport:http(url)});
 const abis=new Map();
 const deploy=async(file,name,args=[])=>{const a=artifact(file,name);const hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
  const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');abis.set(receipt.contractAddress,a.abi);return receipt.contractAddress;};
 const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
 const write=async(address,functionName,args=[],sender=wallet)=>{
  const request={address,abi:abis.get(address),functionName,args,account:sender.account};
  const estimate=await client.estimateContractGas(request),gas=(estimate*125n+99n)/100n+50000n;
  assert.ok(gas<=5000000n);
  // Match the frontend's bounded padding for state/interest writes at the next
  // mined block rather than sending the exact current-block estimate.
  const hash=await sender.writeContract({...request,gas,chain:null});
  const r=await client.waitForTransactionReceipt({hash});
  if(r.status!=='success'){
   const trace=await client.request({method:'debug_traceTransaction',params:[hash,{}]});
   assert.fail(`${functionName} reverted: ${JSON.stringify({gasUsed:String(r.gasUsed),gasLimit:String(gas),returnValue:trace.returnValue,failed:trace.failed})}`);
  }return r;
 };
 const cashFixture=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',['USDG','USDG',6]);
 const cash='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
 await client.request({method:'anvil_setCode',params:[cash,await client.getCode({address:cashFixture})]});abis.set(cash,abis.get(cashFixture));
 const collateral=await deploy('DockyardOracleV2.t.sol','ScaledStockFixture');
 const primary=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,10000000000n]);
 const usdA=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,100000000n]);
 const usdB=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[18,10n**18n]);
 const guard=await deploy('DockyardHeartbeatGuard.sol','DockyardHeartbeatGuard',[collateral,primary,guardian.address,86400]);
 const gate=await deploy('DockyardExecutionGate.sol','DockyardExecutionGate',[guardian.address]);
 const engine=await deploy('DockyardStockCreditEngine.sol','DockyardStockCreditEngine',[
  {usdg:cash,collateral,primary,secondary:guard,guardian:owner.address,staleness:86400n,maxLtvBps:5000,liquidationLtvBps:6500,bonusBps:500,deviationBps:200,minimumDebt:1000000n},
  gate,{primary:usdA,secondary:usdB,primaryMaxAge:3600,secondaryMaxAge:3600,maxDeviationBps:200,maxTimestampSkew:300}]);
 const pool=await deploy('DockyardStockCapitalPool.sol','DockyardStockCapitalPool',[cash,collateral,engine,owner.address,1000000000n,1000,1000]);
 await write(engine,'bindPool',[pool]);await write(cash,'mint',[owner.address,1000000000n]);await write(cash,'approve',[pool,1000000000n]);
 await write(pool,'deposit',[500000000n,owner.address]);await write(cash,'mint',[keeper.address,2000000000n]);
 // Recovery must publish price health only, never a stock-engine admission
 // signature in public calldata while its keeper is still unavailable.
 await write(guard,'trip',[true],createWalletClient({account:guardian,transport:http(url)}));
 const runtime=async address=>keccak256(await client.getCode({address}));
 const manifest={kind:'stock-pool',chainId:4663,status:'receipt-verified',marketDataVerified:true,vault:engine,vaultCodeHash:await runtime(engine),
  tradingSessionPolicy:'equities-24x5',marketDataUseApproved:true,
  pool,poolCodeHash:await runtime(pool),usdg:cash,usdgCodeHash:await runtime(cash),executionGate:gate,executionGateCodeHash:await runtime(gate),
  usdgPrimary:usdA,usdgPrimaryCodeHash:await runtime(usdA),usdgSecondary:usdB,usdgSecondaryCodeHash:await runtime(usdB),
  owner:owner.address,guardian:guardian.address,keeper:keeper.address,startBlock:1,
  markets:[{symbol:'AAPL',collateral,collateralCodeHash:await runtime(collateral),primaryOracle:primary,primaryCodeHash:await runtime(primary),
   adapter:guard,adapterCodeHash:await runtime(guard),maxPriceAgeSeconds:86400,
   sessionDataVerified:{regular:'iex',premarket:'sip',postmarket:'sip',overnight:'boats'}}]};
 const deployment={chainId:4663,engine,pool,collateral,primary,secondary:guard,
  hashes:{engine:manifest.vaultCodeHash,pool:manifest.poolCodeHash,collateral:manifest.markets[0].collateralCodeHash,
   primary:manifest.markets[0].primaryCodeHash,secondary:manifest.markets[0].adapterCodeHash,usdg:manifest.usdgCodeHash},
  stock:{executionGate:gate,usdgPrimary:usdA,usdgSecondary:usdB,riskMonitorUrl:riskUrl,
   hashes:{executionGate:manifest.executionGateCodeHash,usdgPrimary:manifest.usdgPrimaryCodeHash,usdgSecondary:manifest.usdgSecondaryCodeHash}}};
 const frontendClock=()=>Date.now()+offset;
 const browserLifecycle=browserHarness?await browserHarness.startStockBrowser({client,deployment,rpcUrl:url,offset,
  wallets:[borrowerWallet,lenderWallet],playwrightModule:process.env.DOCKYARD_PLAYWRIGHT_MODULE}):null;
 if(browserLifecycle)t.after(()=>browserLifecycle.close());
 // Use the actual frontend action preparation and HTTP proof client. The only
 // signing wallets are generated above and exist solely on this local node.
 async function userAction(sender,intent) {
  if(browserLifecycle)return browserLifecycle.action(sender.account.address,intent);
  const steps=[];
  for(let attempt=0;attempt<4;attempt++) {
   const account=sender.account.address,before=await client.getTransactionCount({address:account});
   const proofs=await stockProofsForAction(client,deployment,account,intent.kind,fetch,frontendClock);
   const step=await prepareIsolatedAction(client,deployment,account,intent,frontendClock,proofs);
   assert.equal(await client.getTransactionCount({address:account}),before,'Frontend preparation must not broadcast');
   if(step.kind==='approval') {
    const approval=decodeFunctionData({abi:abis.get(step.to),data:step.data});
    assert.equal(approval.functionName,'approve');assert.notEqual(approval.args[1],2n**256n-1n);
   }
   const hash=await sender.sendTransaction({to:step.to,data:step.data,value:step.value,gas:step.gas,chain:null});
   assert.equal((await client.waitForTransactionReceipt({hash})).status,'success',`${intent.kind}/${step.kind}`);
   steps.push(step);
   if(step.kind==='transaction')return steps;
  }
  assert.fail('Frontend approval loop did not finish');
 }
 async function lenderQuote(sender,kind,amount) {
  const proofs=await stockProofsForAction(client,deployment,sender.account.address,kind,fetch,frontendClock);
  return quoteLenderIntent(client,deployment,sender.account.address,kind,amount,50,frontendClock,proofs);
 }
 let rpcAvailable=true,wrongKeeper=false,quotesAvailable=true,notificationFailure=false,notifications=0,snapshotInFlight=false;
 const token='stock-service-local-status-'.repeat(3);
 const proxy=createServer(async(req,res)=>{
  try{
   if(req.url.startsWith('/snapshots?')){
    const requested=new URL(req.url,'http://localhost');
    if(requested.searchParams.get('feed')!==expectedFeed){res.writeHead(403);res.end('{}');return;}
    if(!quotesAvailable){res.writeHead(503);res.end('{}');return;}
    // Reproduce real HTTP/RPC latency: return a genuinely fresh quote newer
    // than the chain snapshot that the monitor pinned at the start of its scan.
    if(dataDelayMs){snapshotInFlight=true;await pause(dataDelayMs);snapshotInFlight=false;}
    const head=await client.getBlock(),stamp=new Date(Number(head.timestamp)*1000).toISOString();
    res.end(JSON.stringify({AAPL:{latestTrade:{p:100,t:stamp},latestQuote:{bp:99.99,ap:100.01,t:stamp}}}));return;
   }
   if(req.url==='/webhook'){notifications++;req.resume();res.writeHead(notificationFailure?503:200);res.end('{}');return;}
   if(req.url==='/keeper'){
    const r=await fetch(`${keeperUrl}/status`,{headers:{Authorization:`Bearer ${token}`}});const body=await r.json();
    if(wrongKeeper&&body.snapshot)body.snapshot.pool=engine;
    res.writeHead(r.status);res.end(JSON.stringify(body));return;
   }
   if(!rpcAvailable){res.writeHead(503);res.end('{}');return;}
   let body='';for await(const part of req)body+=part;
   const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});res.end(await r.text());
  }catch{res.writeHead(503);res.end('{}');}
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));servers.push(proxy);const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
 const common={PATH:process.env.PATH,ALCHEMY_RPC_URL:url,KEEPER_FALLBACK_RPC_URLS:proxyUrl,
  STOCK_FIXTURE_CONTROL_URL:proxyUrl,STOCK_FIXTURE_CLOCK_OFFSET_MS:String(offset),KEEPER_RPC_TIMEOUT_MS:'3000'};
 const preload=new URL('./stock-fixture-preload.mjs',import.meta.url).pathname;
 const risk=startChild(['--import',preload,new URL('../src/main.mjs',import.meta.url).pathname],{...common,
  RISK_MODE:'execute',RISK_LIVENESS_MODE:'execute',RISK_GUARDIAN_PRIVATE_KEY:guardianKey,RISK_MANIFEST_JSON:JSON.stringify(manifest),
  RISK_LIVENESS_URL:`${riskUrl}/liveness`,RISK_KEEPER_STATUS_URL:`${proxyUrl}/keeper`,RISK_KEEPER_STATUS_TOKEN:token,
  RISK_STATUS_TOKEN:token,RISK_DATA_DIR:`${directory}/risk`,RISK_APP_ORIGIN:browserLifecycle?.origin??'http://localhost',RISK_ALERT_WEBHOOK_URL:`${proxyUrl}/webhook`,
  ALPACA_API_KEY:'fixture-only',ALPACA_API_SECRET:'fixture-only',PORT:String(riskPort)});
 const keeperProcess=startChild(['--import',preload,new URL('../../liquidator/src/isolated/main.mjs',import.meta.url).pathname],{...common,
  KEEPER_MODE:'execute',KEEPER_PRIVATE_KEY:keeperKey,KEEPER_STATUS_TOKEN:token,KEEPER_DATA_DIR:`${directory}/keeper`,PORT:String(keeperPort),
  KEEPER_EXECUTION_GATE:gate,KEEPER_LIVENESS_URL:`${riskUrl}/liveness`,KEEPER_ALERT_WEBHOOK_URL:`${proxyUrl}/webhook`,
  ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:engine,ISOLATED_ENGINE_CODE_HASH:manifest.vaultCodeHash,
  ISOLATED_POOL_ADDRESS:pool,ISOLATED_POOL_CODE_HASH:manifest.poolCodeHash,ISOLATED_COLLATERAL_ADDRESS:collateral,
  ISOLATED_COLLATERAL_CODE_HASH:manifest.markets[0].collateralCodeHash,ISOLATED_PRIMARY_ORACLE:primary,ISOLATED_PRIMARY_CODE_HASH:manifest.markets[0].primaryCodeHash,
  ISOLATED_SECONDARY_ORACLE:guard,ISOLATED_SECONDARY_CODE_HASH:manifest.markets[0].adapterCodeHash,
  STOCK_GUARDIAN_ADDRESS:guardian.address,STOCK_EXECUTION_GATE_CODE_HASH:manifest.executionGateCodeHash,STOCK_USDG_CODE_HASH:manifest.usdgCodeHash,
  STOCK_USDG_PRIMARY_ORACLE:usdA,STOCK_USDG_PRIMARY_CODE_HASH:manifest.usdgPrimaryCodeHash,STOCK_USDG_SECONDARY_ORACLE:usdB,STOCK_USDG_SECONDARY_CODE_HASH:manifest.usdgSecondaryCodeHash,
  ISOLATED_ALLOW_RETAINED_COLLATERAL:'true',KEEPER_MAX_TX_FEE_ETH:'0.002'});
 const getStatus=async()=>{try{return await (await fetch(`${riskUrl}/status`,{headers:{Authorization:`Bearer ${token}`}})).json();}catch{return null;}};
 async function waitFor(check,ms=16000){const deadline=Date.now()+ms;while(Date.now()<deadline){
  assert.equal(risk.exitCode,null,'Risk process exited');assert.equal(keeperProcess.exitCode,null,'Keeper process exited');
  if(await check())return;await pause(500);
 }assert.fail(`Service condition timed out: ${JSON.stringify(await getStatus())}`);}
 await waitFor(async()=>Boolean((await getStatus())?.lastCycle));
 const endpoint=`${riskUrl}/stock/approvals/${engine}`;
 assert.equal((await fetch(endpoint)).status,503);assert.equal((await fetch(`${riskUrl}/liveness`)).status,503);
 console.log('Stock service integration: both real workers running; observing the required 120-second recovery.');
 await waitFor(async()=> (await fetch(endpoint)).ok,165000);
 if(dataDelayMs){
  await waitFor(async()=>snapshotInFlight);
  assert.equal((await fetch(endpoint)).status,200,'A valid existing approval remains available during a healthy refresh');
 }
 assert.ok(notifications>0);assert.equal((await getStatus()).ready,true);
 const tradingStatus=(await getStatus()).trading;
 for(const [key,value] of Object.entries({policy:'equities-24x5',session:testSession,tradeDate:'2026-09-03',sourceFeed:expectedFeed}))assert.equal(tradingStatus[key],value);
 assert.equal((await fetch(endpoint,{headers:{Origin:'https://wrong.example'}})).status,403);
 assert.equal((await fetch(endpoint,{method:'POST'})).status,405);
 assert.equal((await fetch(`${riskUrl}/stock/approvals/${pool}`)).status,503);
 assert.equal((await fetch(`${riskUrl}/approvals/${collateral}`)).status,401,'Stock monitor must not expose pilot approvals');
 const proof=await (await fetch(endpoint)).json();assert.equal(proof.pool.toLowerCase(),pool.toLowerCase());assert.equal(proof.kind,'stock-pool');
 const recoveries=await client.getContractEvents({address:guard,abi:abis.get(guard),eventName:'HealthAccepted',fromBlock:0n,toBlock:'latest',strict:true});
 assert.ok(recoveries.length>0,'Monitor must have recovered the quarantined price guard');
 const recoveryTx=await client.getTransaction({hash:recoveries[0].transactionHash});
 assert.equal(recoveryTx.from.toLowerCase(),guardian.address.toLowerCase());
 const recoveredCall=decodeFunctionData({abi:abis.get(guard),data:recoveryTx.input});
 assert.equal(recoveredCall.functionName,'submitHealth');
 const legacyFormat=parseAbiParameters('(uint80,uint64,uint64,uint64,uint64,bytes32,uint64),bytes');
 const decodedPrice=decodeAbiParameters(legacyFormat,recoveredCall.args[0]);
 assert.equal(recoveredCall.args[0],encodeAbiParameters(legacyFormat,decodedPrice),'No engine authorization may leak in recovery calldata');
 assert.equal(await read(engine,'approvedMarketHealth'),`0x${'00'.repeat(32)}`,'Price recovery does not authorize the engine');
 const beforeGate=await read(gate,'liveness');
 await client.simulateContract({address:engine,abi:abis.get(engine),functionName:'quoteWithChecks',args:[owner.address,proof.health,proof.liveness]});
 assert.deepEqual(await read(gate,'liveness'),beforeGate,'Read-only monitor and quote checks do not publish onchain');
 await write(gate,'submitLiveness',[proof.liveness]);
 await write(engine,'setRiskPaused',[false]);await write(collateral,'mint',[borrower.address,10n**19n]);
 const borrowingSteps=await userAction(borrowerWallet,{kind:'depositBorrow',collateralAmount:10n**19n,amount:200000000n});
 assert.equal(borrowingSteps.length,2,'Exact collateral approval followed by checked borrowing');
 assert.equal(await read(pool,'outstandingPrincipal'),200000000n);
 let p=await (await fetch(endpoint)).json();const now=Number((await client.getBlock()).timestamp);
 await write(pool,'depositChecked',[100000000n,owner.address,1n,BigInt(now+30),p.health,p.liveness]);
 assert.equal(await read(pool,'availableCash'),400000000n);
 await write(cash,'mint',[publicLender.address,100000000n]);
 await userAction(lenderWallet,await lenderQuote(lenderWallet,'lend',100000000n));
 await userAction(lenderWallet,await lenderQuote(lenderWallet,'withdraw',25000000n));
 assert.equal(await read(pool,'availableCash'),475000000n);
 assert.equal(await read(cash,'balanceOf',[publicLender.address]),25000000n);
 assert.ok(await read(pool,'balanceOf',[publicLender.address])>0n,'A non-owner receives lender shares');
 // Authenticated live keeper status must be bound to this exact lending pool.
 wrongKeeper=true;notificationFailure=true;
 await waitFor(async()=> (await getStatus())?.incidents.some(i=>i.code==='risk_keeper_unavailable'));
 assert.equal((await fetch(endpoint)).status,503);
 await assert.rejects(fetchStockProofs(deployment,fetch,frontendClock),/unavailable/);
 assert.equal((await fetch(`${riskUrl}/liveness`)).status,200,'Keeper admission must not deadlock the separate liveness publisher');
 await waitFor(async()=> (await getStatus())?.alertDelivery?.delivered===false);
 assert.equal((await fetch(`${riskUrl}/liveness`)).status,200,'Rejected operator alerts must not block liquidation liveness');
 const oldProof=await (await fetch(`${riskUrl}/liveness`)).json();
 await waitFor(async()=>{
  const response=await fetch(`${riskUrl}/liveness`);if(!response.ok)return false;
  return (await response.json()).validUntil>oldProof.validUntil;
 });
 assert.equal((await fetch(endpoint)).status,503,'Failed keeper admission remains closed during alert failure');
 wrongKeeper=false;notificationFailure=false;await waitFor(async()=> (await fetch(endpoint)).ok);
 // USDG depeg/source faults are checked by the engine, not just stock snapshots.
 await write(usdA,'setAnswer',[200000000n]);
 await waitFor(async()=> (await getStatus())?.markets[0]?.code==='approval_unavailable');
 assert.equal((await fetch(endpoint)).status,503);
 await write(usdA,'setAnswer',[100000000n]);await waitFor(async()=> (await fetch(endpoint)).ok);
 // Loss of quorum stops both HTTP admission and liveness without requiring a user signature.
 rpcAvailable=false;await waitFor(async()=> (await getStatus())?.liveness?.code==='chain_unavailable');
 assert.equal((await fetch(`${riskUrl}/liveness`)).status,503);
 assert.equal((await fetch(endpoint)).status,503);
 const unavailable=await readStockWorkspace(client,deployment,publicLender.address,fetch,frontendClock);
 assert.equal(unavailable.proofUnavailable,true);assert.equal(unavailable.state.maxWithdraw,0n);
 assert.ok(unavailable.state.shares>0n,'The lender still sees owned shares during an outage');
 // Owner risk pause and missing proofs must not disable defensive borrower actions.
 await write(engine,'setRiskPaused',[true]);
 await write(collateral,'mint',[borrower.address,10n**18n]);
 await userAction(borrowerWallet,{kind:'addCollateral',amount:10n**18n});
 assert.equal((await read(engine,'positions',[borrower.address]))[0],11n*10n**18n);
 await write(cash,'mint',[borrower.address,1000000n]);
 await userAction(borrowerWallet,{kind:'repay',amount:201000000n});
 const position=await read(engine,'positions',[borrower.address]);
 await userAction(borrowerWallet,{kind:'removeCollateral',amount:position[0]});
 const shares=await read(pool,'balanceOf',[owner.address]);await write(pool,'redeem',[shares,owner.address,owner.address]);
 const publicShares=await read(pool,'balanceOf',[publicLender.address]);
 await userAction(lenderWallet,await lenderQuote(lenderWallet,'redeem',publicShares));
 assert.equal(await read(pool,'outstandingPrincipal'),0n);assert.equal(await read(pool,'balanceOf',[owner.address]),0n);
 assert.equal(await read(pool,'balanceOf',[publicLender.address]),0n);
 assert.ok(await read(cash,'balanceOf',[publicLender.address])>=100000000n,'Lender recovers principal after repayment');
 assert.equal(await read(collateral,'balanceOf',[borrower.address]),11n*10n**18n);
 assert.equal((await readIsolatedMarket(client,deployment,borrower.address,frontendClock)).debt,0n);
 assert.equal((await read(engine,'positions',[borrower.address]))[0],0n);
 console.log(JSON.stringify({evidence:'stock-services-local',session:testSession,sourceFeed:expectedFeed,realMonitor:true,realKeeper:true,httpProofs:true,continuousRecovery:true,
  wrongPoolRejected:true,alertFailurePreservesLiveness:true,usdgFaultRejected:true,quorumLossRejected:true,borrowAndLend:true,outageRepaymentAndFullExit:true,
  frontendTransactionHelpers:true,nonOwnerLender:true,pausedOutageTopup:true,browserWallet:Boolean(browserLifecycle),
  fixtureMarketData:true,fixtureClock:true,mockAssets:true,productionTransactions:0}));
});
