import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createPublicClient, encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, http, keccak256, parseAbiParameters} from 'viem';

export const configParameter = parseAbiParameters(`(
  uint256 chainId, uint256 deadline,
  (address usdg, address collateral, address primary, address secondary, address guardian,
   uint256 staleness, uint16 maxLtvBps, uint16 liquidationLtvBps, uint16 bonusBps,
   uint16 deviationBps, uint256 minimumDebt) credit,
  address treasury, uint256 debtLimit, uint16 revenueFeeBps, uint16 borrowAprBps,
  address intermediate, address firstPool, address secondPool, address factory,
  (bytes32 usdg, bytes32 collateral, bytes32 primary, bytes32 secondary,
   bytes32 intermediate, bytes32 firstPool, bytes32 secondPool, bytes32 factory) pins
) c`.replace(/\s+/g,' ').replace(/\(\s/g,'(').replace(/\s\)/g,')'))[0];

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const COLLATERALS = new Set(['0x020bfc650a365f8bb26819deaabf3e21291018b4','0x39dbed3a2bd333467115de45665cc57f813c4571']);
const ZERO = '0x'+'0'.repeat(40);
const ZERO_HASH = '0x'+'0'.repeat(64);

function address(value) {
  if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value)||value.toLowerCase()===ZERO)throw Error('Invalid nonzero address');
  return getAddress(value);
}

function normalize(parameter,value) {
  if(parameter.type==='tuple') {
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Configuration object required');
    const names=parameter.components.map(p=>p.name);
    if(Object.keys(value).length!==names.length||Object.keys(value).some(k=>!names.includes(k)))throw Error('Missing or unexpected configuration fields');
    return Object.fromEntries(parameter.components.map(p=>[p.name,normalize(p,value[p.name])]));
  }
  if(parameter.type==='address')return address(value);
  if(parameter.type==='bytes32') {
    if(typeof value!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(value)||value.toLowerCase()===ZERO_HASH)throw Error('Nonzero runtime pin required');
    return value.toLowerCase();
  }
  if(!/^uint(?:16|256)$/.test(parameter.type)||typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value))throw Error('Integer fields require canonical decimal strings');
  const integer=BigInt(value);
  if(integer>=(1n<<BigInt(parameter.type.slice(4))))throw Error('Integer outside ABI range');
  return integer;
}

export function encodeConfiguration(input) {
  const c=normalize(configParameter,input), r=c.credit;
  if(c.chainId!==4663n||r.usdg.toLowerCase()!==USDG||!COLLATERALS.has(r.collateral.toLowerCase()))throw Error('Unsupported market');
  if(r.primary===r.secondary||c.firstPool===c.secondPool||[r.usdg,r.collateral].includes(c.intermediate))throw Error('Overlapping dependencies');
  if(r.staleness===0n||r.minimumDebt===0n||c.debtLimit===0n||c.debtLimit<r.minimumDebt||
    r.maxLtvBps===0n||r.maxLtvBps>=r.liquidationLtvBps||r.liquidationLtvBps>=10000n||
    r.bonusBps>1500n||r.deviationBps===0n||r.deviationBps>2500n||
    r.liquidationLtvBps*(10000n+r.bonusBps)>=100000000n||c.revenueFeeBps>2000n||c.borrowAprBps>10000n)throw Error('Invalid risk or capital parameters');
  const encoded=encodeAbiParameters([configParameter],[c]);
  return {config:c,encoded,configHash:keccak256(encoded)};
}

const shape=p=>({name:p.name,type:p.type,...(p.components?{components:p.components.map(shape)}:{})});

export function deploymentData(prepared,artifact) {
  const constructor=artifact?.abi?.find(p=>p.type==='constructor');
  if(!constructor||JSON.stringify(constructor.inputs.map(shape))!==JSON.stringify([
    shape(configParameter),{name:'expectedConfigHash',type:'bytes32'}
  ]))throw Error('Compiled constructor ABI changed');
  const bytecode=artifact?.bytecode?.object;
  if(typeof bytecode!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode))throw Error('Compiled creation bytecode required');
  const data=encodeDeployData({abi:artifact.abi,bytecode,args:[prepared.config,prepared.configHash]});
  if((data.length-2)/2>49152)throw Error('Deployment exceeds initcode limit');
  return {data,initcodeHash:keccak256(data)};
}

/** Read-only constructor simulation. This does not approve pricing, parameters or release. */
export async function preflightDeployment({input,artifact,deployer,client,now=()=>Date.now()}) {
  const prepared=encodeConfiguration(input), c=prepared.config;
  deployer=address(deployer);
  const payload=deploymentData(prepared,artifact);
  if(await client.getChainId()!==4663)throw Error('Wrong RPC chain');
  const block=await client.getBlock();
  const wall=BigInt(Math.floor(now()/1000));
  if(!block.hash||block.number===null||block.timestamp>wall+15n||wall-block.timestamp>60n)throw Error('RPC head is not fresh');
  if(c.deadline<block.timestamp||c.deadline>block.timestamp+86400n)throw Error('Deployment deadline is not valid');
  const dependencies={usdg:c.credit.usdg,collateral:c.credit.collateral,primary:c.credit.primary,
    secondary:c.credit.secondary,intermediate:c.intermediate,firstPool:c.firstPool,secondPool:c.secondPool,factory:c.factory};
  await Promise.all(Object.entries(dependencies).map(async ([key,target])=>{
    const code=await client.getCode({address:target,blockNumber:block.number});
    if(!code||code==='0x'||keccak256(code)!==c.pins[key])throw Error('Dependency runtime mismatch');
  }));
  const nonce=await client.getTransactionCount({address:deployer,blockNumber:block.number});
  if(await client.getTransactionCount({address:deployer,blockTag:'pending'})!==nonce)throw Error('Deployer has pending transactions');
  const receipt=getContractAddress({from:deployer,nonce:BigInt(nonce)});
  const predicted={receipt,engine:getContractAddress({from:receipt,nonce:1n}),pool:getContractAddress({from:receipt,nonce:2n}),executor:getContractAddress({from:receipt,nonce:3n})};
  if(Object.values(predicted).some(a=>[c.credit.guardian,c.treasury].includes(a)))throw Error('Internal guardian or treasury recipient');
  const gasEstimate=await client.estimateGas({account:deployer,data:payload.data,blockNumber:block.number});
  const gasLimit=(gasEstimate*120n+99n)/100n;
  if(gasEstimate<=0n||gasLimit>block.gasLimit)throw Error('Deployment gas exceeds block capacity');
  const canonical=await client.getBlock({blockNumber:block.number});
  if(canonical.hash!==block.hash||BigInt(Math.floor(now()/1000))-block.timestamp>60n)throw Error('Snapshot changed or expired during preflight');
  if(await client.getTransactionCount({address:deployer,blockTag:'pending'})!==nonce)throw Error('Deployer nonce changed during preflight');
  return {chainId:4663,blockNumber:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,
    deployer,nonce,predicted,configHash:prepared.configHash,initcodeHash:payload.initcodeHash,
    gasEstimate,gasLimit,encodedConfiguration:prepared.encoded,deadline:c.deadline,
    deploymentSimulationPassed:true,borrowingEnabled:false,productionApproved:false,
    scope:'Read-only simulation at one block. Predicted addresses require this deployer nonce; repeat immediately before broadcast. Does not verify audits, source independence, proxy implementation controls, funding or full transaction fees.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  (async()=>{
    const [configFile,deployer,...extra]=process.argv.slice(2);
    if(!configFile||!deployer||extra.length||!process.env.COLLATERAL_RPC_URL)throw Error('Explicit inputs required');
    const input=JSON.parse(await readFile(configFile,'utf8'));
    const artifact=JSON.parse(await readFile(new URL('../out/DockyardIsolatedMarketDeployment.sol/DockyardIsolatedMarketDeployment.json',import.meta.url),'utf8'));
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:20000,retryCount:0}),cacheTime:0});
    const result=await preflightDeployment({input,artifact,deployer,client});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  })().catch(()=>{console.error('Isolated deployment preflight failed. Check explicit config, compiled artifact and current chain state. No transaction was sent.');process.exitCode=1;});
}
