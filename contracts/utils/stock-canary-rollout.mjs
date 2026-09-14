import {readFileSync} from 'node:fs';
import {createPublicClient,http,encodeDeployData,getContractAddress,keccak256,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {encodeStockConfiguration,stockDeploymentData,stockDependencies,preflightStockDeployment} from './prepare-stock-deployment.mjs';
import {matchCompiledRuntime} from './recompile-collateral.mjs';

export const CANARY=Object.freeze({chainId:4663,
  owner:'0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086',
  guardian:'0x81Cfef2D90007B13A5C3FCd52d1B5b51165d4Fe8',
  keeper:'0xACcCD0d5826eea3d1170d54c3c1cf3C771748A6F',
  usdg:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  collateral:'0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  stockFeed:'0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
  usdgPrimary:'0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
  usdgSecondary:'0x76850ffD6652FCb5DfD7ECBD359323d82395fF8d',
  salePool:'0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D',
  factory:'0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
});
const check=(v,message)=>{if(!v)throw Error(message);};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
export const artifact=name=>JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`,import.meta.url)));
export const kinds=Object.freeze({guard:'DockyardHeartbeatGuard',gate:'DockyardExecutionGate',market:'DockyardStockMarketDeployment',exit:'DockyardStockDirectLiquidator'});
export function payload(plan){
  check(kinds[plan.kind]&&plan.chainId===4663,'Unknown deployment step');
  const a=artifact(kinds[plan.kind]);
  return {artifact:a,data:plan.kind==='market'?stockDeploymentData(encodeStockConfiguration(plan.input),a).data:
    encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args:plan.args})};
}
export async function prepareStep(client,kind,previous={}){
  check(kinds[kind]&&await client.getChainId()===4663,'Wrong deployment step or chain');
  const head=await client.getBlock(),now=BigInt(Math.floor(Date.now()/1000));
  check(head.timestamp<=now+15n&&now-head.timestamp<=60n,'RPC head stale');
  const nonce=await client.getTransactionCount({address:CANARY.owner,blockNumber:head.number});
  check(await client.getTransactionCount({address:CANARY.owner,blockTag:'pending'})===nonce,'Pending owner transaction');
  const plan={kind,chainId:4663,deployer:CANARY.owner,nonce,address:getContractAddress({from:CANARY.owner,nonce:BigInt(nonce)}),
    block:String(head.number),blockHash:head.hash,preparedAt:String(head.timestamp),deadline:String(head.timestamp+600n)};
  check(!await client.getCode({address:plan.address,blockNumber:head.number}),'Address occupied');
  if(kind==='guard')plan.args=[CANARY.collateral,CANARY.stockFeed,CANARY.guardian,86400];
  if(kind==='gate')plan.args=[CANARY.guardian];
  if(kind==='market'){
    check(previous.guard&&previous.gate,'Missing dedicated guard and gate');
    plan.input={chainId:'4663',deadline:plan.deadline,credit:{usdg:CANARY.usdg,collateral:CANARY.collateral,
      primary:CANARY.stockFeed,secondary:previous.guard,guardian:CANARY.owner,staleness:'86400',
      maxLtvBps:'3000',liquidationLtvBps:'4000',bonusBps:'500',deviationBps:'200',minimumDebt:'1000000'},
      executionGate:previous.gate,usdgPricing:{primary:CANARY.usdgPrimary,secondary:CANARY.usdgSecondary,
        primaryMaxAge:'90000',secondaryMaxAge:'90000',maxDeviationBps:'200',maxTimestampSkew:'90000'},
      treasury:CANARY.owner,debtLimit:'50000000',revenueFeeBps:'1000',borrowAprBps:'1000',pins:{}};
    for(const [name,address] of Object.entries(stockDependencies(plan.input))){
      const code=await client.getCode({address,blockNumber:head.number});check(code&&code!=='0x','Missing market dependency');plan.input.pins[name]=keccak256(code);
    }
    const p=await preflightStockDeployment({client,input:plan.input,artifact:artifact(kinds.market),deployer:CANARY.owner});
    check(p.nonce===nonce,'Nonce changed during market preparation');plan.predicted=p.predicted;
  }
  if(kind==='exit'){
    check(previous.engine,'Missing verified stock engine');plan.args=[previous.engine,CANARY.salePool,CANARY.factory];
  }
  const {artifact:a,data}=payload(plan);
  const simulated=await client.call({account:CANARY.owner,data,value:0n,blockNumber:head.number});
  const runtime=matchCompiledRuntime(a.deployedBytecode.object,simulated.data,a.deployedBytecode.immutableReferences);
  const estimate=await client.estimateGas({account:CANARY.owner,data,value:0n,blockNumber:head.number});
  const gas=(estimate*125n+99n)/100n,gasPrice=(await client.getGasPrice())*110n/100n;
  const maxFee=gas*gasPrice,balance=await client.getBalance({address:CANARY.owner});
  check(maxFee<=5000000000000000n&&balance>=maxFee+1000000000000000n,'Gas budget or owner reserve exceeded');
  check(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'Snapshot changed');
  return {...plan,initcodeHash:keccak256(data),simulatedRuntimeHash:runtime.runtimeCodeHash,
    gas:String(gas),gasPrice:String(gasPrice),maximumFeeWei:String(maxFee),borrowingEnabled:false};
}
export async function signIntent(plan,key){
  const account=privateKeyToAccount(key);check(same(account.address,CANARY.owner)&&same(plan.deployer,CANARY.owner),'Wrong deployer');
  const {data}=payload(plan);check(keccak256(data)===plan.initcodeHash,'Creation artifact changed');
  const raw=await account.signTransaction({chainId:4663,type:'legacy',nonce:plan.nonce,data,value:0n,gas:BigInt(plan.gas),gasPrice:BigInt(plan.gasPrice)});
  return {raw,hash:keccak256(raw)};
}
export async function broadcastStep(client,plan,key){
  check(await client.getChainId()===4663,'Wrong broadcast chain');
  const {raw,hash}=await signIntent(plan,key);check(hash===plan.transactionHash,'Intent hash changed');
  let receipt=await client.getTransactionReceipt({hash}).catch(()=>null);
  if(!receipt){
    const head=await client.getBlock();check(head.timestamp<=BigInt(plan.deadline),'Deployment intent expired');
    check(await client.getTransactionCount({address:CANARY.owner,blockTag:'pending'})===plan.nonce,'Owner nonce changed');
    const {artifact:a,data}=payload(plan),sim=await client.call({account:CANARY.owner,data,value:0n});
    check(keccak256(sim.data)===plan.simulatedRuntimeHash,'Constructor result changed');
    matchCompiledRuntime(a.deployedBytecode.object,sim.data,a.deployedBytecode.immutableReferences);
    check(await client.getBalance({address:CANARY.owner})>=BigInt(plan.maximumFeeWei)+1000000000000000n,'Owner reserve low');
    check(await client.sendRawTransaction({serializedTransaction:raw})===hash,'Broadcast hash differs');
  }
  receipt=await client.waitForTransactionReceipt({hash,confirmations:2,timeout:45000});
  const tx=await client.getTransaction({hash}),code=await client.getCode({address:plan.address});
  check(receipt.status==='success'&&same(receipt.contractAddress,plan.address)&&tx.to===null&&tx.value===0n
    &&same(tx.from,CANARY.owner)&&tx.nonce===plan.nonce&&keccak256(tx.input)===plan.initcodeHash,'Unexpected mined creation');
  check(keccak256(code)===plan.simulatedRuntimeHash,'Runtime differs from simulation');
  check(same((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash),'Receipt reorg');
  const gasCost=receipt.gasUsed*receipt.effectiveGasPrice;check(gasCost<=BigInt(plan.maximumFeeWei),'Fee exceeded prepared bound');
  return {...plan,status:'receipt-runtime-verified',minedBlock:String(receipt.blockNumber),gasCostWei:String(gasCost),runtimeCodeHash:keccak256(code)};
}
export const publicClient=()=>createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com',{timeout:20000,retryCount:0}),cacheTime:0,pollingInterval:1500});
