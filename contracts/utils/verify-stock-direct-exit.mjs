import {decodeEventLog,encodeDeployData,getContractAddress,keccak256,parseAbi} from 'viem';
import {demand,same,nonzeroAddress,freshHead} from './prepare-stock-deployment.mjs';
import {matchCompiledRuntime} from './recompile-collateral.mjs';

// Called from stock commissioning with its verified engine and shared snapshot.
// This verifies deployment/wiring, NOT executable liquidity or profitability.
export async function verifyStockDirectExit({input,artifact,stock,client,head,confirmations,now}){
  const names=['deployer','transactionHash','salePool','factory','poolCodeHash','factoryCodeHash'];
  demand(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===names.length
    &&Object.keys(input).every(k=>names.includes(k)),'Invalid direct exit configuration');
  const deployer=nonzeroAddress(input.deployer),salePool=nonzeroAddress(input.salePool),factory=nonzeroAddress(input.factory);
  for(const key of ['transactionHash','poolCodeHash','factoryCodeHash'])demand(/^0x[0-9a-f]{64}$/i.test(input[key])&&!/^0x0{64}$/i.test(input[key]),'Explicit direct exit hashes required');
  demand(new Set([stock.engine,stock.pool,stock.collateral,stock.usdg,stock.executionGate,salePool,factory].map(a=>a.toLowerCase())).size===7,'Overlapping direct exit dependencies');
  const constructor=artifact?.abi?.find(a=>a.type==='constructor');
  demand(JSON.stringify(constructor?.inputs.map(p=>({type:p.type,name:p.name})))===JSON.stringify([
    {type:'address',name:'engine_'},{type:'address',name:'pool_'},{type:'address',name:'factory_'}]),'Compiled direct exit constructor changed');
  demand(/^0x(?:[0-9a-f]{2})+$/i.test(artifact?.bytecode?.object??'')&&artifact?.deployedBytecode?.object,'Compiled direct exit artifact required');
  const data=encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[stock.engine,salePool,factory]});
  const hash=input.transactionHash;
  const [tx,receipt]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash})]);
  demand(same(tx.hash,hash)&&same(receipt.transactionHash,hash)&&same(tx.from,deployer)&&same(receipt.from,deployer)
    &&tx.to===null&&receipt.to===null&&tx.value===0n&&BigInt(tx.chainId)===4663n&&Number.isSafeInteger(tx.nonce)&&tx.nonce>=0,'Direct exit creation identity mismatch');
  demand(same(keccak256(tx.input),keccak256(data)),'Direct exit initcode mismatch');
  demand(receipt.status==='success'&&receipt.blockNumber!==null&&tx.blockNumber===receipt.blockNumber&&same(tx.blockHash,receipt.blockHash)
    &&receipt.blockNumber>=stock.deploymentBlock&&head.number>=receipt.blockNumber
    &&head.number-receipt.blockNumber+1n>=BigInt(confirmations),'Direct exit receipt not sufficiently confirmed');
  const mined=await client.getBlock({blockNumber:receipt.blockNumber});
  demand(same(mined.hash,receipt.blockHash),'Direct exit receipt is not canonical');
  const executor=getContractAddress({from:deployer,nonce:BigInt(tx.nonce)});
  demand(same(receipt.contractAddress,executor),'Direct exit address mismatch');
  demand(!stock.roles.some(a=>same(a,executor)),'Direct exit cannot own the market or receive protocol fees');
  const read=(address,name,type='address',args=[],inputs='')=>client.readContract({address,abi:parseAbi([
    `function ${name}(${inputs}) view returns(${type})`]),functionName:name,args,blockNumber:head.number});
  const code=await client.getCode({address:executor,blockNumber:head.number});
  matchCompiledRuntime(artifact.deployedBytecode.object,code,artifact.deployedBytecode.immutableReferences);
  for(const [address,expected] of [[salePool,input.poolCodeHash],[factory,input.factoryCodeHash]]){
    const runtime=await client.getCode({address,blockNumber:head.number});
    demand(runtime&&runtime!=='0x'&&same(keccak256(runtime),expected),'Direct exit dependency runtime mismatch');
  }
  for(const [key,expected] of Object.entries({engine:stock.engine,usdg:stock.usdg,collateral:stock.collateral,executionGate:stock.executionGate,salePool,factory})){
    demand(same(await read(executor,key),expected),'Direct exit binding mismatch');
  }
  for(const [key,expected] of Object.entries({engineCodeHash:stock.hashes.engine,usdgCodeHash:stock.hashes.usdg,
    collateralCodeHash:stock.hashes.collateral,gateCodeHash:stock.hashes.executionGate,poolCodeHash:input.poolCodeHash,factoryCodeHash:input.factoryCodeHash})){
    demand(same(await read(executor,key,'bytes32'),expected),'Direct exit runtime pin mismatch');
  }
  const fee=await read(executor,'poolFee','uint24');
  demand(await read(salePool,'fee','uint24')===fee&&same(await read(salePool,'factory'),factory)
    &&same(await read(factory,'getPool','address',[stock.collateral,stock.usdg,fee],'address,address,uint24'),salePool),'Direct exit pool registration mismatch');
  demand(await read(executor,'routeHealthy','bool')===true,'Direct exit route not healthy');
  for(const token of [stock.usdg,stock.collateral]){
    demand(await read(token,'balanceOf','uint256',[executor],'address')===0n,'Unexpected direct exit funds');
  }
  demand(await read(stock.usdg,'allowance','uint256',[executor,stock.engine],'address,address')===0n,'Unexpected direct exit allowance');
  // A matching creation receipt does not need a fabricated LiquidationExited
  // event. The actual sale is covered separately by keeper/fork execution tests.
  demand(!receipt.logs.some(log=>{
    if(!same(log.address,executor))return false;
    try{return decodeEventLog({abi:artifact.abi,data:log.data,topics:log.topics}).eventName==='LiquidationExited';}catch{return false;}
  }),'Unexpected sale in creation receipt');
  demand(same((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash),'Direct exit block changed');
  freshHead(head,now);
  return {kind:'stock-direct-v3',executor,executorCodeHash:keccak256(code),salePool,poolCodeHash:input.poolCodeHash,
    factory,factoryCodeHash:input.factoryCodeHash,poolFee:fee,transactionHash:hash,deploymentBlock:receipt.blockNumber,
    deploymentBlockHash:receipt.blockHash,initcodeHash:keccak256(data),wiringVerified:true,liquidityVerified:false};
}
