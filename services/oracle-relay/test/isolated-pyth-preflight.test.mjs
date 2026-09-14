import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from '../src/deps.mjs';
import {PYTH_VERIFIER} from '../src/pyth.mjs';
import {CASHCAT_PAIR as policy,evaluatePair,verifyMetadata,probePair,safePreflightError} from '../src/isolated-pyth-preflight.mjs';
import {envelope as encodeEnvelope} from './fixtures/isolated-pyth.mjs';

const second=1000000n, now=1800000000n;
const base = {timestampUs:now*second,sourceUs:now*second,price:100000000n,confidence:10000n,exponent:-8,publishers:3,session:0};
const feeds = () => [{...base,id:3441,price:200000000n},{...base,id:232}];
const symbols = () => [
  {symbol:policy.collateralSymbol,pyth_lazer_id:3441,state:'stable',instrument_type:'spot',asset_type:'crypto',exponent:-8,min_publishers:2},
  {symbol:policy.usdgSymbol,pyth_lazer_id:232,state:'stable',instrument_type:'spot',asset_type:'crypto',exponent:-8,min_publishers:3},
];
const caller='0x1111111111111111111111111111111111111111';
const hash='0x'+'12'.repeat(32), runtime='0x60016000';
// Synthetic transport fixture only. Signature verification is mocked in these unit tests.
const envelope=(values=feeds())=>encodeEnvelope(values);
function fixture(values=feeds()) {
  const calls=[], signed=envelope(values);
  const block={number:50n,hash,timestamp:now};
  const client={
    getChainId:async()=>4663,
    getBlock:async options=>{calls.push(['block',options]);return block;},
    getCode:async options=>{calls.push(['code',options]);return runtime;},
    readContract:async options=>{
      calls.push(['read',options]);
      return options.functionName==='verification_fee'?1n:options.address===policy.collateral?18:6;
    },
    simulateContract:async options=>{calls.push(['simulate',options]);return {result:['0x'+signed.slice(144),caller]};},
  };
  return {calls,client,args:{client,key:'fake-test-key',verifierCodeHash:keccak256(runtime),caller,
    now:()=>Number(now*1000n),getSymbols:async()=>symbols(),getPrices:async()=>({signed})}};
}
test('conservative USDG ratio and oldest source match contract units',()=>{
  const f=feeds();f[0].sourceUs-=second;
  const q=evaluatePair(f,now);
  assert.equal(q.answer,(200000000n-10000n)*10n**18n/(100000000n+10000n));
  assert.equal(q.roundId,(now-1n)*second);assert.equal(q.updatedAt,now-1n);
  assert.equal(q.available,true);
});
test('USDG depeg changes ratio; zero confidence remains valid',()=>{
  const f=feeds();f[0].confidence=0n;f[1].confidence=0n;f[1].price=50000000n;
  assert.equal(evaluatePair(f,now).answer,4n*10n**18n);
});
test('independent exponents preserve token unit conversion',()=>{
  const f=feeds();f[0]={...f[0],price:2n,confidence:0n,exponent:0};f[1].confidence=0n;
  assert.equal(evaluatePair(f,now).answer,2n*10n**18n);
});
test('exact freshness boundaries fail, including fresh envelope with stale source',()=>{
  for(const [field,age,code] of [['timestampUs',30n,'report_stale'],['sourceUs',60n,'price_stale']]){
    const f=feeds();for(const x of f)x[field]-=age*second;
    assert.ok(evaluatePair(f,now).issues.some(i=>i.code===code));
  }
  const f=feeds();f[0].timestampUs+=1n;
  assert.ok(evaluatePair(f,now).issues.some(i=>i.code==='report_stale'));
});
test('pair skew is inclusive at threshold, rejects one microsecond beyond',()=>{
  const f=feeds();f[0].sourceUs-=10n*second;
  assert.equal(evaluatePair(f,now).available,true);
  f[0].sourceUs-=1n;assert.ok(evaluatePair(f,now).issues.some(i=>i.code==='pair_skew'));
});
test('all non-regular sessions and weak publishers fail even with current prices',()=>{
  for(const session of [1,2,3,4]){
    const f=feeds();f[0].session=session;assert.equal(evaluatePair(f,now).available,false);
  }
  const f=feeds();f[1].publishers=2;assert.equal(evaluatePair(f,now).available,false);
});
test('rejects unsafe confidence, nonpositive price and unsupported exponent',()=>{
  for(const patch of [{confidence:3000000n},{price:0n},{price:-1n},{exponent:-19},{exponent:1}]){
    const f=feeds();Object.assign(f[0],patch);assert.equal(evaluatePair(f,now).available,false);
  }
});
test('validates distinct feed identities and bounded policy before evaluating',()=>{
  assert.throws(()=>evaluatePair([feeds()[0],feeds()[0]],now),/FeedMismatch/);
  for(const patch of [{maxPriceAge:61},{maxPairSkew:61},{maxConfidenceBps:1001},{usdgMinPublishers:1},
    {collateralFeedId:232},{collateral:policy.usdg}]){
    assert.throws(()=>evaluatePair(feeds(),now,{...policy,...patch}),/InvalidPolicy/);
  }
});
test('catalog must match exact symbol, ID, kind and publisher requirements',()=>{
  assert.equal(verifyMetadata(symbols()).length,2);
  for(const patch of [{pyth_lazer_id:1},{state:'beta'},{instrument_type:'perpetual'},{asset_type:'equity'},{min_publishers:4}]){
    const s=symbols();Object.assign(s[0],patch);assert.throws(()=>verifyMetadata(s),/MetadataMismatch/);
  }
  assert.throws(()=>verifyMetadata([...symbols(),symbols()[0]]),/MetadataMismatch/);
});
test('read-only probe pins all chain reads, authenticates payload, never approves market',async()=>{
  const {args,calls}=fixture();const result=await probePair(args);
  assert.equal(result.signatureVerified,true);assert.equal(result.readyForAdapterTrial,true);
  assert.equal(result.marketApproved,false);assert.equal(result.productionChanged,false);
  assert.equal(result.exactTokenBindingReviewed,false);assert.equal(result.publisherIndependenceReviewed,false);
  for(const [kind,options] of calls)if(kind!=='block')assert.equal(options.blockNumber,50n);
  const simulation=calls.find(([kind])=>kind==='simulate')[1];
  assert.equal(simulation.address,PYTH_VERIFIER);assert.equal(simulation.value,1n);
  assert.equal(simulation.account,caller);assert.equal(simulation.functionName,'verifyUpdate');
  assert.equal(JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v).includes('fake-test-key'),false);
});
test('rejects wrong chain and changed verifier runtime before simulation',async()=>{
  for(const code of ['WrongChain','VerifierRuntimeMismatch']){
    const f=fixture();
    if(code==='WrongChain')f.client.getChainId=async()=>1;
    else f.args.verifierCodeHash='0x'+'ab'.repeat(32);
    await assert.rejects(probePair(f.args),new RegExp(code));
    assert.equal(f.calls.some(([kind])=>kind==='simulate'),false);
  }
});
test('rejects substituted payload or missing authenticated signer',async()=>{
  for(const result of [['0xab',caller],['0x'+envelope().slice(144),'0x'+'00'.repeat(20)]]){
    const f=fixture();f.client.simulateContract=async()=>({result});
    await assert.rejects(probePair(f.args),/VerificationResultMismatch/);
  }
});
test('does not trust unsigned fields returned alongside signed envelope',async()=>{
  const f=fixture();f.args.getPrices=async()=>({signed:envelope(),feeds:[{id:3441,price:1n}],timestampUs:0n});
  const result=await probePair(f.args);assert.equal(result.quote.answer,evaluatePair(feeds(),now).answer);
});
test('rejects signed feed substitution and catalog exponent mismatch',async()=>{
  for(const patch of [{id:1},{exponent:-7}]){
    const values=feeds();Object.assign(values[0],patch);const f=fixture(values);
    await assert.rejects(probePair(f.args),/FeedMismatch|MetadataMismatch/);
  }
});
test('quality failure does not become a signature failure or a usable quote',async()=>{
  const values=feeds();values[0].session=4;
  const result=await probePair(fixture(values).args);
  assert.equal(result.signatureVerified,true);assert.equal(result.readyForAdapterTrial,false);
  assert.equal(result.quote.available,false);
});
test('detects canonical block changes and stale or future RPC heads',async()=>{
  const f=fixture();const get=f.client.getBlock;
  f.client.getBlock=async options=>({...await get(options),hash:options?'0x'+'34'.repeat(32):hash});
  await assert.rejects(probePair(f.args),/ReorgDetected/);
  for(const offset of [-1,30000]){
    const g=fixture();g.args.now=()=>Number(now*1000n)+offset;
    await assert.rejects(probePair(g.args),/StaleHead/);
  }
});
test('slow verification cannot return an expired quote as ready',async()=>{
  const f=fixture();let clockCalls=0;
  f.args.now=()=>Number(now*1000n)+(clockCalls++===0?0:30000);
  await assert.rejects(probePair(f.args),/StaleHead/);
});
test('fee cap and token decimals are checked before simulation',async()=>{
  for(const [target,value,code] of [['verification_fee',1000000001n,'VerificationFeeExceeded'],['decimals',9,'TokenDecimalsMismatch']]){
    const f=fixture(),read=f.client.readContract;
    f.client.readContract=async options=>options.functionName===target?value:read(options);
    await assert.rejects(probePair(f.args),new RegExp(code));
    assert.equal(f.calls.some(([kind])=>kind==='simulate'),false);
  }
});
test('errors never relay provider response bodies, URLs or credentials',async()=>{
  const f=fixture();f.args.getPrices=async()=>{throw Object.assign(new Error('secret-key in response'),{name:'PythEntitlementDenied'});};
  try {await probePair(f.args);assert.fail('expected rejection');}
  catch(error){assert.equal(safePreflightError(error),'PythEntitlementDenied');}
  assert.equal(safePreflightError(new Error('https://rpc/secret-key')),'ReadOnlyProbeFailed');
});
