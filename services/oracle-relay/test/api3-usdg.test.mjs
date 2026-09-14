import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateApi3Usdg,fetchApi3Usdg,preflightApi3Usdg,API3_USDG_SOURCES} from '../src/api3-usdg.mjs';
const packages=JSON.parse(readFileSync(new URL('./fixtures/api3-usdg.json',import.meta.url)));
const now=1788398866n;

test('real public USDG signatures recover all five pinned provider identities',async()=>{
  const r=await validateApi3Usdg(packages,now);
  assert.equal(r.rows.length,5);assert.equal(r.medianPrice18,1000126272184064000n);
  assert.equal(r.oldestTimestamp,1788398849n);assert.equal(r.newestTimestamp,1788398852n);
  assert.equal(new Set(r.rows.map(p=>p.beaconId)).size,5);
});
test('provider order does not alter the fixed source set',async()=>{
  assert.deepEqual(await validateApi3Usdg([...packages].reverse(),now),await validateApi3Usdg(packages,now));
});
test('missing, extra and duplicate providers rejected',async()=>{
  for(const p of [[],packages.slice(1),[...packages,packages[0]],[packages[0],packages[0],...packages.slice(2)]]){
    await assert.rejects(validateApi3Usdg(p,now));
  }
});
test('old and future signed data rejected without timestamp rewriting',async()=>{
  await validateApi3Usdg(packages,1788398908n);
  await assert.rejects(validateApi3Usdg(packages,1788398909n),/TimestampInvalid/);
  await assert.rejects(validateApi3Usdg(packages,1788398851n),/TimestampInvalid/);
  for(const time of [0n,-1n,Number(now)])await assert.rejects(validateApi3Usdg(packages,time));
});
test('wrong token template, unknown signer and claimed rotated signer rejected',async()=>{
  for(const mutate of [p=>{p[0].templateId=packages[1].templateId;},p=>{p[0].airnode='0x'+'11'.repeat(20);},
    p=>{p[0].airnode=packages[1].airnode;}]){
    const p=structuredClone(packages);mutate(p);await assert.rejects(validateApi3Usdg(p,now),/ProviderOrTemplateMismatch/);
  }
});
test('tampered signed price, timestamp and signature fail cryptographic verification',async()=>{
  for(const mutate of [p=>{p[0].encodedValue='0x'+'00'.repeat(31)+'01';},p=>{p[0].timestamp='1788398850';},
    p=>{p[0].signature=packages[1].signature;}]){
    const p=structuredClone(packages);mutate(p);await assert.rejects(validateApi3Usdg(p,now));
  }
});
test('strict ABI, timestamp and signature encodings',async()=>{
  for(const mutate of [p=>{p[0].timestamp=1788398849;},p=>{p[0].timestamp='01788398849';},p=>{p[0].timestamp='4294967296';},
    p=>{p[0].encodedValue+='00';},p=>{p[0].encodedValue='1.0';},p=>{p[0].signature=p[0].signature.slice(0,-2)+'00';},
    p=>{p[0].signature=p[0].signature.slice(0,66)+'ff'.repeat(32)+'1b';}]){
    const p=structuredClone(packages);mutate(p);await assert.rejects(validateApi3Usdg(p,now));
  }
});
test('fetch uses only documented public base-feed endpoints, no auth or OEV',async()=>{
  const requests=[];
  const fetched=await fetchApi3Usdg(async(url,options)=>{
    requests.push({url,options});const i=API3_USDG_SOURCES.findIndex(s=>url.endsWith(s.airnode));assert.ok(i>=0);
    return{ok:true,json:async()=>({data:{[API3_USDG_SOURCES[i].beaconId]:packages[i]}})};
  });
  assert.deepEqual(fetched,packages);assert.equal(requests.length,5);
  for(const {url,options} of requests){
    assert.ok(url.startsWith('https://signed-api.api3.org/public/'));assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{Accept:'application/json'});
  }
});
test('HTTP denial, missing feeds and feed substitution fail closed',async()=>{
  for(const response of [{ok:false},{ok:true,json:async()=>({data:{}})},
    {ok:true,json:async()=>({data:Object.fromEntries(API3_USDG_SOURCES.map(s=>[s.beaconId,packages[0]]))})}]){
    await assert.rejects(fetchApi3Usdg(async()=>response));
  }
});
test('preflight rejects a wrong chain before contacting providers',async()=>{
  await assert.rejects(preflightApi3Usdg({client:{getChainId:async()=>1},fetcher:()=>assert.fail('Unexpected fetch')}),/WrongApi3Chain/);
});
test('preflight refuses stale or future RPC heads before inspecting a runtime',async()=>{
  for(const timestamp of [now-61n,now+16n]){
    const client={getChainId:async()=>4663,getBlock:async()=>({number:1n,hash:'0x'+'ab'.repeat(32),timestamp}),
      getCode:()=>assert.fail('Must reject head first')};
    const fetcher=async url=>{const i=API3_USDG_SOURCES.findIndex(s=>url.endsWith(s.airnode));return{ok:true,json:async()=>({data:{[API3_USDG_SOURCES[i].beaconId]:packages[i]}})};};
    await assert.rejects(preflightApi3Usdg({client,fetcher,now:()=>Number(now)*1000}),/RpcHeadNotFresh/);
  }
});
test('preflight refuses an unexpected verification contract before simulating publication',async()=>{
  const client={getChainId:async()=>4663,getBlock:async()=>({number:1n,hash:'0x'+'ab'.repeat(32),timestamp:now}),
    getCode:async()=>'0x60006000',simulateContract:()=>assert.fail('Must reject runtime first')};
  const fetcher=async url=>{const i=API3_USDG_SOURCES.findIndex(s=>url.endsWith(s.airnode));return{ok:true,json:async()=>({data:{[API3_USDG_SOURCES[i].beaconId]:packages[i]}})};};
  await assert.rejects(preflightApi3Usdg({client,fetcher,now:()=>Number(now)*1000}),/ServerRuntimeChanged/);
});
