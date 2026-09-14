import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPublicClient,decodeEventLog,getAddress,getContractAddress,http,keccak256,parseAbi} from 'viem';
import {deploymentData,encodeConfiguration} from './prepare-isolated-deployment.mjs';
import {matchCompiledRuntime} from './recompile-collateral.mjs';
import {verifyOracleWiring} from './verify-isolated-oracle-wiring.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(condition,message)=>{if(!condition)throw Error(message);};

/** Commissioning check for a newly mined, still-paused market. Never activates it. */
export async function verifyDeployment({input,artifact,childArtifacts,deployer,txHash,client,oracle,confirmations=2,now=()=>Date.now()}) {
  demand(Number.isSafeInteger(confirmations)&&confirmations>=2,'At least two confirmations required');
  demand(/^0x[0-9a-f]{64}$/i.test(txHash??''),'Transaction hash required');
  deployer=getAddress(deployer);
  const prepared=encodeConfiguration(input),c=prepared.config,payload=deploymentData(prepared,artifact);
  const runtimeArtifacts={bundle:artifact,engine:childArtifacts?.engine,pool:childArtifacts?.pool,executor:childArtifacts?.executor};
  for(const name of ['bundle','engine','pool','executor'])demand(runtimeArtifacts[name]?.deployedBytecode?.object,'Compiled runtime artifacts required');
  demand(await client.getChainId()===4663,'Wrong chain');
  const [tx,receipt,head]=await Promise.all([client.getTransaction({hash:txHash}),client.getTransactionReceipt({hash:txHash}),client.getBlock()]);
  const wall=BigInt(Math.floor(now()/1000));
  demand(head.number!==null&&head.hash&&head.timestamp<=wall+15n&&wall-head.timestamp<=60n,'Stale verification head');
  demand(same(tx.hash,txHash)&&same(receipt.transactionHash,txHash),'Transaction identity mismatch');
  demand(same(tx.from,deployer)&&same(receipt.from,deployer)&&tx.to===null&&receipt.to===null&&tx.value===0n,'Not the expected deployment sender or creation transaction');
  demand(BigInt(tx.chainId)===4663n&&Number.isSafeInteger(tx.nonce)&&tx.nonce>=0,'Unexpected transaction chain or nonce');
  demand(keccak256(tx.input)===payload.initcodeHash,'Mined initcode differs from reviewed artifact and configuration');
  demand(receipt.status==='success'&&receipt.blockNumber!==null&&same(receipt.blockHash,tx.blockHash)&&tx.blockNumber===receipt.blockNumber,'Deployment was not successfully mined');
  demand(head.number>=receipt.blockNumber&&head.number-receipt.blockNumber+1n>=BigInt(confirmations),'Insufficient confirmations');
  const mined=await client.getBlock({blockNumber:receipt.blockNumber});
  demand(same(mined.hash,receipt.blockHash),'Deployment block is not canonical');
  demand(mined.timestamp<=c.deadline&&c.deadline<=mined.timestamp+86400n,'Configuration deadline did not cover deployment');
  const bundle=getContractAddress({from:deployer,nonce:BigInt(tx.nonce)});
  demand(same(receipt.contractAddress,bundle),'Unexpected deployment address');
  const addresses={bundle,engine:getContractAddress({from:bundle,nonce:1n}),pool:getContractAddress({from:bundle,nonce:2n}),executor:getContractAddress({from:bundle,nonce:3n})};
  const events=receipt.logs.filter(log=>same(log.address,bundle)).map(log=>{
    demand(!log.removed,'Removed deployment log');
    try{return decodeEventLog({abi:artifact.abi,data:log.data,topics:log.topics});}catch{return null;}
  }).filter(event=>event?.eventName==='MarketDeployed');
  demand(events.length===1,'Exactly one matching deployment event required');
  const event=events[0].args;
  demand(event.configHash===prepared.configHash&&same(event.collateral,c.credit.collateral)&&same(event.guardian,c.credit.guardian),'Deployment event identity mismatch');
  for(const name of ['engine','pool','executor'])demand(same(event[name],addresses[name]),'Deployment child address mismatch');

  const read=(address,name,type='address')=>client.readContract({address,abi:parseAbi([`function ${name}() view returns (${type})`]),functionName:name,blockNumber:head.number});
  const bindings=[
    [bundle,'engine',addresses.engine],[bundle,'pool',addresses.pool],[bundle,'executor',addresses.executor],
    [addresses.engine,'owner',c.credit.guardian],[addresses.engine,'usdg',c.credit.usdg],
    [addresses.engine,'collateralToken',c.credit.collateral],[addresses.engine,'primary',c.credit.primary],
    [addresses.engine,'secondary',c.credit.secondary],[addresses.engine,'pool',addresses.pool],
    [addresses.pool,'creditEngine',addresses.engine],[addresses.pool,'asset',c.credit.usdg],
    [addresses.pool,'collateralToken',c.credit.collateral],[addresses.pool,'feeRecipient',c.treasury],
    [addresses.executor,'engine',addresses.engine],[addresses.executor,'usdg',c.credit.usdg],
    [addresses.executor,'collateral',c.credit.collateral],[addresses.executor,'intermediate',c.intermediate],
    [addresses.executor,'firstPool',c.firstPool],[addresses.executor,'secondPool',c.secondPool],
  ];
  await Promise.all(bindings.map(async ([target,name,expected])=>demand(same(await read(target,name),expected),'Current market binding mismatch')));
  demand(await read(bundle,'configHash','bytes32')===prepared.configHash,'Stored configuration hash mismatch');
  demand(await read(addresses.engine,'riskPaused','bool')===true,'Commissioning requires borrowing paused');
  demand(await read(addresses.executor,'routeHealthy','bool')===true,'Liquidation route changed');
  for(const key of ['staleness','maxLtvBps','liquidationLtvBps','bonusBps','deviationBps','minimumDebt']){
    demand(BigInt(await read(addresses.engine,key,'uint256'))===c.credit[key],'Current risk parameter mismatch');
  }
  for(const key of ['debtLimit','revenueFeeBps','borrowAprBps'])demand(BigInt(await read(addresses.pool,key,'uint256'))===c[key],'Current pool parameter mismatch');
  for(const [target,name] of [[addresses.engine,'activeDebtPositions'],[addresses.pool,'outstandingPrincipal'],[addresses.pool,'totalSupply'],[addresses.pool,'totalAssets']]){
    demand(await read(target,name,'uint256')===0n,'Commissioning requires a new empty market');
  }
  await Promise.all([bundle,addresses.engine,addresses.executor].flatMap(holder=>[c.credit.usdg,c.credit.collateral,c.intermediate].map(async token=>{
    const balance=await client.readContract({address:token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[holder],blockNumber:head.number});
    demand(balance===0n,'Unexpected funds in commissioning contracts');
  })));
  demand(await read(addresses.engine,'price','uint256')>0n,'Market price unavailable');
  const dependencyAddresses={usdg:c.credit.usdg,collateral:c.credit.collateral,primary:c.credit.primary,secondary:c.credit.secondary,
    intermediate:c.intermediate,firstPool:c.firstPool,secondPool:c.secondPool,factory:c.factory};
  const hashes={};
  await Promise.all(Object.entries({...addresses,...dependencyAddresses}).map(async ([name,address])=>{
    const code=await client.getCode({address,blockNumber:head.number});
    demand(code&&code!=='0x','Missing deployed runtime');
    if(runtimeArtifacts[name]) {
      const compiled=runtimeArtifacts[name].deployedBytecode;
      matchCompiledRuntime(compiled.object,code,compiled.immutableReferences);
    }
    hashes[name]=keccak256(code);
    if(c.pins[name])demand(hashes[name]===c.pins[name],'Dependency changed since reviewed configuration');
  }));
  const oracleServices=oracle===undefined?null:await verifyOracleWiring({config:c,oracle,client,blockNumber:head.number});
  const [canonicalHead,canonicalMined]=await Promise.all([client.getBlock({blockNumber:head.number}),client.getBlock({blockNumber:receipt.blockNumber})]);
  demand(same(canonicalHead.hash,head.hash)&&same(canonicalMined.hash,receipt.blockHash)&&BigInt(Math.floor(now()/1000))-head.timestamp<=60n,'Verification snapshot changed or expired');
  const frontendCandidate={chainId:4663,symbol:c.credit.collateral.toLowerCase()==='0x020bfc650a365f8bb26819deaabf3e21291018b4'?'CASHCAT':'PONS',
    engine:addresses.engine,pool:addresses.pool,collateral:c.credit.collateral,primary:c.credit.primary,secondary:c.credit.secondary,
    hashes:Object.fromEntries(['engine','pool','collateral','primary','secondary','usdg'].map(name=>[name,hashes[name]]))};
  return {chainId:4663,transactionHash:txHash,deploymentBlock:receipt.blockNumber,deploymentBlockHash:receipt.blockHash,
    verificationBlock:head.number,verificationBlockHash:head.hash,configHash:prepared.configHash,initcodeHash:payload.initcodeHash,
    addresses,hashes,frontendCandidate,oracleServices,oracleServicesVerified:oracleServices?.wiringVerified===true,
    keeperCandidate:{KEEPER_MODE:'observe',ISOLATED_ENGINE_ADDRESS:addresses.engine,ISOLATED_ENGINE_CODE_HASH:hashes.engine,
      ISOLATED_POOL_ADDRESS:addresses.pool,ISOLATED_POOL_CODE_HASH:hashes.pool,ISOLATED_COLLATERAL_ADDRESS:c.credit.collateral,
      ISOLATED_COLLATERAL_CODE_HASH:hashes.collateral,ISOLATED_PRIMARY_ORACLE:c.credit.primary,ISOLATED_PRIMARY_CODE_HASH:hashes.primary,
      ISOLATED_SECONDARY_ORACLE:c.credit.secondary,ISOLATED_SECONDARY_CODE_HASH:hashes.secondary,
      ISOLATED_EXIT_ADDRESS:addresses.executor,ISOLATED_EXIT_CODE_HASH:hashes.executor},
    alertsCandidate:{ALERTS_PROTOCOL:'isolated',ALERTS_VAULT_ADDRESS:addresses.engine,ALERTS_VAULT_CODE_HASH:hashes.engine,
      ALERTS_POOL_ADDRESS:addresses.pool,ALERTS_POOL_CODE_HASH:hashes.pool,ALERTS_COLLATERAL_ADDRESS:c.credit.collateral,
      ALERTS_COLLATERAL_CODE_HASH:hashes.collateral,ALERTS_START_BLOCK:String(receipt.blockNumber)},
    deploymentVerified:true,borrowingEnabled:false,productionApproved:false,
    limitations:'Commissioning evidence only. Candidate configurations are not installed. No audit, oracle independence, economic security, funding, operator readiness, alert delivery or public-chain finality claim.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  (async()=>{
    const [file,deployer,txHash,oracleFile,...extra]=process.argv.slice(2);
    demand(file&&deployer&&txHash&&!extra.length&&process.env.COLLATERAL_RPC_URL,'Explicit verification inputs required');
    const input=JSON.parse(await readFile(file,'utf8'));
    const oracle=oracleFile?JSON.parse(await readFile(oracleFile,'utf8')):undefined;
    const artifact=JSON.parse(await readFile(new URL('../out/DockyardIsolatedMarketDeployment.sol/DockyardIsolatedMarketDeployment.json',import.meta.url),'utf8'));
    const childArtifacts=Object.fromEntries(await Promise.all([
      ['engine','DockyardIsolatedCreditEngine'],['pool','DockyardIsolatedCapitalPool'],['executor','DockyardAtomicLiquidator']
    ].map(async ([name,contract])=>[name,JSON.parse(await readFile(new URL(`../out/${contract}.sol/${contract}.json`,import.meta.url),'utf8'))])));
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:20000,retryCount:0}),cacheTime:0});
    const result=await verifyDeployment({input,artifact,childArtifacts,deployer,txHash,client,oracle});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2));
  })().catch(()=>{console.error('Deployment verification failed. No configuration installed and no transaction sent.');process.exitCode=1;});
}
