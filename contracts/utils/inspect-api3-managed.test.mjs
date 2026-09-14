import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {MANAGED_API3_USDG as cfg,managedApi3Observation,inspectManagedApi3Usdg} from './inspect-api3-managed.mjs';

test('managed observation retains depeg and provider timestamp; exact age boundary',()=>{
  const r=managedApi3Observation(800000000000000000n,1000,4599);
  assert.equal(r.price18,800000000000000000n);assert.equal(r.updatedAt,1000n);assert.equal(r.fresh,true);
  assert.equal(managedApi3Observation(1n,1000,4600).fresh,false);
  for(const [p,t,n] of [[0n,1,2],[-1n,1,2],[1n<<128n,1,2],[1n,0,2],[1n,3,2]]){
    assert.equal(managedApi3Observation(p,t,n).fresh,false);
  }
});

test('wrong chain and unpinned runtime stop inspection before trusting prices',async()=>{
  await assert.rejects(inspectManagedApi3Usdg({client:{getChainId:async()=>1}}),/WrongManagedApi3Chain/);
  const client={getChainId:async()=>4663,getBlock:async()=>({number:1n,hash:'0x'+'11'.repeat(32),timestamp:1000n}),getCode:async()=> '0x6000'};
  assert.notEqual(keccak256('0x6000'),cfg.serverCodeHash);
  await assert.rejects(inspectManagedApi3Usdg({client,now:()=>1000000}),/ManagedApi3RuntimeChanged/);
  await assert.rejects(inspectManagedApi3Usdg({client,now:()=>2000000}),/ManagedApi3RpcHeadNotFresh/);
});
test('managed heartbeat policy requires explicit opt-in and rejects out-of-bound ages',()=>{
  assert.equal(managedApi3Observation(1n,1000,90999,90000).fresh,true);
  assert.equal(managedApi3Observation(1n,1000,91000,90000).fresh,false);
  assert.equal(managedApi3Observation(1n,1000,90999).fresh,false);
  for(const age of [0,90001,NaN,'90000',1.5])assert.throws(()=>managedApi3Observation(1n,1,2,age));
});
