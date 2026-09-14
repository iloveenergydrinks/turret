import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createPublicClient,http,keccak256,stringToHex,parseAbi} from 'viem';

export class RuntimeMismatchError extends Error {
  constructor(verification) {
    super('Runtime mismatch outside compiler-declared immutables');
    this.name='RuntimeMismatchError';
    this.verification=verification;
  }
}

export function matchCompiledRuntime(compiled,chainCode,references={}) {
  const normalize=s=>String(s).replace(/^0x/,'').toLowerCase();
  const a=normalize(compiled),b=normalize(chainCode);
  if(!/^(?:[0-9a-f]{2})+$/.test(a)||!/^(?:[0-9a-f]{2})+$/.test(b)||a.length!==b.length)throw new Error('Invalid or unequal runtime lengths');
  const occupied=new Set(),values={};
  const patched=a.split('');
  for(const [id,ranges] of Object.entries(references)) {
    if(!Array.isArray(ranges)||ranges.length===0)throw new Error('Empty immutable reference');
    let value;
    for(const {start,length} of ranges) {
      if(!Number.isSafeInteger(start)||start<0||length!==32||start+length>a.length/2)throw new Error('Invalid immutable range');
      const actual=b.slice(start*2,(start+length)*2);
      if(value!==undefined&&value!==actual)throw new Error('Inconsistent immutable copies');
      value=actual;
      for(let i=start*2;i<(start+length)*2;i++) {
        if(occupied.has(i))throw new Error('Overlapping immutable references');
        occupied.add(i);patched[i]=b[i];
      }
    }
    values[id]='0x'+value;
  }
  const mismatchedByteOffsets=[];
  for(let i=0;i<b.length;i+=2)if(patched[i]+patched[i+1]!==b.slice(i,i+2))mismatchedByteOffsets.push(i/2);
  const verification={runtimeBytes:b.length/2,runtimeCodeHash:keccak256('0x'+b),immutableValues:values,
    match:mismatchedByteOffsets.length?'mismatch':'exact-except-locally-compiled-immutable-slots',
    metadataIgnored:false,mismatchedByteOffsets};
  if(mismatchedByteOffsets.length)throw new RuntimeMismatchError(verification);
  return verification;
}

export function compileRecord(record,solcPath,{includeCreation=false}={}) {
  const c=record.compilation;
  if(!solcPath||!['Solidity','Yul'].includes(c?.language)||!c?.compilerVersion)throw new Error('Compiler configuration required');
  const version=execFileSync(solcPath,['--version'],{encoding:'utf8',timeout:10000});
  if(!version.includes('Version: '+c.compilerVersion))throw new Error('Compiler version mismatch');
  const sources=Object.fromEntries(Object.entries(record.sources??{}).map(([path,s])=>{
    if(typeof s.content!=='string'||!s.content)throw new Error('Missing source');return [path,{content:s.content}];
  }));
  if(!Object.keys(sources).length)throw new Error('No compiler sources');
  const outputs=['evm.deployedBytecode','abi','storageLayout',...(includeCreation?['evm.bytecode','metadata']:[])];
  const input={language:c.language,sources,settings:{...c.compilerSettings,outputSelection:{'*':{'*':outputs,'':['ast']}}}};
  const output=JSON.parse(execFileSync(solcPath,['--standard-json'],{input:JSON.stringify(input),encoding:'utf8',timeout:60000,maxBuffer:20000000}));
  if(output.errors?.some(e=>e.severity==='error'))throw new Error('Independent compilation failed');
  const separator=c.fullyQualifiedName.lastIndexOf(':');
  const path=c.fullyQualifiedName.slice(0,separator),name=c.fullyQualifiedName.slice(separator+1);
  const contract=output.contracts?.[path]?.[name];
  if(!contract?.evm?.deployedBytecode?.object)throw new Error('Compiled target missing');
  const immutableNames={};
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.nodeType==='VariableDeclaration'&&node.mutability==='immutable')immutableNames[String(node.id)]=node.name;
    for(const child of Object.values(node))if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);
  };
  for(const source of Object.values(output.sources??{}))visit(source.ast);
  return {contract,immutableNames,sourceDigests:Object.fromEntries(Object.entries(sources).map(([p,s])=>[p,keccak256(stringToHex(s.content))])),compilerVersion:c.compilerVersion};
}

export async function inspectCollateral({token,rpc,solcPath,blockNumber}) {
  if(!/^0x[0-9a-fA-F]{40}$/.test(token??'')||!rpc||!solcPath)throw new Error('Explicit token, RPC and compiler path required');
  if(blockNumber!==undefined&&(typeof blockNumber!=='bigint'||blockNumber<0n))throw new Error('Invalid block number');
  const sourceUrl=`https://sourcify.dev/server/v2/contract/4663/${token}?fields=all`;
  const response=await fetch(sourceUrl,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Source unavailable');
  const record=await response.json();
  if(String(record.chainId)!=='4663'||record.address?.toLowerCase()!==token.toLowerCase())throw new Error('Source identity mismatch');
  const client=createPublicClient({transport:http(rpc,{timeout:15000,retryCount:0}),cacheTime:0});
  if(await client.getChainId()!==4663)throw new Error('Wrong chain');
  const block=await client.getBlock(blockNumber!==undefined?{blockNumber}:{});
  const code=await client.getCode({address:token,blockNumber:block.number});
  const compiled=compileRecord(record,solcPath);
  let runtime;
  try {
    runtime=matchCompiledRuntime(compiled.contract.evm.deployedBytecode.object,code,compiled.contract.evm.deployedBytecode.immutableReferences);
  } catch(error) {
    // Preserve mismatch evidence without promoting it to a successful verification.
    if(!(error instanceof RuntimeMismatchError))throw error;
    runtime=error.verification;
  }
  const controls={};
  const getters={launchBlock:'uint256',restrictionBlocks:'uint256',restrictionEndBlock:'uint256',maxWalletBps:'uint16',maxTxBps:'uint16',
    launchFactory:'address',deployer:'address',dexFactory:'address',positionManager:'address',pairToken:'address',poolFee:'uint24',liquidityPool:'address',totalSupply:'uint256'};
  for(const [name,type] of Object.entries(getters)) {
    try {controls[name]=await client.readContract({address:token,abi:parseAbi([`function ${name}() view returns (${type})`]),functionName:name,blockNumber:block.number});}
    catch {controls[name]=null;}
  }
  const canonical=await client.getBlock({blockNumber:block.number});
  if(canonical.hash!==block.hash)throw new Error('Reorg during source review');
  return {token,chainId:4663,blockNumber:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,sourceUrl,
    language:record.compilation.language,compilerVersion:compiled.compilerVersion,sourceDigests:compiled.sourceDigests,...runtime,
    immutableNames:compiled.immutableNames,controls,launchRestrictionsExpired:typeof controls.restrictionEndBlock==='bigint'?block.number>controls.restrictionEndBlock:null,
    storage:compiled.contract.storageLayout?.storage??null,
    mutableExternalFunctions:compiled.contract.abi?.filter(a=>a.type==='function'&&!['view','pure'].includes(a.stateMutability)).map(a=>a.name)??null,
    behaviorAuditComplete:false,admission:'not-approved',productionChanged:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const token=process.argv[2];
  if(!/^0x[0-9a-fA-F]{40}$/.test(token??'')||!process.env.COLLATERAL_RPC_URL||!process.env.COLLATERAL_SOLC_PATH)throw new Error('Explicit token, RPC and compiler path required');
  inspectCollateral({token,rpc:process.env.COLLATERAL_RPC_URL,solcPath:process.env.COLLATERAL_SOLC_PATH})
    .then(result=>{
      console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2));
      if(result.match==='mismatch')process.exitCode=1;
    })
    .catch(()=>{console.error('Independent source verification failed; no transaction broadcast.');process.exitCode=1;});
}
