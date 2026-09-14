import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createPublicClient,http,keccak256,stringToHex} from 'viem';
import {verifyApi3NativeSource} from './verify-api3-source.mjs';

test('official historical API3 sources reproduce the full native Robinhood runtime without metadata exceptions',{timeout:60000},async t=>{
  assert.ok(process.env.API3_SOLC_PATH,'Provide the local solc 0.8.17 executable');
  const client=createPublicClient({transport:http(process.env.API3_RPC_URL??'https://rpc.mainnet.chain.robinhood.com',
    {timeout:15000,retryCount:0}),cacheTime:0});
  const records=new Map();
  const fetcher=async(url,options)=>{
    if(!records.has(url)){
      const r=await fetch(url,options);assert.equal(r.status,200);records.set(url,await r.json());
    }
    return Response.json(records.get(url));
  };
  const args={client,solcPath:process.env.API3_SOLC_PATH,fetcher};
  const report=await verifyApi3NativeSource(args);
  assert.equal(report.runtimeCodeHash,'0x27204d8c31a1fcbdf7747d795776d8a60c6d10bf2bf7c94739cd9190a5e16238');
  assert.equal(report.fullRuntimeMatch,true);assert.equal(report.metadataIgnored,false);
  assert.equal(report.constructorSimulationExact,true);assert.equal(report.creationCodeMatches,true);
  assert.equal(report.metadataMatchesHistoricalRecord,true);assert.equal(report.metadataMatchesRobinhoodRecord,false);
  assert.equal(report.sourceCount,30);assert.equal(report.productionApproved,false);assert.equal(report.productionChanged,false);
  await t.test('an altered source cannot pass its published digest',async()=>{
    await assert.rejects(verifyApi3NativeSource({...args,fetcher:async(url)=>{
      const record=structuredClone(records.get(url));
      if(url.includes('/ethereum/')){
        const m=JSON.parse(record.metadata);m.sources[Object.keys(m.sources)[0]].content+='\n';record.metadata=JSON.stringify(m);
      }
      return Response.json(record);
    }}),/Api3SourceDigestMismatch/);
  });
  await t.test('altered constructor arguments cannot reproduce the deployed immutable values',async()=>{
    await assert.rejects(verifyApi3NativeSource({...args,fetcher:async(url)=>{
      const record=structuredClone(records.get(url));
      if(url.includes('/robinhood/'))record.args[2]='0x'+'12'.repeat(20);
      return Response.json(record);
    }}),/Api3ConstructorRuntimeMismatch/);
  });
  await t.test('a source edit with an updated digest still fails the exact metadata and creation-code comparison',async()=>{
    await assert.rejects(verifyApi3NativeSource({...args,fetcher:async(url)=>{
      const record=structuredClone(records.get(url));
      if(url.includes('/ethereum/')){
        const m=JSON.parse(record.metadata),source=m.sources[Object.keys(m.sources)[0]];
        source.content+='\n';source.keccak256=keccak256(stringToHex(source.content));
        // Produce self-consistent canonical metadata for the altered sources.
        // The runtime binding, not JSON formatting, must reject this bundle.
        const {compilationTarget,...settings}=m.settings;
        settings.outputSelection={'*':{'*':['metadata']}};
        const input={language:m.language,settings,sources:Object.fromEntries(Object.entries(m.sources).map(([p,s])=>[p,{content:s.content}]))};
        const output=JSON.parse(execFileSync(process.env.API3_SOLC_PATH,['--standard-json'],
          {input:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:20000000}));
        record.metadata=output.contracts['contracts/api3-server-v1/Api3ServerV1.sol'].Api3ServerV1.metadata;
      }
      return Response.json(record);
    }}),/Api3CreationCodeMismatch/);
  });
  await t.test('a changed canonical block invalidates otherwise matching provenance',async()=>{
    const reorg={...client,getBlock:async options=>{const b=await client.getBlock(options);
      return options?.blockNumber?{...b,hash:'0x'+'11'.repeat(32)}:b;}};
    await assert.rejects(verifyApi3NativeSource({...args,client:reorg}),/Api3SourceBlockChanged/);
  });
});
