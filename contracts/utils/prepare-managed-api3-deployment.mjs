import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPublicClient,http,encodeDeployData,getAddress,getContractAddress,keccak256,parseAbi,toHex} from 'viem';
import {MANAGED_API3_USDG as cfg} from './inspect-api3-managed.mjs';
import {inspectChainlinkApi3} from './inspect-chainlink-api3.mjs';
import {matchCompiledRuntime} from './recompile-collateral.mjs';

const demand=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const MAX_FEE=2000000000000000n; // 0.002 ETH hard preparation ceiling, gas only.
const RESERVE=1000000000000000n; // Do not consume the owner's last gas reserve.
export function managedApi3Creation(artifact){
  const constructor=artifact?.abi?.find(x=>x.type==='constructor');
  demand(JSON.stringify(constructor?.inputs?.map(x=>x.type))===JSON.stringify(['address','bytes32','uint32']), 'Unexpected API3 constructor');
  demand(/^0x[0-9a-f]+$/i.test(artifact?.bytecode?.object??''),'Missing creation artifact');
  demand(/^0x[0-9a-f]+$/i.test(artifact?.deployedBytecode?.object??''),'Missing runtime artifact');
  return encodeDeployData({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[cfg.server,cfg.serverCodeHash,90000]});
}
export async function prepareManagedApi3Deployment({client,artifact,deployer,now=Date.now}){
  deployer=getAddress(deployer);
  demand(!/^0x0{40}$/i.test(deployer),'Nonzero deployer required');
  const oracle=await inspectChainlinkApi3({client,now});
  demand(oracle.pricing.engineRoundChecksPassed,'USDG source checks failed');
  const blockNumber=oracle.blockNumber,data=managedApi3Creation(artifact);
  const nonce=await client.getTransactionCount({address:deployer,blockNumber});
  demand(await client.getTransactionCount({address:deployer,blockTag:'pending'})===nonce,'Pending deployer transactions');
  const address=getContractAddress({from:deployer,nonce:BigInt(nonce)});
  demand(!await client.getCode({address,blockNumber}),'Predicted deployment already exists');
  const simulated=await client.call({account:deployer,data,value:0n,blockNumber});
  const runtime=matchCompiledRuntime(artifact.deployedBytecode.object,simulated.data,artifact.deployedBytecode.immutableReferences);
  const gasEstimate=await client.estimateGas({account:deployer,data,value:0n,blockNumber});
  const gas=(gasEstimate*125n+99n)/100n;
  const gasPrice=await client.getGasPrice(),balance=await client.getBalance({address:deployer,blockNumber});
  const fee=gas*gasPrice;
  demand(gasEstimate>0n&&gasPrice>0n&&fee<=MAX_FEE&&balance>=fee+RESERVE,'Deployment fee or balance outside budget');
  const head=await client.getBlock({blockNumber});
  const wall=BigInt(Math.floor(now()/1000));
  demand(same(head.hash,oracle.blockHash)&&head.timestamp<=wall+15n&&wall-head.timestamp<=60n,'Deployment snapshot expired or changed');
  demand(await client.getTransactionCount({address:deployer,blockTag:'pending'})===nonce,'Deployer nonce changed');
  return {kind:'managed-api3-read-only-adapter',chainId:4663,deployer,nonce,predictedAddress:address,
    blockNumber,blockHash:head.hash,preparedAt:head.timestamp,validUntil:head.timestamp+300n,
    initcodeHash:keccak256(data),simulatedRuntimeHash:runtime.runtimeCodeHash,
    maximumTransactionFeeWei:fee,maximumAllowedFeeWei:MAX_FEE,
    transaction:{from:deployer,data,value:'0x0',chainId:'0x1237',nonce:toHex(nonce),gas:toHex(gas),gasPrice:toHex(gasPrice)},
    broadcast:false,borrowingEnabled:false,productionApproved:false,
    note:'Unsigned gas-only creation. Re-run preflight immediately before signing; verify mined receipt and immutable bindings afterward. No token approvals, funding or protocol activation.'};
}

const abi=parseAbi(['function server() view returns(address)','function serverCodeHash() view returns(bytes32)',
  'function MAX_AGE() view returns(uint32)','function DATA_FEED_ID() view returns(bytes32)',
  'function decimals() view returns(uint8)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
export async function verifyManagedApi3Deployment({client,artifact,plan,transactionHash}){
  demand(await client.getChainId()===4663,'Wrong receipt chain');
  const [tx,receipt,head]=await Promise.all([client.getTransaction({hash:transactionHash}),client.getTransactionReceipt({hash:transactionHash}),client.getBlock()]);
  demand(receipt.status==='success'&&receipt.to===null&&tx.to===null&&tx.value===0n&&Number(tx.chainId)===4663,'Not successful gas-only creation');
  demand(same(tx.from,plan.deployer)&&tx.nonce===plan.nonce&&same(tx.input,managedApi3Creation(artifact))
    &&same(keccak256(tx.input),plan.initcodeHash),'Creation differs from prepared transaction');
  demand(same(tx.hash,transactionHash)&&same(receipt.transactionHash,transactionHash)
    &&same(receipt.from,plan.deployer)&&same(tx.blockHash,receipt.blockHash)&&tx.blockNumber===receipt.blockNumber,'Transaction/receipt identity mismatch');
  demand(same(receipt.contractAddress,plan.predictedAddress)
    &&same(plan.predictedAddress,getContractAddress({from:plan.deployer,nonce:BigInt(plan.nonce)}))
    &&head.number>=receipt.blockNumber+1n,'Address mismatch or fewer than two confirmations');
  const mined=await client.getBlock({blockNumber:receipt.blockNumber});
  demand(same(mined.hash,receipt.blockHash),'Receipt reorg');
  demand(mined.timestamp>=BigInt(plan.preparedAt)&&mined.timestamp<=BigInt(plan.validUntil),'Deployment outside prepared time window');
  demand(receipt.gasUsed*receipt.effectiveGasPrice<=BigInt(plan.maximumTransactionFeeWei),'Deployment exceeded prepared fee');
  const code=await client.getCode({address:plan.predictedAddress,blockNumber:head.number});
  const runtime=matchCompiledRuntime(artifact.deployedBytecode.object,code,artifact.deployedBytecode.immutableReferences);
  demand(same(runtime.runtimeCodeHash,plan.simulatedRuntimeHash),'Runtime differs from simulated constructor');
  const read=functionName=>client.readContract({address:plan.predictedAddress,abi,functionName,blockNumber:head.number});
  demand(same(await read('server'),cfg.server)&&same(await read('serverCodeHash'),cfg.serverCodeHash)
    &&same(await read('DATA_FEED_ID'),cfg.dataFeedId)&&Number(await read('MAX_AGE'))===90000
    &&Number(await read('decimals'))===18,'Adapter immutable bindings differ');
  demand(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'Verification snapshot changed');
  return {chainId:4663,address:plan.predictedAddress,transactionHash,blockNumber:receipt.blockNumber,
    runtimeCodeHash:runtime.runtimeCodeHash,adapterDeploymentVerified:true,borrowingEnabled:false,productionApproved:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    demand(process.argv.length===3&&process.env.COLLATERAL_RPC_URL,'Explicit deployer and RPC required');
    const artifact=JSON.parse(await readFile(new URL('../out/DockyardApi3ManagedUsdgFeed.sol/DockyardApi3ManagedUsdgFeed.json',import.meta.url),'utf8'));
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:15000,retryCount:0}),cacheTime:0});
    console.log(JSON.stringify(await prepareManagedApi3Deployment({client,artifact,deployer:process.argv[2]}),(_,v)=>typeof v==='bigint'?String(v):v,2));
  })().catch(()=>{console.error('API3 deployment preparation failed; no transaction sent.');process.exitCode=1;});
}
