import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPublicClient,encodeAbiParameters,encodeDeployData,getAddress,getContractAddress,http,keccak256,parseAbi,parseAbiParameters} from 'viem';
import {inspectUsdgSourceIdentity} from './inspect-stock-usdg.mjs';

// Identity allowlist only. Pilot risk settings and activation status are NOT
// inherited. Live source quality and permission to use the data remain separate.
const catalog=JSON.parse(readFileSync(new URL('./assets/dockyard-pilot-heartbeat-config.json',import.meta.url)));
export const stockIdentities=Object.freeze(catalog.markets.map(m=>Object.freeze({symbol:m.symbol,
  collateral:getAddress(m.collateral),primary:getAddress(m.primaryOracle)})));
export const USDG=getAddress(catalog.usdg);
export const stockConfigParameter=parseAbiParameters(`(
  uint256 chainId, uint256 deadline,
  (address usdg, address collateral, address primary, address secondary, address guardian,
   uint256 staleness, uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 bonusBps,
   uint16 deviationBps, uint256 minimumDebt) credit,
  address executionGate,
  (address primary, address secondary, uint32 primaryMaxAge, uint32 secondaryMaxAge, uint16 maxDeviationBps, uint32 maxTimestampSkew) usdgPricing,
  address treasury, uint256 debtLimit, uint16 revenueFeeBps, uint16 borrowAprBps,
  (bytes32 usdg, bytes32 collateral, bytes32 stockFeed, bytes32 stockGuard,
   bytes32 executionGate, bytes32 usdgPrimary, bytes32 usdgSecondary) pins
) c`.replace(/\s+/g,' ').replace(/\(\s/g,'(').replace(/\s\)/g,')'))[0];
export const demand=(condition,message)=>{if(!condition)throw Error(message);};
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export function nonzeroAddress(value){
  demand(typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!/^0x0{40}$/.test(value),'Nonzero address required');
  return getAddress(value);
}
function normalize(p,value){
  if(p.type==='tuple'){
    demand(value&&typeof value==='object'&&!Array.isArray(value),'Configuration object required');
    const names=p.components.map(p=>p.name);
    demand(Object.keys(value).length===names.length&&Object.keys(value).every(k=>names.includes(k)),'Missing or unexpected configuration fields');
    return Object.fromEntries(p.components.map(p=>[p.name,normalize(p,value[p.name])]));
  }
  if(p.type==='address')return nonzeroAddress(value);
  if(p.type==='bytes32'){
    demand(typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value)&&!/^0x0{64}$/.test(value),'Nonzero runtime pin required');
    return value.toLowerCase();
  }
  demand(/^uint(16|32|256)$/.test(p.type)&&typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value),'Integer fields require canonical decimal strings');
  const n=BigInt(value);demand(n<1n<<BigInt(p.type.slice(4)),'Integer outside ABI range');return n;
}
export const stockDependencies=c=>({usdg:c.credit.usdg,collateral:c.credit.collateral,stockFeed:c.credit.primary,
  stockGuard:c.credit.secondary,executionGate:c.executionGate,usdgPrimary:c.usdgPricing.primary,usdgSecondary:c.usdgPricing.secondary});
export function encodeStockConfiguration(input){
  const c=normalize(stockConfigParameter,input),r=c.credit,u=c.usdgPricing;
  const identity=stockIdentities.find(m=>same(m.collateral,r.collateral)&&same(m.primary,r.primary));
  demand(c.chainId===4663n&&same(r.usdg,USDG)&&identity,'Unsupported stock or canonical feed pairing');
  const deps=Object.values(stockDependencies(c));
  demand(new Set(deps.map(a=>a.toLowerCase())).size===deps.length,'Overlapping dependencies');
  demand(!deps.some(a=>same(a,r.guardian)||same(a,c.treasury)),'Dependency cannot control market or receive fees');
  demand(r.staleness>=60n&&r.staleness<=86400n&&r.deviationBps===200n&&r.minimumDebt>0n
    &&c.debtLimit>=r.minimumDebt&&r.maxLtvBps>0n&&r.maxLtvBps<r.liquidationLtvBps&&r.liquidationLtvBps<10000n
    &&r.bonusBps<=1500n&&r.liquidationLtvBps*(10000n+r.bonusBps)<100000000n
    &&c.revenueFeeBps<=2000n&&c.borrowAprBps<=10000n,'Invalid risk or capital parameters');
  demand(u.primaryMaxAge>0n&&u.primaryMaxAge<=90000n&&u.secondaryMaxAge>0n&&u.secondaryMaxAge<=90000n
    &&u.maxTimestampSkew>0n&&u.maxTimestampSkew<=(u.primaryMaxAge>u.secondaryMaxAge?u.primaryMaxAge:u.secondaryMaxAge)
    &&u.maxDeviationBps>0n&&u.maxDeviationBps<=200n,'Invalid USDG pricing parameters');
  const encoded=encodeAbiParameters([stockConfigParameter],[c]);
  return {config:c,symbol:identity.symbol,encoded,configHash:keccak256(encoded)};
}
const shape=p=>({name:p.name,type:p.type,...(p.components?{components:p.components.map(shape)}:{})});
export function stockDeploymentData(prepared,artifact){
  const constructor=artifact?.abi?.find(p=>p.type==='constructor');
  demand(constructor&&JSON.stringify(constructor.inputs.map(shape))===JSON.stringify([
    shape(stockConfigParameter),{name:'expectedHash',type:'bytes32'}]),'Compiled stock constructor ABI changed');
  const bytecode=artifact?.bytecode?.object;
  demand(typeof bytecode==='string'&&/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode),'Compiled creation bytecode required');
  const data=encodeDeployData({abi:artifact.abi,bytecode,args:[prepared.config,prepared.configHash]});
  demand((data.length-2)/2<=49152,'Deployment exceeds initcode limit');
  return {data,initcodeHash:keccak256(data)};
}
export const predictedStockAddresses=(deployer,nonce)=>{
  const bundle=getContractAddress({from:deployer,nonce:BigInt(nonce)});
  return {bundle,engine:getContractAddress({from:bundle,nonce:1n}),pool:getContractAddress({from:bundle,nonce:2n})};
};
export function freshHead(block,now){
  const wall=BigInt(Math.floor(now()/1000));
  demand(block.hash&&block.number!==null&&block.timestamp<=wall+15n&&wall-block.timestamp<=60n,'RPC head is not fresh');
}
/** Simulation only: never signs, funds, unpauses or writes a service configuration. */
export async function preflightStockDeployment({input,artifact,deployer,client,now=()=>Date.now()}){
  const prepared=encodeStockConfiguration(input),c=prepared.config,payload=stockDeploymentData(prepared,artifact);
  deployer=nonzeroAddress(deployer);
  demand(await client.getChainId()===4663,'Wrong RPC chain');
  const block=await client.getBlock();freshHead(block,now);
  demand(c.deadline>=block.timestamp&&c.deadline<=block.timestamp+86400n,'Deployment deadline is not valid');
  await Promise.all(Object.entries(stockDependencies(c)).map(async([key,address])=>{
    const code=await client.getCode({address,blockNumber:block.number});
    demand(code&&code!=='0x'&&same(keccak256(code),c.pins[key]),'Dependency runtime mismatch');
  }));
  const usdgSourceIdentity=await inspectUsdgSourceIdentity({client,primary:c.usdgPricing.primary,secondary:c.usdgPricing.secondary,blockNumber:block.number});
  demand(!usdgSourceIdentity.knownAlias,'USDG feeds share an exposed oracle dependency');
  const nonce=await client.getTransactionCount({address:deployer,blockNumber:block.number});
  demand(Number.isSafeInteger(nonce)&&nonce>=0,'Invalid deployer nonce');
  demand(await client.getTransactionCount({address:deployer,blockTag:'pending'})===nonce,'Deployer has pending transactions');
  const predicted=predictedStockAddresses(deployer,nonce);
  demand(!Object.values(predicted).some(a=>same(a,c.credit.guardian)||same(a,c.treasury)||Object.values(stockDependencies(c)).some(b=>same(a,b))),'Internal recipient or dependency');
  const guardian=await client.readContract({address:c.credit.secondary,abi:parseAbi(['function guardian() view returns(address)']),functionName:'guardian',blockNumber:block.number});
  nonzeroAddress(guardian);
  demand(!same(guardian,c.credit.guardian)&&!Object.values({...predicted,...stockDependencies(c)}).some(a=>same(a,guardian)),'Risk guardian must be separate from owner and dependencies');
  const gasEstimate=await client.estimateGas({account:deployer,data:payload.data,blockNumber:block.number});
  const gasLimit=(gasEstimate*120n+99n)/100n;
  demand(gasEstimate>0n&&gasLimit<=block.gasLimit,'Deployment gas exceeds block capacity');
  const canonical=await client.getBlock({blockNumber:block.number});
  demand(same(canonical.hash,block.hash),'Snapshot changed during preflight');freshHead(block,now);
  demand(await client.getTransactionCount({address:deployer,blockTag:'pending'})===nonce,'Deployer nonce changed during preflight');
  return {chainId:4663,symbol:prepared.symbol,blockNumber:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,
    deployer,nonce,predicted,guardian,configHash:prepared.configHash,initcodeHash:payload.initcodeHash,
    gasEstimate,gasLimit,encodedConfiguration:prepared.encoded,deadline:c.deadline,
    usdgSourceIdentity,deploymentSimulationPassed:true,borrowingEnabled:false,productionApproved:false,
    limitations:'Read-only constructor simulation. Repeat immediately before broadcast. Does not qualify feeds, liquidity, service readiness, audits, proxy upgrades, funding or full transaction fees.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    const [file,deployer,...extra]=process.argv.slice(2);
    demand(file&&deployer&&!extra.length&&process.env.COLLATERAL_RPC_URL,'Explicit inputs required');
    const input=JSON.parse(await readFile(file,'utf8'));
    const artifact=JSON.parse(await readFile(new URL('../out/DockyardStockMarketDeployment.sol/DockyardStockMarketDeployment.json',import.meta.url),'utf8'));
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:20000,retryCount:0}),cacheTime:0});
    console.log(JSON.stringify(await preflightStockDeployment({input,artifact,deployer,client}),(_,v)=>typeof v==='bigint'?String(v):v,2));
  })().catch(()=>{console.error('Stock deployment preflight failed. Check explicit configuration, artifact and chain state. No transaction sent.');process.exitCode=1;});
}
