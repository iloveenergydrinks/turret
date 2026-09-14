import {pathToFileURL} from 'node:url';
import {createPublicClient,http,keccak256,stringToHex,encodeDeployData} from 'viem';
import {compileRecord,matchCompiledRuntime} from './recompile-collateral.mjs';
import {API3_SERVER,API3_SERVER_HASH} from '../../services/oracle-relay/src/api3-usdg.mjs';

export const API3_CONTRACT_REVISION='682e1f19d0f6d3d9c4702fdca782a285baaee43e';
const base=`https://raw.githubusercontent.com/api3dao/contracts/${API3_CONTRACT_REVISION}/deployments`;
const historicalUrl=`${base}/ethereum/Api3ServerV1.json`,deploymentUrl=`${base}/robinhood/Api3ServerV1.json`;
const targetPath='contracts/api3-server-v1/Api3ServerV1.sol';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,message)=>{if(!ok)throw Error(message);};
async function deployment(fetcher,url){
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  demand(response.ok,'Api3SourceUnavailable');
  const reader=response.body?.getReader();demand(reader,'Api3SourceBodyMissing');
  const chunks=[];let length=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;
      length+=value.length;demand(length<=2000000,'Api3SourceTooLarge');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Read-only provenance check. The historical metadata contains the source
 * paths matching the unchanged bytecode, unlike the newer Robinhood metadata.
 * No metadata transformation or immutable value guessed from remote records
 * can pass: the locally compiled constructor must return the complete runtime. */
export async function verifyApi3NativeSource({client,solcPath,fetcher=fetch}){
  demand(typeof solcPath==='string'&&solcPath.length>0,'Api3CompilerRequired');
  demand(await client.getChainId()===4663,'WrongApi3SourceChain');
  const block=await client.getBlock();
  demand(typeof block.number==='bigint'&&/^0x[\da-f]{64}$/i.test(block.hash??''),'InvalidApi3SourceBlock');
  const code=await client.getCode({address:API3_SERVER,blockNumber:block.number});
  demand(code&&same(keccak256(code),API3_SERVER_HASH),'Api3SourceRuntimeChanged');
  const [historical,deployed]=await Promise.all([deployment(fetcher,historicalUrl),deployment(fetcher,deploymentUrl)]);
  demand(same(deployed.address,API3_SERVER),'Api3DeploymentIdentityMismatch');
  const metadata=JSON.parse(historical.metadata);
  demand(metadata.compiler?.version==='0.8.17+commit.8df45f5f'&&metadata.language==='Solidity'
    &&metadata.settings?.compilationTarget?.[targetPath]==='Api3ServerV1','Api3CompilerIdentityMismatch');
  demand(metadata.sources&&Object.keys(metadata.sources).length===30,'Api3SourceSetMismatch');
  for(const source of Object.values(metadata.sources))
    demand(typeof source.content==='string'&&same(keccak256(stringToHex(source.content)),source.keccak256),'Api3SourceDigestMismatch');
  const {compilationTarget,...compilerSettings}=metadata.settings;
  const compiled=compileRecord({sources:metadata.sources,compilation:{language:metadata.language,
    compilerVersion:metadata.compiler.version,compilerSettings,fullyQualifiedName:`${targetPath}:Api3ServerV1`}},solcPath,{includeCreation:true});
  demand(compiled.contract.metadata===historical.metadata,'Api3CompiledMetadataMismatch');
  const bytecode='0x'+compiled.contract.evm.bytecode.object;
  demand(same(bytecode,deployed.bytecode),'Api3CreationCodeMismatch');
  const runtime=matchCompiledRuntime(compiled.contract.evm.deployedBytecode.object,code,
    compiled.contract.evm.deployedBytecode.immutableReferences);
  demand(Array.isArray(deployed.args)&&deployed.args.length===3,'Api3ConstructorArgumentsMissing');
  const data=encodeDeployData({abi:compiled.contract.abi,bytecode,args:deployed.args});
  // eth_call executes creation in temporary state. It neither deploys a
  // contract nor signs/broadcasts a transaction or transfers funds.
  const simulated=await client.call({data,gas:10000000n,blockNumber:block.number});
  demand(same(simulated.data,code),'Api3ConstructorRuntimeMismatch');
  demand(same((await client.getBlock({blockNumber:block.number})).hash,block.hash),'Api3SourceBlockChanged');
  return {chainId:4663,address:API3_SERVER,blockNumber:block.number,blockHash:block.hash,blockTimestamp:block.timestamp,
    sourceRevision:API3_CONTRACT_REVISION,historicalMetadataUrl:historicalUrl,deploymentUrl,
    compilerVersion:compiled.compilerVersion,sourceCount:30,sourceDigests:compiled.sourceDigests,
    compilerSettings,metadataMatchesHistoricalRecord:true,metadataMatchesRobinhoodRecord:compiled.contract.metadata===deployed.metadata,
    metadataCodeHash:keccak256(stringToHex(compiled.contract.metadata)),creationCodeHash:keccak256(bytecode),
    constructorArgs:deployed.args,creationCodeMatches:true,constructorSimulationExact:true,fullRuntimeMatch:true,
    runtimeCodeHash:runtime.runtimeCodeHash,runtimeBytes:runtime.runtimeBytes,metadataIgnored:false,
    immutableNames:compiled.immutableNames,immutableValues:runtime.immutableValues,mismatchedByteOffsets:[],
    scope:'Independent local compilation, full runtime and constructor reproduction at one canonical block via one RPC. Not an audit, data-use approval or continuous oracle qualification.',
    productionApproved:false,productionChanged:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    demand(process.env.API3_RPC_URL&&process.env.API3_SOLC_PATH,'ExplicitApi3SourceInputsRequired');
    const client=createPublicClient({transport:http(process.env.API3_RPC_URL,{timeout:15000,retryCount:0}),cacheTime:0});
    const result=await verifyApi3NativeSource({client,solcPath:process.env.API3_SOLC_PATH});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?v.toString():v,2));
  }catch{console.error('API3 source verification failed. Check the explicit compiler, source records and RPC state. No transaction was sent.');process.exitCode=1;}
}
