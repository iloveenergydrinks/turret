import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from '../src/deps.mjs';
import {PYTH_VERIFIER} from '../src/pyth.mjs';
import {CASHCAT_PAIR as policy,evaluatePair} from '../src/isolated-pyth-preflight.mjs';
import {readIsolatedReadiness} from '../src/isolated-readiness.mjs';

const runtime='0x60006000',pin=keccak256(runtime),hub='0x'+'11'.repeat(20),adapter='0x'+'22'.repeat(20);
const time=1800000000n;
function fixture(){
  let ms=Number(time*1000n);
  const head={number:102n,timestamp:time,hash:'0x'+'ab'.repeat(32)};
  const block={number:100n,timestamp:time-2n,hash:'0x'+'cd'.repeat(32)};
  const feeds=[3441,232].map(id=>({id,timestampUs:(time-3n)*1000000n,sourceUs:(time-3n)*1000000n,
    price:id===3441?200000000n:100000000n,confidence:10000n,exponent:-8,publishers:3,session:0}));
  const publication={policy,hub,adapter,hubCodeHash:pin,adapterCodeHash:pin,verifierCodeHash:pin,collateralCodeHash:pin,usdgCodeHash:pin};
  const bindings={hub,verifier:PYTH_VERIFIER,collateral:policy.collateral,usdg:policy.usdg,hubCodeHash:pin,verifierCodeHash:pin};
  const reads=[];
  const client={
    async getChainId(){return 4663;},async getBlock(args){return args?.blockNumber===100n?block:head;},
    async getCode(args){reads.push(args);return runtime;},
    async readContract(args){
      reads.push(args);
      if(args.functionName==='report'){
        const f=feeds.find(f=>f.id===args.args[0]);return {...f,feedUpdateTimestampUs:f.sourceUs};
      }
      if(args.functionName==='latestRoundData'){
        const q=evaluatePair(feeds,block.timestamp,policy);return [q.roundId,q.answer,q.updatedAt,q.updatedAt,q.roundId];
      }
      if(args.functionName in bindings)return bindings[args.functionName];
      return BigInt(policy[args.functionName]);
    },
  };
  return {client,publication,feeds,head,block,reads,args:{client,publication,confirmations:2n,now:()=>ms},setClock:x=>{ms=x;}};
}
test('readiness checks confirmed cache and actual adapter at one pinned block',async()=>{
  const f=fixture(),r=await readIsolatedReadiness(f.args);
  assert.equal(r.available,true);assert.equal(r.block,100n);
  assert.equal(r.validUntil,Number((time+27n)*1000n));
  assert.ok(f.reads.every(r=>r.blockNumber===100n));
});
test('cache stale at wall clock is unavailable even when historical adapter succeeds',async()=>{
  const f=fixture();f.setClock(Number((time+27n)*1000n));
  const r=await readIsolatedReadiness(f.args);assert.equal(r.available,false);
  assert.ok(r.issues.some(i=>i.code==='report_stale'));
});
test('signed invalidations and empty cache are not ready',async()=>{
  for(const patch of [{session:4},{timestampUs:0n,sourceUs:0n},{confidence:90000000n}]){
    const f=fixture();Object.assign(f.feeds[0],patch);
    assert.equal((await readIsolatedReadiness(f.args)).available,false);
  }
});
test('wrong runtime, policy or adapter result fails readiness',async()=>{
  for(const mode of ['runtime','policy','round']){
    const f=fixture(),read=f.client.readContract;
    if(mode==='runtime')f.client.getCode=async()=> '0x6001';
    if(mode==='policy')f.publication={...f.publication,policy:{...policy,maxPriceAge:55}},f.args.publication=f.publication;
    if(mode==='round')f.client.readContract=async a=>a.functionName==='latestRoundData'?[0n,1n,0n,0n,0n]:read(a);
    await assert.rejects(readIsolatedReadiness(f.args),/mismatch|disagree/);
  }
});
test('wrong chain, insufficient confirmations, stale head and reorg fail closed',async()=>{
  for(const mode of ['chain','confirmations','head','reorg']){
    const f=fixture();
    if(mode==='chain')f.client.getChainId=async()=>1;
    if(mode==='confirmations')f.args.confirmations=1n;
    if(mode==='head')f.setClock(Number((time+30n)*1000n));
    if(mode==='reorg'){
      const get=f.client.getBlock;let reads=0;
      f.client.getBlock=async a=>{const b=await get(a);return a?.blockNumber===100n&&++reads>1?{...b,hash:f.head.hash}:b;};
    }
    await assert.rejects(readIsolatedReadiness(f.args));
  }
});
