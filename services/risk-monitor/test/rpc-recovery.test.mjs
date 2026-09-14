import test from 'node:test';
import assert from 'node:assert/strict';
import {Chain} from '../../liquidator/src/chain.mjs';
import {configFromEnv} from '../../liquidator/src/config.mjs';
import {LivenessTracker} from '../src/liveness.mjs';

test('risk polling recovers a cooled primary when its fallback stays unavailable',async t=>{
 let now=1800000000000,primaryReads=0;
 t.mock.method(Date,'now',()=>now);
 const chain=new Chain(configFromEnv({KEEPER_RPC_URL:'http://localhost:1111',KEEPER_FALLBACK_RPC_URLS:'http://localhost:2222'}));
 chain.providers[0].client={getChainId:async()=>4663,getBlock:async()=>{
  primaryReads++;return {number:BigInt(now),hash:`head-${now}`,timestamp:BigInt(now/1000)};
 }};
 chain.providers[1].client={getChainId:async()=>{throw Error('Fallback unavailable');},getBlock:async()=>{throw Error('Fallback unavailable');}};
 await chain.select();
 // The running monitor records one transient read failure, then repeats its
 // normal select/catch/recordFailure loop every five seconds.
 chain.recordFailure();const retryAfter=chain.active.retryAfter;
 for(let elapsed=5000;elapsed<60000;elapsed+=5000){
  now=1800000000000+elapsed;
  await assert.rejects(chain.select(),/No healthy RPC/);chain.recordFailure();
 }
 assert.equal(primaryReads,1,'The primary is not hammered during its cooldown');
 now=retryAfter;
 const head=await chain.select();
 assert.equal(chain.active.name,'rpc_1');assert.equal(primaryReads,2);
 assert.equal(chain.consistent,true);
 // Recovered connectivity must still earn the full configured liveness interval.
 const tracker=new LivenessTracker();
 const options={consistent:true,healthyProviders:1,requiredHealthyProviders:1};
 assert.equal(tracker.observe(head,now/1000,options).ok,false);
 for(let elapsed=5000;elapsed<=120000;elapsed+=5000){
  now=retryAfter+elapsed;
  const current=await chain.select();
  assert.equal(tracker.observe(current,now/1000,options).ok,elapsed===120000);
 }
});
