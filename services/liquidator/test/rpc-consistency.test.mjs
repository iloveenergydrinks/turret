import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain } from '../src/chain.mjs';
import { configFromEnv } from '../src/config.mjs';

function harness() {
  const chain=new Chain(configFromEnv({KEEPER_RPC_URL:'http://localhost:1111',KEEPER_FALLBACK_RPC_URLS:'http://localhost:2222'}));
  const head={number:100n,hash:'0x'+'ab'.repeat(32),timestamp:BigInt(Math.floor(Date.now()/1000))};
  const calls=[[],[]];
  for(const [i,p] of chain.providers.entries())p.client={getChainId:async()=>4663,getBlock:async args=>{calls[i].push(args?.blockNumber);return head;}};
  return {chain,head,calls};
}
const timeout=()=>Object.assign(new Error('https://secret.invalid/private-key; signed payload'),{name:'HttpRequestError',cause:Object.assign(new Error('private'),{name:'TimeoutError'})});

test('RPC comparison retries a failed lookup at the same height before reporting disagreement',async()=>{
  const {chain,head,calls}=harness();let comparisonReads=0;
  chain.providers[1].client.getBlock=async args=>{
    calls[1].push(args?.blockNumber);
    if(args?.blockNumber!==undefined&&comparisonReads++===0)throw timeout();
    return head;
  };
  await chain.select();
  assert.equal(chain.consistent,true,'One failed RPC lookup is not evidence of conflicting block hashes');
  assert.equal(chain.consistency.status,'agreed');
  assert.deepEqual(calls[1],[undefined,100n,100n]);
  assert.deepEqual(calls[0],[undefined,100n]);
  assert.equal(chain.consistency.providers[1].attempts.length,2);
  assert.equal(chain.consistency.providers[1].attempts[0].cause,'TimeoutError');
  assert.doesNotMatch(JSON.stringify(chain.consistency,(_,v)=>typeof v==='bigint'?String(v):v),/secret|private|payload/);
});

test('RPC comparison stays blocked after two failed reads and records unavailability, not a hash conflict',async()=>{
  const {chain,head}=harness();let reads=0;
  chain.providers[1].client.getBlock=async args=>{if(args?.blockNumber!==undefined){reads++;throw timeout();}return head;};
  await chain.select();
  assert.equal(chain.consistent,false);
  assert.equal(chain.consistency?.status,'unavailable');
  assert.equal(reads,2);
  assert.equal(chain.consistency.providers[1].attempts[1].cause,'TimeoutError');
});

test('RPC comparison blocks real hash conflicts immediately without retrying them away',async()=>{
  const {chain,head,calls}=harness();
  chain.providers[1].client.getBlock=async args=>{calls[1].push(args?.blockNumber);return {...head,hash:'0x'+'cd'.repeat(32)};};
  await chain.select();
  assert.equal(chain.consistent,false);
  assert.equal(chain.consistency?.status,'hash_mismatch');
  assert.deepEqual(calls[1],[undefined,100n]);
  assert.equal(chain.consistency.blockNumber,100n);
  assert.equal(new Set(chain.consistency.providers.map(p=>p.hash)).size,2);
});

test('RPC comparison cannot authorize a missing hash or a response for the wrong block',async()=>{
  for(const wrong of [{hash:null},{number:101n}]){
    const {chain,head}=harness();
    chain.providers[1].client.getBlock=async args=>args?.blockNumber===undefined?head:{...head,...wrong};
    await chain.select();assert.equal(chain.consistent,false);assert.equal(chain.consistency?.status,'unavailable');
  }
});

test('RPC selection clears a previous agreement when every provider becomes unavailable',async()=>{
  const {chain}=harness();await chain.select();assert.equal(chain.consistent,true);
  for(const p of chain.providers)p.client.getBlock=async()=>{throw timeout();};
  await assert.rejects(chain.select(),/No healthy RPC/);
  assert.equal(chain.consistent,false);
  assert.equal(chain.consistency?.status,'unavailable');
});

test('a third provider timeout cannot hide an existing two-provider hash conflict',async()=>{
  const {chain,head}=harness();let thirdReads=0;
  chain.providers[1].client.getBlock=async()=>({...head,hash:'0x'+'cd'.repeat(32)});
  chain.providers.push({name:'rpc_3',host:'localhost',client:{getChainId:async()=>4663,getBlock:async args=>{
    if(args?.blockNumber!==undefined){thirdReads++;throw timeout();}return head;
  }}});
  await chain.select();
  assert.equal(chain.consistent,false);assert.equal(chain.consistency.status,'hash_mismatch');
  assert.equal(thirdReads,1,'An observed conflict blocks immediately without a retry');
});
