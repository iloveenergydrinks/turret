import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from '../src/deps.mjs';
import {PYTH_VERIFIER} from '../src/pyth.mjs';
import {CASHCAT_PAIR as policy} from '../src/isolated-pyth-preflight.mjs';
import {prepareIsolatedPublication} from '../src/isolated-publication.mjs';
import {envelope} from './fixtures/isolated-pyth.mjs';

const runtime='0x60006000',pin=keccak256(runtime),hub='0x'+'11'.repeat(20),adapter='0x'+'22'.repeat(20),caller='0x'+'33'.repeat(20);
const clock=1800000000n,block={number:123n,timestamp:clock,hash:'0x'+'ab'.repeat(32)};
function fixture(patch={}) {
  const base={timestampUs:clock*1000000n,sourceUs:clock*1000000n,confidence:10000n,exponent:-8,publishers:3,session:0};
  const feeds=[{...base,id:3441,price:200000000n,...patch},{...base,id:232,price:100000000n}];
  const signed=envelope(feeds),calls=[];
  const bindings={hub,verifier:PYTH_VERIFIER,collateral:policy.collateral,usdg:policy.usdg,hubCodeHash:pin,verifierCodeHash:pin};
  const client={
    async getChainId(){return 4663;},async getBlock(){return block;},async getCode(args){calls.push(['code',args]);return runtime;},
    async readContract(args){
      calls.push(['read',args]);
      if(args.functionName==='decimals')return args.address===policy.collateral?18:6;
      if(args.functionName==='verification_fee')return 1n;
      if(args.functionName==='report')return {timestampUs:0n};
      if(args.functionName in bindings)return bindings[args.functionName];
      if(args.functionName in policy)return BigInt(policy[args.functionName]);
      throw Error('Unexpected read');
    },
    async simulateContract(args){calls.push(['simulate',args]);return args.functionName==='verifyUpdate'?{result:['0x'+signed.slice(144),caller]}:{};},
  };
  const args={client,key:'fake-local-only',caller,policy,hub,adapter,hubCodeHash:pin,adapterCodeHash:pin,verifierCodeHash:pin,
    collateralCodeHash:pin,usdgCodeHash:pin,now:()=>Number(clock*1000n),getPrices:async()=>({signed}),
    getSymbols:async()=>[[policy.collateralSymbol,3441,2],[policy.usdgSymbol,232,3]].map(([symbol,id,minimum])=>({
      symbol,pyth_lazer_id:id,state:'stable',instrument_type:'spot',asset_type:'crypto',exponent:-8,min_publishers:minimum,
    }))};
  return {args,client,calls};
}
test('publication binds hub, adapter, policy and all runtimes at a canonical block',async()=>{
  const f=fixture(),result=await prepareIsolatedPublication(f.args);
  assert.equal(result.shouldSubmit,true);assert.equal(result.to,hub);assert.equal(result.value,1n);
  assert.equal(result.changedFeeds.length,2);assert.equal(result.incomingQuote.available,true);
  assert.equal(result.productionApproved,false);
  assert.ok(f.calls.every(([,args])=>args.blockNumber===123n));
  assert.deepEqual(f.calls.filter(([kind])=>kind==='simulate').map(([,a])=>a.functionName),['verifyUpdate','update']);
});
test('publication reads each runtime once per preparation, without caching across preparations',async()=>{
  const f=fixture();
  await prepareIsolatedPublication(f.args);
  const codeReads=()=>f.calls.filter(([kind])=>kind==='code');
  assert.equal(codeReads().length,5,'Five distinct runtime targets should require five RPC reads');
  assert.equal(new Set(codeReads().map(([,a])=>a.address.toLowerCase())).size,5);
  await prepareIsolatedPublication(f.args);
  assert.equal(codeReads().length,10,'A new preparation must check runtime code again, even at the same height');
});
test('a failed runtime read or a changed pin is checked again on the next preparation',async()=>{
  const f=fixture(),getCode=f.client.getCode;
  let broken=true;
  f.client.getCode=async args=>{if(broken)throw Error('RPC unavailable');return getCode(args);};
  await assert.rejects(prepareIsolatedPublication(f.args),/RPC unavailable/);
  broken=false;
  assert.equal((await prepareIsolatedPublication(f.args)).shouldSubmit,true);
  f.client.getCode=async args=>args.address===policy.usdg?'0x6001':getCode(args);
  await assert.rejects(prepareIsolatedPublication(f.args),/runtime mismatch/);
});
test('signed invalidation reports remain publishable instead of retaining good cached prices',async()=>{
  for(const patch of [{session:4},{sourceUs:(clock-60n)*1000000n},{confidence:3000000n},{publishers:1}]) {
    const result=await prepareIsolatedPublication(fixture(patch).args);
    assert.equal(result.shouldSubmit,true);assert.equal(result.incomingQuote.available,false);
  }
});
test('equal and newer cached timestamps do not spend another publication fee',async()=>{
  for(const offset of [0n,1n]) {
    const f=fixture(),read=f.client.readContract;
    f.client.readContract=async args=>args.functionName==='report'?{timestampUs:clock*1000000n+offset}:read(args);
    const result=await prepareIsolatedPublication(f.args);
    assert.equal(result.shouldSubmit,false);assert.equal(result.reason,'cache-already-current');
    assert.equal(f.calls.some(([kind,args])=>kind==='simulate'&&args.functionName==='update'),false);
  }
});
test('mixed cache freshness only reports feeds that would advance',async()=>{
  const f=fixture(),read=f.client.readContract;
  f.client.readContract=async args=>args.functionName==='report'?{timestampUs:args.args[0]===3441?clock*1000000n:0n}:read(args);
  const result=await prepareIsolatedPublication(f.args);
  assert.deepEqual(result.changedFeeds.map(f=>f.id),[232]);
});
test('changed hub/adapter/token pins prevent publication simulation',async()=>{
  for(const name of ['hubCodeHash','adapterCodeHash','collateralCodeHash','usdgCodeHash']){
    const f=fixture();f.args[name]='0x'+'cd'.repeat(32);
    await assert.rejects(prepareIsolatedPublication(f.args),/runtime mismatch/);
    assert.equal(f.calls.some(([kind,args])=>kind==='simulate'&&args.functionName==='update'),false);
  }
});
test('wrong adapter binding or policy cannot publish to a different market',async()=>{
  for(const name of ['hub','verifier','collateral','usdg','hubCodeHash','verifierCodeHash','collateralFeedId','maxPriceAge']){
    const f=fixture(),read=f.client.readContract;
    f.client.readContract=async args=>args.address===adapter&&args.functionName===name?(name.endsWith('Hash')?'0x'+'cd'.repeat(32):name==='collateralFeedId'||name==='maxPriceAge'?99n:caller):read(args);
    await assert.rejects(prepareIsolatedPublication(f.args),/mismatch/);
  }
});
test('slow hub simulation or a reorg invalidates the publication plan',async()=>{
  for(const mode of ['slow','reorg']) {
    const f=fixture(),simulate=f.client.simulateContract;
    let simulated=false;
    f.client.simulateContract=async args=>{
      const result=await simulate(args);
      if(args.functionName==='update')simulated=true;
      return result;
    };
    f.args.now=()=>Number((clock+(mode==='slow'&&simulated?30n:0n))*1000n);
    f.client.getBlock=async()=>mode==='reorg'&&simulated?{...block,hash:'0x'+'cd'.repeat(32)}:block;
    await assert.rejects(prepareIsolatedPublication(f.args),/changed or expired/);
  }
});
test('malformed cache reads cannot be classified as already current',async()=>{
  const f=fixture(),read=f.client.readContract;
  f.client.readContract=async args=>args.functionName==='report'?{}:read(args);
  await assert.rejects(prepareIsolatedPublication(f.args),/Invalid cached report/);
});
test('hub update rejection never yields an executable plan',async()=>{
  const f=fixture(),simulate=f.client.simulateContract;
  f.client.simulateContract=async args=>{if(args.functionName==='update')throw Error('hub rejected');return simulate(args);};
  await assert.rejects(prepareIsolatedPublication(f.args),/hub rejected/);
});
