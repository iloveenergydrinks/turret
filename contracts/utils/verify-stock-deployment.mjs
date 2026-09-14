import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPublicClient,decodeEventLog,http,keccak256,parseAbi,stringToHex} from 'viem';
import {demand,same,nonzeroAddress,encodeStockConfiguration,stockDeploymentData,stockDependencies,predictedStockAddresses,freshHead} from './prepare-stock-deployment.mjs';
import {matchCompiledRuntime} from './recompile-collateral.mjs';
import {verifyStockDirectExit} from './verify-stock-direct-exit.mjs';
import {inspectUsdgSourceIdentity} from './inspect-stock-usdg.mjs';

const MARKET_HEALTH=keccak256(stringToHex('MarketHealth(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)'));
function monitorOrigin(value){
  const u=new URL(value);
  demand((u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname))
    &&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','Invalid risk monitor origin');
  return u.origin;
}
/** Commissioning a paused, empty stock pool, not authorizing a public launch. */
export async function verifyStockDeployment({input,artifact,childArtifacts,dependencyArtifacts,deployer,keeper,riskMonitorUrl,txHash,client,exit,exitArtifact,confirmations=2,now=()=>Date.now()}){
  demand(Number.isSafeInteger(confirmations)&&confirmations>=2,'At least two confirmations required');
  demand(/^0x[0-9a-f]{64}$/i.test(txHash??''),'Transaction hash required');
  deployer=nonzeroAddress(deployer);keeper=nonzeroAddress(keeper);
  const origin=monitorOrigin(riskMonitorUrl),prepared=encodeStockConfiguration(input),c=prepared.config;
  const payload=stockDeploymentData(prepared,artifact);
  const compiled={bundle:artifact,engine:childArtifacts?.engine,pool:childArtifacts?.pool,
    stockGuard:dependencyArtifacts?.stockGuard,executionGate:dependencyArtifacts?.executionGate};
  for(const value of Object.values(compiled))demand(value?.deployedBytecode?.object,'Compiled engine, pool, guard and gate runtimes required');
  demand(await client.getChainId()===4663,'Wrong RPC chain');
  const [tx,receipt,head]=await Promise.all([client.getTransaction({hash:txHash}),client.getTransactionReceipt({hash:txHash}),client.getBlock()]);
  freshHead(head,now);
  demand(same(tx.hash,txHash)&&same(receipt.transactionHash,txHash),'Transaction identity mismatch');
  demand(same(tx.from,deployer)&&same(receipt.from,deployer)&&tx.to===null&&receipt.to===null&&tx.value===0n,'Unexpected deployment sender or creation transaction');
  demand(BigInt(tx.chainId)===4663n&&Number.isSafeInteger(tx.nonce)&&tx.nonce>=0,'Unexpected transaction chain or nonce');
  demand(keccak256(tx.input)===payload.initcodeHash,'Mined initcode differs from artifact and configuration');
  demand(receipt.status==='success'&&receipt.blockNumber!==null&&same(receipt.blockHash,tx.blockHash)&&tx.blockNumber===receipt.blockNumber,'Deployment was not successfully mined');
  demand(head.number>=receipt.blockNumber&&head.number-receipt.blockNumber+1n>=BigInt(confirmations),'Insufficient confirmations');
  const mined=await client.getBlock({blockNumber:receipt.blockNumber});
  demand(same(mined.hash,receipt.blockHash),'Deployment block is not canonical');
  demand(mined.timestamp<=c.deadline&&c.deadline<=mined.timestamp+86400n,'Configuration deadline did not cover deployment');
  const addresses=predictedStockAddresses(deployer,tx.nonce),{bundle,engine,pool}=addresses;
  demand(same(receipt.contractAddress,bundle),'Unexpected deployment address');
  const events=receipt.logs.filter(l=>same(l.address,bundle)).map(log=>{
    demand(!log.removed,'Removed deployment log');
    try{return decodeEventLog({abi:artifact.abi,data:log.data,topics:log.topics});}catch{return null;}
  }).filter(e=>e?.eventName==='StockMarketDeployed');
  demand(events.length===1,'Exactly one deployment event required');
  const event=events[0].args;
  demand(same(event.configHash,prepared.configHash)&&same(event.collateral,c.credit.collateral)&&same(event.owner,c.credit.guardian)
    &&same(event.engine,engine)&&same(event.pool,pool),'Deployment event identity mismatch');
  const dependencies=stockDependencies(c),hashes={};
  await Promise.all(Object.entries({...addresses,...dependencies}).map(async([key,address])=>{
    const code=await client.getCode({address,blockNumber:head.number});
    demand(code&&code!=='0x','Missing deployed runtime');
    if(compiled[key]){
      const runtime=compiled[key].deployedBytecode;
      matchCompiledRuntime(runtime.object,code,runtime.immutableReferences);
    }
    hashes[key]=keccak256(code);
    if(c.pins[key])demand(same(hashes[key],c.pins[key]),'Dependency changed since configuration');
  }));
  const read=(address,name,type='address',args=[])=>client.readContract({address,
    abi:parseAbi([`function ${name}(${args.length?'address':''}) view returns (${type})`]),functionName:name,args,blockNumber:head.number});
  const usdgSourceIdentity=await inspectUsdgSourceIdentity({client,primary:c.usdgPricing.primary,secondary:c.usdgPricing.secondary,blockNumber:head.number});
  demand(!usdgSourceIdentity.knownAlias,'USDG feeds share an exposed oracle dependency');
  const guardian=nonzeroAddress(await read(c.credit.secondary,'guardian'));
  demand(new Set([guardian,c.credit.guardian,keeper].map(a=>a.toLowerCase())).size===3,'Owner, guardian and keeper must be distinct');
  demand(!Object.values({...addresses,...dependencies}).some(a=>[guardian,c.credit.guardian,keeper,c.treasury].some(b=>same(a,b))),'Internal role or fee recipient');
  const bindings=[
    [bundle,'engine',engine],[bundle,'pool',pool],[engine,'owner',c.credit.guardian],
    [engine,'usdg',c.credit.usdg],[engine,'collateralToken',c.credit.collateral],
    [engine,'primary',c.credit.primary],[engine,'secondary',c.credit.secondary],[engine,'stockGuard',c.credit.secondary],
    [engine,'pool',pool],[engine,'executionGate',c.executionGate],
    [engine,'usdgPrimary',c.usdgPricing.primary],[engine,'usdgSecondary',c.usdgPricing.secondary],
    [pool,'creditEngine',engine],[pool,'asset',c.credit.usdg],[pool,'collateralToken',c.credit.collateral],[pool,'feeRecipient',c.treasury],
    [c.credit.secondary,'collateral',c.credit.collateral],[c.credit.secondary,'primaryOracle',c.credit.primary],
    [c.executionGate,'guardian',guardian],
  ];
  await Promise.all(bindings.map(async([a,key,expected])=>demand(same(await read(a,key),expected),'Current market binding mismatch')));
  demand(same(await read(bundle,'configHash','bytes32'),prepared.configHash),'Stored configuration hash mismatch');
  demand(same(await read(engine,'MARKET_HEALTH_TYPEHASH','bytes32'),MARKET_HEALTH),'Missing engine-scoped stock authorization');
  demand(await read(engine,'riskPaused','bool')===true,'Commissioning requires borrowing paused');
  const parameters=[...['staleness','maxLtvBps','liquidationLtvBps','bonusBps','deviationBps','minimumDebt'].map(k=>[engine,k,c.credit[k]]),
    ...['debtLimit','revenueFeeBps','borrowAprBps'].map(k=>[pool,k,c[k]]),
    [engine,'usdgPrimaryMaxAge',c.usdgPricing.primaryMaxAge],[engine,'usdgSecondaryMaxAge',c.usdgPricing.secondaryMaxAge],
    [engine,'usdgMaxDeviationBps',c.usdgPricing.maxDeviationBps],
    [engine,'usdgMaxTimestampSkew',c.usdgPricing.maxTimestampSkew],[engine,'MAX_ACTIVE_POSITIONS',64n],
    [c.credit.secondary,'MAX_PRICE_AGE',c.credit.staleness],[c.credit.secondary,'maxDeviationBps',c.credit.deviationBps],
    [c.credit.secondary,'MAX_HEALTH_AGE',60n],[c.credit.secondary,'RECOVERY_DELAY',120n],
    [c.executionGate,'MAX_LIFETIME',45n],[c.executionGate,'RECOVERY_DELAY',120n],
    [c.credit.usdg,'decimals',6n],[c.credit.collateral,'decimals',18n]];
  await Promise.all(parameters.map(async([a,key,expected])=>demand(BigInt(await read(a,key,'uint256'))===expected,'Current parameter mismatch')));
  for(const [a,key] of [[engine,'activeDebtPositions'],[pool,'outstandingPrincipal'],[pool,'totalSupply'],[pool,'totalAssets']]){
    demand(await read(a,key,'uint256')===0n,'Commissioning requires an empty market');
  }
  for(const holder of Object.values(addresses))for(const token of [c.credit.usdg,c.credit.collateral]){
    demand(await read(token,'balanceOf','uint256',[holder])===0n,'Unexpected funds in commissioning contracts');
  }
  const directExit=exit===undefined?null:await verifyStockDirectExit({input:exit,artifact:exitArtifact,client,head,confirmations,now,
    stock:{engine,pool,collateral:c.credit.collateral,usdg:c.credit.usdg,executionGate:c.executionGate,deploymentBlock:receipt.blockNumber,hashes,
      roles:[c.credit.guardian,guardian,keeper,c.treasury]}});
  // No health/liveness signatures are required for deployment verification.
  // A price(), proof, or service readiness test is a separate activation gate.
  const [canonicalHead,canonicalMined]=await Promise.all([client.getBlock({blockNumber:head.number}),client.getBlock({blockNumber:receipt.blockNumber})]);
  demand(same(canonicalHead.hash,head.hash)&&same(canonicalMined.hash,receipt.blockHash),'Verification snapshot changed');freshHead(head,now);
  const frontendCandidate={chainId:4663,symbol:prepared.symbol,engine,pool,collateral:c.credit.collateral,primary:c.credit.primary,secondary:c.credit.secondary,
    hashes:{engine:hashes.engine,pool:hashes.pool,collateral:hashes.collateral,primary:hashes.stockFeed,secondary:hashes.stockGuard,usdg:hashes.usdg},
    stock:{executionGate:c.executionGate,usdgPrimary:c.usdgPricing.primary,usdgSecondary:c.usdgPricing.secondary,riskMonitorUrl:origin,
      hashes:{executionGate:hashes.executionGate,usdgPrimary:hashes.usdgPrimary,usdgSecondary:hashes.usdgSecondary}}};
  const riskMonitorCandidate={kind:'stock-pool',chainId:4663,status:'receipt-verified',marketDataVerified:false,
    revision:'stock-engine-scoped-v1',vault:engine,vaultCodeHash:hashes.engine,pool,poolCodeHash:hashes.pool,
    usdg:c.credit.usdg,usdgCodeHash:hashes.usdg,executionGate:c.executionGate,executionGateCodeHash:hashes.executionGate,
    usdgPrimary:c.usdgPricing.primary,usdgPrimaryCodeHash:hashes.usdgPrimary,usdgSecondary:c.usdgPricing.secondary,usdgSecondaryCodeHash:hashes.usdgSecondary,
    owner:c.credit.guardian,guardian,keeper,startBlock:String(receipt.blockNumber),
    markets:[{symbol:prepared.symbol,collateral:c.credit.collateral,collateralCodeHash:hashes.collateral,
      primaryOracle:c.credit.primary,primaryCodeHash:hashes.stockFeed,adapter:c.credit.secondary,adapterCodeHash:hashes.stockGuard,
      maxPriceAgeSeconds:Number(c.credit.staleness)}]};
  return {chainId:4663,transactionHash:txHash,deploymentBlock:receipt.blockNumber,deploymentBlockHash:receipt.blockHash,
    verificationBlock:head.number,verificationBlockHash:head.hash,configHash:prepared.configHash,initcodeHash:payload.initcodeHash,
    addresses,hashes,frontendCandidate,riskMonitorCandidate,directExit,usdgSourceIdentity,
    keeperCandidate:{KEEPER_MODE:'observe',ISOLATED_MARKET_KIND:'stock',ISOLATED_ENGINE_ADDRESS:engine,ISOLATED_ENGINE_CODE_HASH:hashes.engine,
      ISOLATED_POOL_ADDRESS:pool,ISOLATED_POOL_CODE_HASH:hashes.pool,ISOLATED_COLLATERAL_ADDRESS:c.credit.collateral,ISOLATED_COLLATERAL_CODE_HASH:hashes.collateral,
      ISOLATED_PRIMARY_ORACLE:c.credit.primary,ISOLATED_PRIMARY_CODE_HASH:hashes.stockFeed,ISOLATED_SECONDARY_ORACLE:c.credit.secondary,ISOLATED_SECONDARY_CODE_HASH:hashes.stockGuard,
      KEEPER_EXECUTION_GATE:c.executionGate,KEEPER_LIVENESS_URL:`${origin}/liveness`,STOCK_GUARDIAN_ADDRESS:guardian,STOCK_USDG_CODE_HASH:hashes.usdg,
      STOCK_EXECUTION_GATE_CODE_HASH:hashes.executionGate,STOCK_USDG_PRIMARY_ORACLE:c.usdgPricing.primary,STOCK_USDG_PRIMARY_CODE_HASH:hashes.usdgPrimary,
      STOCK_USDG_SECONDARY_ORACLE:c.usdgPricing.secondary,STOCK_USDG_SECONDARY_CODE_HASH:hashes.usdgSecondary,ISOLATED_ALLOW_RETAINED_COLLATERAL:'false',
      ...(directExit?{ISOLATED_EXIT_ADDRESS:directExit.executor,ISOLATED_EXIT_CODE_HASH:directExit.executorCodeHash}:{})},
    alertsCandidate:{ALERTS_PROTOCOL:'isolated',ALERTS_ISOLATED_MARKET_KIND:'stock',ALERTS_VAULT_ADDRESS:engine,ALERTS_VAULT_CODE_HASH:hashes.engine,
      ALERTS_POOL_ADDRESS:pool,ALERTS_POOL_CODE_HASH:hashes.pool,ALERTS_COLLATERAL_ADDRESS:c.credit.collateral,ALERTS_COLLATERAL_CODE_HASH:hashes.collateral,
      ALERTS_START_BLOCK:String(receipt.blockNumber),ALERTS_EXECUTION_GATE:c.executionGate,ALERTS_EXECUTION_GATE_CODE_HASH:hashes.executionGate,ALERTS_LIVENESS_URL:`${origin}/liveness`},
    deploymentVerified:true,borrowingEnabled:false,productionApproved:false,
    limitations:'Paused empty deployment verified, not activated. Candidates are not installed. Feed identity/independence/rights, price and proof availability, liquidation routes, funding, service readiness, delivery, security review and target-chain finality remain separate release requirements.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    const [file,deployer,txHash,keeper,riskMonitorUrl,exitFile,...extra]=process.argv.slice(2);
    demand(file&&deployer&&txHash&&keeper&&riskMonitorUrl&&!extra.length&&process.env.COLLATERAL_RPC_URL,'Explicit inputs required');
    const load=async name=>JSON.parse(await readFile(new URL(`../out/${name}.sol/${name}.json`,import.meta.url),'utf8'));
    const [input,artifact,engine,pool,stockGuard,executionGate]=await Promise.all([
      readFile(file,'utf8').then(JSON.parse),load('DockyardStockMarketDeployment'),load('DockyardStockCreditEngine'),
      load('DockyardStockCapitalPool'),load('DockyardHeartbeatGuard'),load('DockyardExecutionGate')]);
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:20000,retryCount:0}),cacheTime:0});
    const exit=exitFile?JSON.parse(await readFile(exitFile,'utf8')):undefined;
    const exitArtifact=exitFile?await load('DockyardStockDirectLiquidator'):undefined;
    const result=await verifyStockDeployment({input,artifact,childArtifacts:{engine,pool},dependencyArtifacts:{stockGuard,executionGate},deployer,keeper,riskMonitorUrl,txHash,client,exit,exitArtifact});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2));
  })().catch(()=>{console.error('Stock deployment verification failed. No configuration installed and no transaction sent.');process.exitCode=1;});
}
