import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {api3PublicationIntent,confirmedApi3Publication} from '../src/api3-transactions.mjs';
import {API3_SERVER,API3_USDG_SOURCES,api3UsdgAbi} from '../src/api3-usdg.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {encodeFunctionData,parseAbi,encodeEventTopics,encodeAbiParameters}=require('viem');
const packages=JSON.parse(readFileSync(new URL('./fixtures/api3-usdg.json',import.meta.url)));
const call=p=>encodeFunctionData({abi:api3UsdgAbi,functionName:'updateBeaconWithSignedData',
  args:[p.airnode,p.templateId,BigInt(p.timestamp),p.encodedValue,p.signature]});
const request=(rows=packages)=>({chainId:4663,to:API3_SERVER,value:0n,
  data:encodeFunctionData({abi:api3UsdgAbi,functionName:'multicall',args:[rows.map(call)]})});

test('publication intent verifies the exact canonical batch of pinned USDG updates',async()=>{
  const intent=await api3PublicationIntent(request());
  assert.deepEqual(intent.rows.map(r=>r.beaconId),API3_USDG_SOURCES.map(s=>s.beaconId));
  assert.equal(intent.rows[0].price18,1000000000000000000n);
  const partial=await api3PublicationIntent(request(packages.slice(1)));
  assert.equal(partial.rows.length,4);
  for(const patch of [{chainId:1},{to:packages[0].airnode},{value:1n},{data:request().data+'00'}]){
    await assert.rejects(api3PublicationIntent({...request(),...patch}));
  }
  await assert.rejects(api3PublicationIntent(request([])));
  await assert.rejects(api3PublicationIntent(request([packages[0],packages[0]])));
  const tampered=structuredClone(packages);tampered[0].encodedValue='0x'+'00'.repeat(31)+'01';
  await assert.rejects(api3PublicationIntent(request(tampered)));
});

test('confirmation requires exact beacon events and cache state at the receipt block',async()=>{
  const req=request(),intent=await api3PublicationIntent(req);
  const account='0x'+'11'.repeat(20),hash='0x'+'ab'.repeat(32);
  const eventAbi=parseAbi(['event UpdatedBeaconWithSignedData(bytes32 indexed beaconId,int224 value,uint32 timestamp)']);
  const tx={kind:'api3_usdg_update',request:req,attempts:[{hash}]};
  const logs=intent.rows.map(p=>({address:API3_SERVER,topics:encodeEventTopics({abi:eventAbi,eventName:'UpdatedBeaconWithSignedData',args:{beaconId:p.beaconId}}),
    data:encodeAbiParameters([{type:'int224'},{type:'uint32'}],[p.price18,Number(p.timestamp)])}));
  const receipt={status:'success',from:account,to:API3_SERVER,transactionHash:hash,blockNumber:123n,logs};
  const client={readContract:async a=>{
    assert.equal(a.blockNumber,123n);const p=intent.rows.find(p=>p.beaconId===a.args[0]);return [p.price18,Number(p.timestamp)];
  }};
  const result=await confirmedApi3Publication(receipt,tx,{account,client});
  assert.deepEqual(result.publicationResult.updatedBeaconIds,intent.rows.map(p=>p.beaconId));
  for(const patch of [{from:API3_SERVER},{to:account},{status:'reverted'},{transactionHash:'0x'+'cd'.repeat(32)},
    {logs:[]},{logs:[...logs,logs[0]]},{logs:[{...logs[0],removed:true},...logs.slice(1)]},
    {logs:[{...logs[0],data:'0x'},...logs.slice(1)]}]){
    await assert.rejects(confirmedApi3Publication({...receipt,...patch},tx,{account,client}));
  }
  await assert.rejects(confirmedApi3Publication(receipt,tx,{account,client:{readContract:async()=>[1n,1]}}));
  await assert.rejects(confirmedApi3Publication(receipt,tx,{account,client:{readContract:async()=>{throw Error('RPC unavailable');}}}),/RPC unavailable/);
});
