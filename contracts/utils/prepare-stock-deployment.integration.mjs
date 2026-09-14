import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,keccak256,toHex} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {encodeStockConfiguration,stockDeploymentData,preflightStockDeployment,stockDependencies,USDG,same} from './prepare-stock-deployment.mjs';
import {verifyStockDeployment} from './verify-stock-deployment.mjs';
import {stockInput} from './stock-deployment.fixtures.mjs';
import {isolatedConfigFromEnv} from '../../services/liquidator/src/isolated/config.mjs';
import {IsolatedChain} from '../../services/liquidator/src/isolated/chain.mjs';
import {isolatedAlertsDeployment} from '../../services/borrower-alerts/src/isolated-deployment.mjs';
import {stockPoolConfig,StockRiskChain} from '../../services/risk-monitor/src/stock-pool.mjs';
import {makeStockProof} from '../../services/risk-monitor/src/stock-policy.mjs';
import {roundHash} from '../../services/risk-monitor/src/policy.mjs';
import {makeLivenessProof} from '../../services/risk-monitor/src/liveness.mjs';
import {parseIsolatedMarkets} from '../../frontend/app/src/isolated-market-config.ts';
import {readIsolatedMarket} from '../../frontend/app/src/isolated-credit.ts';

const artifact=(file,name=file.replace('.sol',''))=>JSON.parse(readFileSync(new URL(`../out/${file}/${name}.json`,import.meta.url)));
test('stock commissioning exports consumer-valid bindings and preserves lender/borrower recovery',{timeout:90000},async t=>{
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port=reserve.address().port;await new Promise(r=>reserve.close(r));const url=`http://127.0.0.1:${port}`;
  const child=spawn('anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','4663','--accounts','0','--silent'],{stdio:'ignore'});
  let startupError;child.on('error',error=>{startupError=error;});
  t.after(async()=>{if(!startupError&&child.exitCode===null){const done=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await done;}});
  const client=createPublicClient({transport:http(url,{timeout:5000,retryCount:0}),cacheTime:0,pollingInterval:20});
  let ready=false;
  for(let i=0;i<100;i++){
    if(startupError||child.exitCode!==null)throw Error('Disposable Anvil failed');
    try{if(await client.getChainId()===4663){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  assert.ok(ready);assert.match(await client.request({method:'web3_clientVersion'}),/anvil/i);
  // Generated, disposable accounts; no environment key or external RPC used.
  const owner=privateKeyToAccount(generatePrivateKey()),guardian=privateKeyToAccount(generatePrivateKey()),
    keeper=privateKeyToAccount(generatePrivateKey()),borrower=privateKeyToAccount(generatePrivateKey());
  for(const a of [owner,guardian,keeper,borrower])await client.request({method:'anvil_setBalance',params:[a.address,toHex(10n**20n)]});
  const ownerWallet=createWalletClient({account:owner,transport:http(url)}),borrowerWallet=createWalletClient({account:borrower,transport:http(url)});
  const abis=new Map(),receipts=new Map();
  async function deploy(file,name,args=[]){
    const a=artifact(file,name),hash=await ownerWallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null});
    const r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');abis.set(r.contractAddress,a.abi);receipts.set(r.contractAddress,r);return r.contractAddress;
  }
  async function write(address,functionName,args=[],wallet=ownerWallet){
    const request={account:wallet.account,address,abi:abis.get(address),functionName,args};
    await client.simulateContract(request);
    const estimate=await client.estimateContractGas(request),gas=(estimate*125n+99n)/100n+50000n;
    const hash=await wallet.writeContract({...request,gas,chain:null}),r=await client.waitForTransactionReceipt({hash});assert.equal(r.status,'success');return r;
  }
  const read=(address,functionName,args=[])=>client.readContract({address,abi:abis.get(address),functionName,args});
  const input=stockInput(),{collateral,primary}=input.credit;
  const mockCash=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockERC20',['Fixture USDG','USDG',6]);
  const mockStock=await deploy('DockyardOracleV2.t.sol','ScaledStockFixture');
  const mockFeed=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,10000000000n]);
  // The canonical addresses are populated with mock bytecode ONLY on this node.
  // This proves deployment identity plumbing, not live source qualification.
  for(const [canonical,mock] of [[USDG,mockCash],[collateral,mockStock],[primary,mockFeed]]){
    await client.request({method:'anvil_setCode',params:[canonical,await client.getCode({address:mock})]});abis.set(canonical,abis.get(mock));
  }
  await write(collateral,'setMultiplier',[10n**18n,0n]);await write(primary,'setAnswer',[10000000000n]);
  const usdA=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[8,100000000n]);
  const usdB=await deploy('DockyardUSDGCreditVault.t.sol','DockyardMockOracle',[18,10n**18n]);
  const guard=await deploy('DockyardHeartbeatGuard.sol','DockyardHeartbeatGuard',[collateral,primary,guardian.address,86400]);
  const gate=await deploy('DockyardExecutionGate.sol','DockyardExecutionGate',[guardian.address]);
  input.credit.secondary=guard;input.credit.guardian=owner.address;input.executionGate=gate;input.treasury=owner.address;
  input.usdgPricing.primary=usdA;input.usdgPricing.secondary=usdB;input.usdgPricing.primaryMaxAge='3600';input.usdgPricing.secondaryMaxAge='3600';
  const before=await client.getBlock();input.deadline=String(before.timestamp+600n);
  for(const [key,address] of Object.entries(stockDependencies(input)))input.pins[key]=keccak256(await client.getCode({address}));
  const compiled=artifact('DockyardStockMarketDeployment.sol');
  // Inject one exposed alias into otherwise real local RPC reads. Both tools
  // must reject it; different deployed mock addresses are not sufficient.
  const aliasedClient={...client,readContract:args=>args.functionName==='aggregator'&&same(args.address,usdB)
    ?Promise.resolve(usdA):client.readContract(args)};
  await assert.rejects(preflightStockDeployment({input,artifact:compiled,deployer:owner.address,client:aliasedClient}),/share an exposed oracle dependency/);
  const plan=await preflightStockDeployment({input,artifact:compiled,deployer:owner.address,client});
  assert.equal(plan.usdgSourceIdentity.independenceVerified,false);
  assert.equal(await client.getBlockNumber({cacheTime:0}),before.number);assert.equal(await client.getCode({address:plan.predicted.bundle}),undefined);
  const payload=stockDeploymentData(encodeStockConfiguration(input),compiled);
  const hash=await ownerWallet.sendTransaction({data:payload.data,gas:plan.gasLimit,nonce:plan.nonce,chain:null});
  const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');assert.ok(receipt.gasUsed<=plan.gasLimit);
  const childArtifacts={engine:artifact('DockyardStockCreditEngine.sol'),pool:artifact('DockyardStockCapitalPool.sol')};
  const dependencyArtifacts={stockGuard:artifact('DockyardHeartbeatGuard.sol'),executionGate:artifact('DockyardExecutionGate.sol')};
  const verification={input,artifact:compiled,childArtifacts,dependencyArtifacts,deployer:owner.address,keeper:keeper.address,
    riskMonitorUrl:'https://risk.example',txHash:hash,client};
  await assert.rejects(verifyStockDeployment(verification),/Insufficient confirmations/);
  await client.request({method:'evm_mine',params:[]});
  await assert.rejects(verifyStockDeployment({...verification,client:aliasedClient}),/share an exposed oracle dependency/);
  const manifest=await verifyStockDeployment(verification),{engine,pool,bundle}=manifest.addresses;
  assert.equal(manifest.usdgSourceIdentity.independenceVerified,false);
  assert.deepEqual(manifest.addresses,plan.predicted);assert.equal(manifest.configHash,plan.configHash);
  assert.equal(manifest.productionApproved,false);assert.equal(manifest.riskMonitorCandidate.marketDataVerified,false);
  assert.equal(manifest.keeperCandidate.KEEPER_MODE,'observe');assert.equal(manifest.keeperCandidate.ISOLATED_ALLOW_RETAINED_COLLATERAL,'false');
  for(const [name,a] of Object.entries(childArtifacts))abis.set(manifest.addresses[name],a.abi);
  const parsed=parseIsolatedMarkets(JSON.stringify([manifest.frontendCandidate]));assert.equal(parsed[0].engine,engine);
  const ui=await readIsolatedMarket(client,parsed[0],owner.address);assert.equal(ui.riskPaused,true);
  const keeperConfig=isolatedConfigFromEnv({...manifest.keeperCandidate,KEEPER_RPC_URL:url});
  const keeperChain=new IsolatedChain(keeperConfig);assert.equal(await keeperChain.verifyDeployment(await client.getBlockNumber({cacheTime:0})),true);
  const riskConfig=stockPoolConfig(manifest.riskMonitorCandidate,{KEEPER_MODE:'observe',KEEPER_RPC_URL:url,KEEPER_LIVENESS_URL:'https://risk.example/liveness'});
  const riskChain=new StockRiskChain(riskConfig);assert.equal(await riskChain.verifyDeployment(await client.getBlockNumber({cacheTime:0})),true);
  const alerts=isolatedAlertsDeployment(manifest.alertsCandidate);assert.equal(alerts.vault,engine);assert.equal(alerts.stock.executionGate.toLowerCase(),gate.toLowerCase());
  // Mutation checks run against actual mined receipts/artifacts, not fake happy-path getters.
  const rejectWith=async(overrides,pattern)=>assert.rejects(verifyStockDeployment({...verification,client:{...client,...overrides}}),pattern);
  await rejectWith({getTransaction:async a=>({...await client.getTransaction(a),input:'0x00'})},/initcode/);
  await rejectWith({getTransaction:async a=>({...await client.getTransaction(a),chainId:1})},/transaction chain/);
  await rejectWith({getTransaction:async a=>({...await client.getTransaction(a),from:borrower.address})},/sender/);
  await rejectWith({getTransactionReceipt:async a=>({...await client.getTransactionReceipt(a),status:'reverted'})},/successfully mined/);
  await rejectWith({getTransactionReceipt:async a=>{const r=await client.getTransactionReceipt(a);return {...r,logs:[...r.logs,...r.logs.filter(l=>l.address.toLowerCase()===bundle.toLowerCase())]};}},/Exactly one/);
  await rejectWith({getTransactionReceipt:async a=>({...await client.getTransactionReceipt(a),contractAddress:borrower.address})},/deployment address/);
  await rejectWith({getCode:async a=>a.address===engine?'0x00':client.getCode(a)},/runtime lengths/);
  await rejectWith({getCode:async a=>same(a.address,guard)?'0x00':client.getCode(a)},/runtime lengths/);
  await rejectWith({getCode:async a=>same(a.address,usdB)?'0x00':client.getCode(a)},/Dependency changed/);
  await rejectWith({readContract:async a=>a.address===engine&&a.functionName==='MARKET_HEALTH_TYPEHASH'?'0x'+'00'.repeat(32):client.readContract(a)},/engine-scoped/);
  await rejectWith({readContract:async a=>a.address===engine&&a.functionName==='owner'?borrower.address:client.readContract(a)},/binding mismatch/);
  await rejectWith({readContract:async a=>same(a.address,gate)&&a.functionName==='guardian'?owner.address:client.readContract(a)},/binding mismatch/);
  await rejectWith({readContract:async a=>a.address===pool&&a.functionName==='borrowAprBps'?999n:client.readContract(a)},/parameter mismatch/);
  await rejectWith({readContract:async a=>a.functionName==='balanceOf'&&a.args[0]===pool?1n:client.readContract(a)},/Unexpected funds/);
  await rejectWith({getBlock:async a=>{const b=await client.getBlock(a);return a?.blockNumber===receipt.blockNumber?{...b,hash:'0x'+'00'.repeat(32)}:b;}},/not canonical/);
  await assert.rejects(verifyStockDeployment({...verification,keeper:guardian.address}),/must be distinct/);
  // A mutated runtime cannot become legitimate merely by replacing its config pin:
  // both creation input hash and the guard/gate compiled implementation are checked.
  const corrupt=structuredClone(dependencyArtifacts);corrupt.stockGuard.deployedBytecode.object='0x00';
  await assert.rejects(verifyStockDeployment({...verification,dependencyArtifacts:corrupt}),/runtime lengths/);
  assert.equal(manifest.directExit,null,'No exit is inferred from an empty market');
  const factory=await deploy('DockyardV3TwapFeed.t.sol','IsolatedMockV3Factory');
  const salePool=await deploy('DockyardAtomicLiquidator.t.sol','IsolatedExitMockPool',[collateral,USDG,factory,100000000n]);
  await write(factory,'register',[collateral,USDG,salePool]);
  const executor=await deploy('DockyardStockDirectLiquidator.sol','DockyardStockDirectLiquidator',[engine,salePool,factory]);
  const exit={deployer:owner.address,transactionHash:receipts.get(executor).transactionHash,salePool,factory,
    poolCodeHash:keccak256(await client.getCode({address:salePool})),factoryCodeHash:keccak256(await client.getCode({address:factory}))};
  const withExit={...verification,exit,exitArtifact:artifact('DockyardStockDirectLiquidator.sol')};
  await assert.rejects(verifyStockDeployment(withExit),/not sufficiently confirmed/);
  await client.request({method:'evm_mine',params:[]});
  const routed=await verifyStockDeployment(withExit);
  assert.equal(routed.directExit.wiringVerified,true);assert.equal(routed.directExit.liquidityVerified,false);
  assert.ok(same(routed.keeperCandidate.ISOLATED_EXIT_ADDRESS,executor));assert.equal(routed.keeperCandidate.KEEPER_MODE,'observe');
  const directChain=new IsolatedChain(isolatedConfigFromEnv({...routed.keeperCandidate,KEEPER_RPC_URL:url}));
  assert.equal(await directChain.verifyDeployment(await client.getBlockNumber({cacheTime:0})),true);
  for(const override of [{poolCodeHash:'0x'+'ab'.repeat(32)},{factoryCodeHash:'0x'+'ab'.repeat(32)},
    {transactionHash:hash},{salePool:guard},{deployer:keeper.address},{secret:'must-not-be-exported'}]){
    await assert.rejects(verifyStockDeployment({...withExit,exit:{...exit,...override}}));
  }
  await assert.rejects(verifyStockDeployment({...withExit,client:{...client,readContract:async a=>same(a.address,executor)&&a.functionName==='routeHealthy'?false:client.readContract(a)}}),/not healthy/);
  await assert.rejects(verifyStockDeployment({...withExit,client:{...client,getCode:async a=>same(a.address,executor)?'0x00':client.getCode(a)}}),/runtime lengths/);
  await assert.rejects(verifyStockDeployment({...withExit,client:{...client,readContract:async a=>same(a.address,executor)&&a.functionName==='engineCodeHash'?'0x'+'ab'.repeat(32):client.readContract(a)}}),/runtime pin mismatch/);
  // Funding, borrowing and both sides' exit use the verified addresses.
  await write(USDG,'mint',[owner.address,100000000n]);await write(USDG,'approve',[pool,100000000n]);
  await write(pool,'depositChecked',[100000000n,owner.address,100000000000000n,(await client.getBlock()).timestamp+300n,'0x','0x']);
  await assert.rejects(verifyStockDeployment(verification),/empty market/);
  await write(collateral,'mint',[borrower.address,10n**18n]);await write(collateral,'approve',[engine,10n**18n],borrowerWallet);
  await write(USDG,'mint',[borrower.address,1000000n]);await write(USDG,'approve',[engine,21000000n],borrowerWallet);
  await client.request({method:'evm_increaseTime',params:[121]});await client.request({method:'evm_mine',params:[]});
  const head=await client.getBlock(),now=Number(head.timestamp),round=await read(primary,'latestRoundData');
  const health=await makeStockProof(guardian,engine,guard,{ok:true,roundId:round[0],roundHash:roundHash(round[0],100n*10n**18n,round[3]),sourceTime:now,
    sessionOpen:now-120,sessionClose:now+3600},{epoch:await read(guard,'epoch'),recoveryAt:await read(guard,'recoveryAt')},now);
  const live=await makeLivenessProof(guardian,gate,{ok:true,observedAt:now,healthySince:Number(await read(gate,'recoveryAt'))},await read(gate,'epoch'));
  await assert.rejects(client.simulateContract({account:borrower,address:engine,abi:childArtifacts.engine.abi,functionName:'depositAndBorrowChecked',args:[10n**18n,20000000n,health.encoded,live.encoded]}));
  await write(gate,'submitLiveness',[live.encoded]);
  await write(engine,'setRiskPaused',[false]);
  await write(engine,'depositAndBorrowChecked',[10n**18n,20000000n,health.encoded,live.encoded],borrowerWallet);
  assert.equal(await read(pool,'outstandingPrincipal'),20000000n);assert.equal(await read(collateral,'balanceOf',[borrower.address]),0n);
  await write(primary,'setShouldRevert',[true]);await write(usdA,'setShouldRevert',[true]);await write(usdB,'setShouldRevert',[true]);
  await client.request({method:'evm_increaseTime',params:[3600]});await client.request({method:'evm_mine',params:[]});
  await write(engine,'close',[21000000n,borrower.address],borrowerWallet);
  assert.equal(await read(collateral,'balanceOf',[borrower.address]),10n**18n);
  const deadline=(await client.getBlock()).timestamp+300n;
  await write(pool,'redeemChecked',[await read(pool,'balanceOf',[owner.address]),owner.address,owner.address,100000000n,deadline,'0x','0x']);
  assert.ok(await read(USDG,'balanceOf',[owner.address])>100000000n,'Lender receives principal plus realized interest');
  assert.equal(await read(engine,'activeDebtPositions'),0n);assert.equal(await read(pool,'outstandingPrincipal'),0n);
  assert.equal(await read(pool,'totalSupply'),0n);
  const fees=await read(pool,'protocolFees');assert.ok(fees>0n);
  // ERC-4626 virtual-share rounding can leave one USDG base unit after the
  // last redemption. It is not a borrower debt or an unclaimed protocol fee.
  const dust=await read(USDG,'balanceOf',[pool])-fees;assert.ok(dust>=0n&&dust<=1n);
  await write(pool,'claimRevenue');assert.equal(await read(USDG,'balanceOf',[pool]),dust);
});
