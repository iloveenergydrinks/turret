import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as reserveServer} from 'node:net';
import {readFileSync,writeFileSync,renameSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {childEnvironment} from '../../expansion-supervisor/src/child-env.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,toHex,encodeAbiParameters}=require('viem');
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const artifact=(file,name)=>JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}/${name}.json`,import.meta.url)));
async function unusedPort(){const s=reserveServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

const testSession=process.env.EXTENDED_TEST_SESSION??'postmarket';
assert.ok(['postmarket','overnight'].includes(testSession));
const testSymbol=process.env.EXTENDED_TEST_SYMBOL??'AAPL';
assert.ok(['AAPL','MSFT','GOOGL','AMZN','META','NVDA','AMD','MU','TSLA'].includes(testSymbol));
const expectedFeed=testSession==='overnight'?'boats':'sip';
const debtCap=testSymbol==='AAPL'?50000000n:10000000n;
test(`actual ${testSymbol} ${testSession} monitor resumes only after recovery and resets qualification after a failed sale`, {timeout:240000},async t=>{
 const rpcPort=await unusedPort(),riskPort=await unusedPort();
 const rpcUrl=`http://127.0.0.1:${rpcPort}`,riskUrl=`http://127.0.0.1:${riskPort}`;
 const directory=mkdtempSync(`${tmpdir()}/dockyard-extended-monitor-`),clockFile=`${directory}/clock.json`;
 let clock=Math.floor(Date.parse(testSession==='overnight'?'2026-09-03T02:10:00Z':'2026-09-03T21:10:00Z')/1000),stale=false,ticker,risk,server,tickBusy=false;
 const setClock=value=>{clock=value;writeFileSync(clockFile+'.next',JSON.stringify({now:value}));renameSync(clockFile+'.next',clockFile);};setClock(clock);
 const anvil=spawn('anvil',['--host','127.0.0.1','--port',String(rpcPort),'--chain-id','4663','--accounts','0','--timestamp',String(clock),'--silent'],{stdio:'ignore'});
 t.after(async()=>{
  clearInterval(ticker);while(tickBusy)await pause(10);
  for(const child of [risk,anvil])if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(directory,{recursive:true,force:true});
 });
 const client=createPublicClient({transport:http(rpcUrl,{timeout:3000,retryCount:0}),pollingInterval:25,cacheTime:0});
 for(let i=0;i<100;i++){try{if(await client.getChainId()===4663)break;}catch{}await pause(50);}
 assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
 const owner=privateKeyToAccount(generatePrivateKey()),guardianKey=generatePrivateKey(),guardian=privateKeyToAccount(guardianKey),keeper=privateKeyToAccount(generatePrivateKey());
 for(const a of [owner,guardian,keeper])await client.request({method:'anvil_setBalance',params:[a.address,toHex(10n**19n)]});
 const wallet=createWalletClient({account:owner,transport:http(rpcUrl)}),abis=new Map();
 const deploy=async(file,name,args=[])=>{const a=artifact(file,name),hash=await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
  const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');abis.set(receipt.contractAddress,a.abi);return receipt.contractAddress;};
 const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
 const write=async(address,functionName,args=[])=>{const hash=await wallet.writeContract({address,abi:abis.get(address),functionName,args,gas:3000000n,chain:null});
  assert.equal((await client.waitForTransactionReceipt({hash})).status,'success',functionName);};
 const runtime=async a=>keccak256(await client.getCode({address:a}));
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
  {usdg:cash,collateral,primary,secondary:guard,guardian:owner.address,staleness:86400n,maxLtvBps:3000,liquidationLtvBps:4000,bonusBps:500,deviationBps:200,minimumDebt:1000000n},
  gate,{primary:usdA,secondary:usdB,primaryMaxAge:3600,secondaryMaxAge:3600,maxDeviationBps:200,maxTimestampSkew:300}]);
 const pool=await deploy('DockyardStockCapitalPool.sol','DockyardStockCapitalPool',[cash,collateral,engine,owner.address,debtCap,1000,1000]);
 await write(engine,'bindPool',[pool]);await write(cash,'mint',[owner.address,50000000n]);await write(cash,'approve',[pool,50000000n]);await write(pool,'deposit',[50000000n,owner.address]);
 await write(cash,'mint',[keeper.address,100000000n]);
 const venue=await deploy('DockyardReadOnlySaleProbe.t.sol','ProbeTestPool',[collateral,cash]);
 const factory=await deploy('DockyardReadOnlySaleProbe.t.sol','ProbeTestToken');
 const executor=await deploy('DockyardReadOnlySaleProbe.t.sol','ProbeTestRoute',[engine,venue,factory]);
 await write(collateral,'mint',[venue,10n**18n]);await write(cash,'mint',[venue,1000000000n]);
 let balanceMappingSlot;
 for(let slot=0n;slot<20n;slot++){
  const key=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[venue,slot]));
  if(BigInt(await client.getStorageAt({address:collateral,slot:key}))===10n**18n){balanceMappingSlot=toHex(slot,{size:32});break;}
 }
 assert.ok(balanceMappingSlot);
 const route={executor,salePool:venue,factory,poolFee:500,balanceMappingSlot,executorCodeHash:await runtime(executor),poolCodeHash:await runtime(venue),factoryCodeHash:await runtime(factory)};
 const manifest={kind:'stock-pool',chainId:4663,status:'receipt-verified',marketDataVerified:true,vault:engine,vaultCodeHash:await runtime(engine),
  tradingSessionPolicy:'equities-24x5',marketDataUseApproved:true,pool,poolCodeHash:await runtime(pool),usdg:cash,usdgCodeHash:await runtime(cash),
  executionGate:gate,executionGateCodeHash:await runtime(gate),usdgPrimary:usdA,usdgPrimaryCodeHash:await runtime(usdA),usdgSecondary:usdB,usdgSecondaryCodeHash:await runtime(usdB),
  owner:owner.address,guardian:guardian.address,keeper:keeper.address,startBlock:1,
  continuousSessionAdmission:{version:testSymbol==='AAPL'?2:3,healthySeconds:900,maxDebtLimit:String(debtCap),maxLtvBps:3000,saleHaircutBps:200,corroborationWindowSeconds:60,staleQuoteGraceSeconds:120,route},
  markets:[{symbol:testSymbol,collateral,collateralCodeHash:await runtime(collateral),primaryOracle:primary,primaryCodeHash:await runtime(primary),adapter:guard,adapterCodeHash:await runtime(guard),maxPriceAgeSeconds:86400,sessionDataVerified:{regular:'sip'}}]};
 const token='local-fixture-status-'.repeat(3);let supplementaryRequests=0;
 server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/v2/stocks/snapshots'){
    assert.equal(url.searchParams.get('feed'),expectedFeed);
    const stamp=new Date((clock-(stale?35:0))*1000).toISOString();
    assert.equal(url.searchParams.get('symbols'),testSymbol);
    res.end(JSON.stringify({[testSymbol]:{latestTrade:{p:100,t:stamp},latestQuote:{bp:99.99,ap:100.01,t:stamp}}}));return;
   }
   if(url.pathname===`/v2/stocks/${testSymbol}/trades`){
    assert.equal(url.searchParams.get('feed'),expectedFeed);
    const age=clock-Date.parse(url.searchParams.get('start'))/1000;assert.ok(age>=60&&age<=70,`Cohort request age ${age}`);
    supplementaryRequests++;res.end(JSON.stringify({trades:[]}));return;
   }
   if(url.pathname==='/keeper'){
    res.end(JSON.stringify({alertDelivery:{delivered:true},snapshot:{mode:'execute',reconciled:true,chainId:4663,marketKind:'stock',
     engine,pool,poolCodeHash:manifest.poolCodeHash,collateral,executionGate:gate,codeHash:manifest.vaultCodeHash,account:keeper.address,checkedAt:clock*1000,
     executor,executorCodeHash:route.executorCodeHash,balances:{usdg:'100000000'},profitPolicy:{absoluteFloor:'1',repaymentBps:50},incidents:[]}}));return;
   }
   if(url.pathname==='/webhook'){req.resume();res.end('{}');return;}
   let body='';for await(const chunk of req)body+=chunk;
   const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body});res.end(await response.text());
  }catch(error){res.writeHead(503);res.end('{}');console.error('Local fixture:',error.message);}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const control=`http://127.0.0.1:${server.address().port}`;
 setClock(Number((await client.getBlock()).timestamp));
 ticker=setInterval(async()=>{if(tickBusy)return;tickBusy=true;try{
  const next=Math.max(clock+5,Number((await client.getBlock()).timestamp)+5);setClock(next);
  await client.request({method:'anvil_setNextBlockTimestamp',params:[next]});await client.request({method:'evm_mine',params:[]});
 }finally{tickBusy=false;}},500);
 const workerEnv={PATH:process.env.PATH,ALCHEMY_RPC_URL:rpcUrl,KEEPER_FALLBACK_RPC_URLS:control,KEEPER_RPC_TIMEOUT_MS:'3000',
   STOCK_FIXTURE_CONTROL_URL:control,STOCK_FIXTURE_CLOCK_FILE:clockFile,RISK_MODE:'execute',RISK_LIVENESS_MODE:'execute',
   RISK_GUARDIAN_PRIVATE_KEY:guardianKey,RISK_MANIFEST_JSON:JSON.stringify(manifest),RISK_LIVENESS_URL:riskUrl+'/liveness',RISK_KEEPER_STATUS_URL:control+'/keeper',RISK_KEEPER_STATUS_TOKEN:token,
   RISK_STATUS_TOKEN:token,RISK_DATA_DIR:directory+'/risk',RISK_APP_ORIGIN:'http://localhost',RISK_ALERT_WEBHOOK_URL:control+'/webhook',
   ALPACA_API_KEY:'fixture',ALPACA_API_SECRET:'fixture',ALPACA_DATA_FEED:'sip',PORT:String(riskPort),RISK_POLL_MS:'1000'};
 let resolvedEnv=workerEnv;
 if(testSymbol!=='AAPL'){
  delete workerEnv.RISK_MANIFEST_JSON;
  resolvedEnv=childEnvironment({EXPANSION_RISK_MANIFESTS_JSON:JSON.stringify({[testSymbol]:manifest})},
   {symbol:testSymbol,env:workerEnv},riskPort,'risk',0);
 }
 risk=spawn(process.execPath,['--import',new URL('./extended-clock-preload.mjs',import.meta.url).pathname,new URL('../src/main.mjs',import.meta.url).pathname],{
  env:resolvedEnv,stdio:['ignore','pipe','pipe']});
 let logs='';for(const stream of [risk.stdout,risk.stderr])stream.on('data',b=>{logs=(logs+b).slice(-16000);});
 const status=async()=>{try{return await(await fetch(riskUrl+'/status',{headers:{Authorization:'Bearer '+token}})).json();}catch{return null;}};
 async function waitFor(check,ms=15000){const until=Date.now()+ms;while(Date.now()<until){assert.equal(risk.exitCode,null,logs);if(await check())return;await pause(200);}assert.fail(JSON.stringify({status:await status(),logs}));}
 const endpoint=riskUrl+'/stock/approvals/'+engine;
 await waitFor(async()=>Boolean((await status())?.lastCycle));assert.equal((await fetch(endpoint)).status,503);
 await waitFor(async()=>(await fetch(endpoint)).status===200,140000);
 const initial=await status();assert.equal(initial.admission.ready,true);assert.ok(initial.admission.checkedAt-initial.admission.since>=900);assert.ok(supplementaryRequests>=60);
 const prove=async()=>{const p=await(await fetch(endpoint)).json();await client.simulateContract({address:engine,abi:abis.get(engine),functionName:'quoteWithChecks',args:[owner.address,p.health,p.liveness]});};
 await prove();console.log('Initial continuous qualification completed; signed proof accepted by local contracts.');
 stale=true;
 await waitFor(async()=>(await status())?.admission?.qualificationRetained===true);
 assert.equal((await fetch(endpoint)).status,503);await pause(2500);stale=false;
 await waitFor(async()=>(await status())?.admission?.code==='price_recovering');
 assert.equal((await fetch(endpoint)).status,503,'Recovery does not authorize borrowing');
 const resumedAfter=Date.now();await waitFor(async()=>(await fetch(endpoint)).status===200,25000);
 const resumed=await status();assert.equal(resumed.admission.since,initial.admission.since,'Prior completed qualification retained');
 await prove();assert.ok(Date.now()-resumedAfter<25000,'No second 90-real-second qualification');
 console.log('Short stale-price gap denied borrowing; fresh-price recovery resumed with a contract-accepted proof.');
 await write(venue,'setFill',[5000]);
 await waitFor(async()=>(await status())?.markets?.[0]?.code==='extended_sale_unavailable');assert.equal((await fetch(endpoint)).status,503);
 await write(venue,'setFill',[10000]);
 await waitFor(async()=>(await status())?.admission?.code==='session_qualifying');
 assert.equal((await fetch(endpoint)).status,503);assert.ok((await status()).admission.since>initial.admission.since);
 console.log('Failed sale reset qualification; restored venue requires a new full qualification.');
});
