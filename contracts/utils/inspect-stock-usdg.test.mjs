import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractFunctionRevertedError,ContractFunctionZeroDataError} from 'viem';
import {inspectUsdgSourceIdentity,evaluateUsdgRounds,inspectStockUsdg} from './inspect-stock-usdg.mjs';
import {CHAINLINK_API3_HEARTBEAT_POLICY} from './usdg-heartbeat-policy.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const missing=()=>new ContractFunctionZeroDataError({functionName:'aggregator'});
function fixture(links={}){
  const reads=[],head={number:123n,timestamp:1000000n,hash:'0x'+'ab'.repeat(32)};
  const client={getChainId:async()=>4663,getBlock:async()=>head,
    getCode:async args=>{reads.push(args);return '0x60006000';},
    readContract:async args=>{
      reads.push(args);
      if(args.functionName==='aggregator'){if(links[args.address])return links[args.address];throw missing();}
      if(args.functionName==='decimals')return 8;
      if(args.functionName==='description')return 'USDG / USD';
      if(args.functionName==='latestRoundData')return [1n,100000000n,999999n,999999n,1n];
      assert.fail('Unexpected getter');
    }};
  return {client,reads,head,primary:addr(1),secondary:addr(2),blockNumber:123n,now:()=>1000000000,
    maxAge:3600n,maxDeviationBps:200n,maxTimestampSkew:60n};
}
const policy=()=>({rounds:[[1n,100000000n,999999n,999999n,1n],[2n,10n**18n,999999n,999999n,2n]],
  decimals:[8,18],timestamp:1000000n,maxAge:3600n,maxDeviationBps:200n,maxTimestampSkew:60n});

test('unexposed aggregator getter leaves independence unverified and pins every read',async()=>{
  const f=fixture(),r=await inspectUsdgSourceIdentity(f);
  assert.equal(r.knownAlias,false);assert.equal(r.independenceVerified,false);
  assert.equal(r.feeds[0].terminal,'getter-unavailable');assert.equal(r.feeds[0].nodes.length,1);
  assert.ok(f.reads.every(r=>r.blockNumber===123n));
});
test('two distinct proxy addresses resolving to one aggregator are aliases',async()=>{
  const f=fixture({[addr(1)]:addr(3),[addr(2)]:addr(3)}),r=await inspectUsdgSourceIdentity(f);
  assert.equal(r.knownAlias,true);assert.deepEqual(r.sharedDependencies,[addr(3)]);
  assert.equal(r.feeds[0].nodes.length,2);
});
test('proxy/aggregator pair and nested shared dependencies cannot masquerade as independent feeds',async()=>{
  for(const links of [{[addr(1)]:addr(2)},{[addr(1)]:addr(3),[addr(3)]:addr(5),[addr(2)]:addr(4),[addr(4)]:addr(5)}]){
    assert.equal((await inspectUsdgSourceIdentity(fixture(links))).knownAlias,true);
  }
  const f=fixture();f.secondary=f.primary;assert.equal((await inspectUsdgSourceIdentity(f)).knownAlias,true);
});
test('distinct exposed sources are not proof of independence, even with identical runtime hashes',async()=>{
  const r=await inspectUsdgSourceIdentity(fixture({[addr(1)]:addr(3),[addr(2)]:addr(4)}));
  assert.equal(r.knownAlias,false);assert.equal(r.independenceVerified,false);
  assert.equal(r.feeds[0].nodes[1].codeHash,r.feeds[1].nodes[1].codeHash);
});
test('cycles, unbounded chains, zero addresses and empty dependencies fail closed',async()=>{
  for(const links of [{[addr(1)]:addr(1)},{[addr(1)]:addr(3),[addr(3)]:addr(1)},
    Object.fromEntries(Array.from({length:10},(_,i)=>[addr(i+1),addr(i+2)])),{[addr(1)]:addr(0)}]){
    await assert.rejects(inspectUsdgSourceIdentity(fixture(links)));
  }
  const f=fixture();f.client.getCode=async()=>undefined;await assert.rejects(inspectUsdgSourceIdentity(f),/no code/);
});
test('actual EVM revert is opaque, not an independent identity claim',async()=>{
  const f=fixture();f.client.readContract=async()=>{throw new ContractFunctionRevertedError({abi:[],functionName:'aggregator',data:'0x'});};
  assert.equal((await inspectUsdgSourceIdentity(f)).independenceVerified,false);
});
test('network, decoding and timeout failures do not become unavailable-getter evidence',async()=>{
  for(const error of [Error('RPC timeout'),Error('ABI decoding failed'),new TypeError('fetch failed')]){
    const f=fixture();f.client.readContract=async()=>{throw error;};
    await assert.rejects(inspectUsdgSourceIdentity(f),e=>e===error);
  }
  const f=fixture();f.client.readContract=async()=> 'not-an-address';await assert.rejects(inspectUsdgSourceIdentity(f));
});
test('a pinned block is mandatory',async()=>{
  for(const blockNumber of [undefined,123,-1n])await assert.rejects(inspectUsdgSourceIdentity({...fixture(),blockNumber}),/Pinned block/);
});
test('mixed decimals normalize exactly without assuming a dollar peg',()=>{
  const p=policy();p.rounds[0][1]=99985044n;p.rounds[1][1]=999850440000000000n;
  const r=evaluateUsdgRounds(p);assert.equal(r.engineRoundChecksPassed,true);
  assert.equal(r.observations[0].price18,999850440000000000n);assert.equal(r.observations[0].price18,r.observations[1].price18);
});
test('stale at exact maxAge, not one second before; no freshness relaxation',()=>{
  const p=policy();p.maxTimestampSkew=p.maxAge;p.rounds[0][3]=p.timestamp-p.maxAge+1n;
  assert.equal(evaluateUsdgRounds(p).engineRoundChecksPassed,true);
  p.rounds[0][3]--;assert.ok(evaluateUsdgRounds(p).issues.includes('source-1-stale'));
  p.rounds[0][3]=p.timestamp-35234n;assert.ok(evaluateUsdgRounds(p).issues.includes('source-1-stale'));
});
test('invalid round ids, answered rounds, prices and source timestamps rejected',()=>{
  for(const [index,value] of [[0,0n],[1,0n],[1,-1n],[1,1n<<128n],[3,0n],[3,1000001n],[4,0n]]){
    const p=policy();p.rounds[0][index]=value;assert.ok(evaluateUsdgRounds(p).issues.includes('source-1-invalid-round'));
  }
});
test('deviation and timestamp skew match engine boundaries',()=>{
  const p=policy();p.rounds[1][1]=102n*10n**16n;
  assert.equal(evaluateUsdgRounds(p).engineRoundChecksPassed,true);
  p.rounds[1][1]=10201n*10n**14n;assert.ok(evaluateUsdgRounds(p).issues.includes('source-price-deviation'));
  p.rounds[1][1]=10n**18n;p.rounds[1][3]-=60n;assert.equal(evaluateUsdgRounds(p).engineRoundChecksPassed,true);
  p.rounds[1][3]--;assert.ok(evaluateUsdgRounds(p).issues.includes('source-timestamp-skew'));
});
test('malformed input and relaxed risk limits do not silently normalize',()=>{
  for(const mutate of [p=>{p.maxAge=86400n;},p=>{p.maxAge=0n;},p=>{p.maxAge=3600;},p=>{p.maxDeviationBps=201n;},
    p=>{p.maxTimestampSkew=3601n;},p=>{p.decimals[0]=19;},p=>{p.decimals[0]=-1;},p=>{p.decimals[0]=1.5;},
    p=>{p.rounds[0][1]=100000000;},p=>{p.rounds.pop();},p=>{p.timestamp=0n;}]){
    const p=policy();mutate(p);assert.throws(()=>evaluateUsdgRounds(p));
  }
});
test('whole inspection returns reproducible negative/positive evidence but never approval',async()=>{
  const f=fixture(),r=await inspectStockUsdg(f);
  assert.equal(r.pricing.engineRoundChecksPassed,true);assert.equal(r.productionApproved,false);
  assert.equal(r.tokenBindingVerified,false);assert.equal(r.blockNumber,123n);
  assert.ok(f.reads.every(r=>r.blockNumber===123n));
  const aliased=await inspectStockUsdg(fixture({[addr(1)]:addr(3),[addr(2)]:addr(3)}));
  assert.equal(aliased.identity.knownAlias,true);assert.equal(aliased.pricing.engineRoundChecksPassed,true);
  assert.equal(aliased.productionApproved,false);
});
test('wrong chain, stale/future head, reorg and expired snapshot fail closed',async()=>{
  for(const mutate of [f=>{f.client.getChainId=async()=>1;},f=>{f.head.timestamp=999939n;},f=>{f.head.timestamp=1000016n;},
    f=>{f.client.getBlock=async args=>({...f.head,hash:args?'0x'+'cd'.repeat(32):f.head.hash});},
    f=>{let count=0;f.now=()=>++count===1?1000000000:1000061000;}]){
    const f=fixture();mutate(f);await assert.rejects(inspectStockUsdg(f));
  }
});
test('explicit heartbeat policy accepts asynchronous observations, expires each source and keeps depeg guard',()=>{
  const p=policy();delete p.maxAge;Object.assign(p,CHAINLINK_API3_HEARTBEAT_POLICY);
  p.rounds[0][3]=p.timestamp-89999n;
  assert.equal(evaluateUsdgRounds(p).engineRoundChecksPassed,true);
  p.rounds[0][3]--;assert.ok(evaluateUsdgRounds(p).issues.includes('source-1-stale'));
  p.rounds[0][3]=p.timestamp;p.rounds[1][3]=p.timestamp-90000n;
  assert.ok(evaluateUsdgRounds(p).issues.includes('source-2-stale'));
  p.rounds[1][3]=p.timestamp;p.rounds[1][1]=800000000000000000n;
  assert.ok(evaluateUsdgRounds(p).issues.includes('source-price-deviation'));
  p.rounds[0][1]=80000000n;assert.equal(evaluateUsdgRounds(p).engineRoundChecksPassed,true);
});
test('independent budgets cannot share grace; mixed legacy/new configuration is rejected',()=>{
  const p=policy();delete p.maxAge;Object.assign(p,CHAINLINK_API3_HEARTBEAT_POLICY,{primaryMaxAge:3600n});
  p.rounds[0][3]=p.timestamp-3600n;p.rounds[1][3]=p.timestamp-89999n;
  assert.deepEqual(evaluateUsdgRounds(p).issues,['source-1-stale']);
  p.maxAge=3600n;assert.throws(()=>evaluateUsdgRounds(p));delete p.maxAge;
  for(const value of [0n,90001n,90000]){
    p.primaryMaxAge=value;assert.throws(()=>evaluateUsdgRounds(p));
  }
});
