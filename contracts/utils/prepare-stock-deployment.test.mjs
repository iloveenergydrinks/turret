import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ContractFunctionZeroDataError,decodeAbiParameters,encodeAbiParameters,getContractAddress,keccak256} from 'viem';
import {stockConfigParameter,stockIdentities,encodeStockConfiguration,stockDeploymentData,preflightStockDeployment} from './prepare-stock-deployment.mjs';
import {verifyStockDeployment} from './verify-stock-deployment.mjs';
import {addr,fixtureCode,stockInput} from './stock-deployment.fixtures.mjs';
const compiled=JSON.parse(readFileSync(new URL('../out/DockyardStockMarketDeployment.sol/DockyardStockMarketDeployment.json',import.meta.url)));
function context(){
  const reads=[],block={number:123n,timestamp:1000000n,hash:'0x'+'ab'.repeat(32),gasLimit:30000000n};
  return {input:stockInput(),artifact:compiled,deployer:addr(99),block,reads,now:()=>1000000000,
    client:{getChainId:async()=>4663,getBlock:async()=>block,getCode:async args=>{reads.push(args);return fixtureCode;},
      readContract:async args=>{reads.push(args);if(args.functionName==='aggregator')throw new ContractFunctionZeroDataError({functionName:'aggregator'});return addr(50);},getTransactionCount:async()=>5,
      estimateGas:async args=>{reads.push(args);return 1000000n;}}};
}
test('stock encoding matches compiled ABI and preserves exact integer units',()=>{
  const input=stockInput();input.debtLimit='9007199254740993';
  const p=encodeStockConfiguration(input),data=stockDeploymentData(p,compiled);
  const params=compiled.abi.find(a=>a.type==='constructor').inputs;
  assert.equal(data.data,compiled.bytecode.object+encodeAbiParameters(params,[p.config,p.configHash]).slice(2));
  assert.equal(p.configHash,keccak256(p.encoded));
  assert.equal(decodeAbiParameters([stockConfigParameter],p.encoded)[0].debtLimit,9007199254740993n);
  assert.equal(p.symbol,'AAPL');
});
test('all ten stock/feed pairs accepted; deferred tokens and mismatched feeds rejected',()=>{
  assert.equal(stockIdentities.length,10);
  for(const stock of stockIdentities){
    const c=stockInput();c.credit.collateral=stock.collateral;c.credit.primary=stock.primary;
    assert.equal(encodeStockConfiguration(c).symbol,stock.symbol);
  }
  for(const token of [addr(77),'0x020bfc650a365f8bb26819deaabf3e21291018b4','0x39dBED3a2bd333467115dE45665cC57F813C4571']){
    const c=stockInput();c.credit.collateral=token;assert.throws(()=>encodeStockConfiguration(c),/Unsupported/);
  }
  const c=stockInput();c.credit.primary=stockIdentities[1].primary;assert.throws(()=>encodeStockConfiguration(c),/Unsupported/);
});
test('configuration has strict shape and no credential fields',()=>{
  for(const mutate of [c=>delete c.deadline,c=>{c.secret='private';},c=>{c.credit.key='private';},c=>{c.usdgPricing.extra=true;},c=>{c.pins={};}]){
    const c=stockInput();mutate(c);assert.throws(()=>encodeStockConfiguration(c),/fields/);
  }
});
test('canonical integer strings and ABI bounds enforced',()=>{
  for(const value of [1,1n,'01','1e3','-1','1.5',' 1','+1',null,(1n<<256n).toString()]){
    const c=stockInput();c.debtLimit=value;assert.throws(()=>encodeStockConfiguration(c));
  }
  for(const [key,value] of [['primaryMaxAge','4294967296'],['secondaryMaxAge','4294967296'],['maxDeviationBps','65536']]){
    const c=stockInput();c.usdgPricing[key]=value;assert.throws(()=>encodeStockConfiguration(c),/ABI range/);
  }
});
test('nonzero pins, distinct dependencies and external owner/treasury required',()=>{
  for(const mutate of [c=>{c.chainId='1';},c=>{c.credit.usdg=addr(1);},c=>{c.credit.guardian=addr(0);},
    c=>{c.executionGate=c.credit.secondary;},c=>{c.usdgPricing.primary=c.usdgPricing.secondary;},
    c=>{c.usdgPricing.primary=c.credit.primary;},c=>{c.treasury=c.executionGate;},c=>{c.credit.guardian=c.credit.usdg;},
    c=>{c.pins.usdgPrimary='0x'+'00'.repeat(32);}]){
    const c=stockInput();mutate(c);assert.throws(()=>encodeStockConfiguration(c));
  }
});
test('contract risk bounds and independent USDG pricing settings enforced',()=>{
  for(const [key,value] of [['staleness','59'],['staleness','86401'],['deviationBps','201'],['minimumDebt','0'],
    ['maxLtvBps','0'],['maxLtvBps','4000'],['liquidationLtvBps','10000'],['bonusBps','1501']]){
    const c=stockInput();c.credit[key]=value;assert.throws(()=>encodeStockConfiguration(c));
  }
  for(const [key,value] of [['debtLimit','999999'],['revenueFeeBps','2001'],['borrowAprBps','10001']]){
    const c=stockInput();c[key]=value;assert.throws(()=>encodeStockConfiguration(c));
  }
  for(const [key,value] of [['primaryMaxAge','0'],['primaryMaxAge','90001'],['secondaryMaxAge','0'],['secondaryMaxAge','90001'],['maxTimestampSkew','0'],['maxTimestampSkew','301'],['maxDeviationBps','0'],['maxDeviationBps','201']]){
    const c=stockInput();c.usdgPricing[key]=value;assert.throws(()=>encodeStockConfiguration(c));
  }
  const c=stockInput();c.credit.liquidationLtvBps='9000';c.credit.bonusBps='1500';assert.throws(()=>encodeStockConfiguration(c));
});
test('changed constructor ABI, placeholders and oversized initcode rejected',()=>{
  const p=encodeStockConfiguration(stockInput());
  const a=structuredClone(compiled);a.abi.find(a=>a.type==='constructor').inputs[1].name='oldHash';
  assert.throws(()=>stockDeploymentData(p,a),/ABI/);
  for(const object of ['0x','0x__PLACEHOLDER__','0x'+'00'.repeat(49152)])assert.throws(()=>stockDeploymentData(p,{...compiled,bytecode:{object}}));
});
test('heartbeat budgets are explicit, hashed separately and never inferred from legacy fields',()=>{
  const c=stockInput();
  c.usdgPricing.primaryMaxAge='90000';c.usdgPricing.secondaryMaxAge='90000';c.usdgPricing.maxTimestampSkew='90000';
  const hash=encodeStockConfiguration(c).configHash;
  c.usdgPricing.secondaryMaxAge='3600';
  assert.notEqual(encodeStockConfiguration(c).configHash,hash);
  delete c.usdgPricing.primaryMaxAge;delete c.usdgPricing.secondaryMaxAge;c.usdgPricing.maxAge='90000';
  assert.throws(()=>encodeStockConfiguration(c),/fields/);
});
test('preflight pins snapshot, simulates without writes and predicts only engine/pool assembly',async()=>{
  const c=context(),p=await preflightStockDeployment(c);
  assert.equal(p.predicted.bundle,getContractAddress({from:c.deployer,nonce:5n}));
  assert.equal(p.predicted.engine,getContractAddress({from:p.predicted.bundle,nonce:1n}));
  assert.equal(p.predicted.pool,getContractAddress({from:p.predicted.bundle,nonce:2n}));
  assert.equal(Object.keys(p.predicted).length,3);assert.equal(c.reads.length,13);
  assert.equal(p.usdgSourceIdentity.independenceVerified,false);
  assert.ok(c.reads.every(r=>r.blockNumber===123n));assert.equal(p.gasLimit,1200000n);
  assert.equal(p.productionApproved,false);assert.equal(p.borrowingEnabled,false);
});
test('deployment rejects distinct USDG proxies sharing an aggregator before simulation',async()=>{
  const c=context(),original=c.client.readContract;
  c.client.readContract=async args=>args.functionName==='aggregator'&&args.address!==addr(70)?addr(70):original(args);
  c.client.estimateGas=async()=>assert.fail('Shared source must not reach constructor simulation');
  await assert.rejects(preflightStockDeployment(c),/share an exposed oracle dependency/);
});
test('wrong chain, stale head, expired deadline, runtime drift and pending nonce block simulation',async()=>{
  for(const mutate of [c=>{c.client.getChainId=async()=>1;},c=>{c.block.timestamp=999939n;},c=>{c.block.timestamp=1000016n;},
    c=>{c.input.deadline='999999';},c=>{c.input.deadline='1086401';},c=>{c.client.getCode=async()=>undefined;},
    c=>{c.client.getCode=async()=>'0x61';},c=>{c.client.getTransactionCount=async args=>args.blockTag?6:5;},
    c=>{c.client.readContract=async()=>c.input.credit.guardian;}]){
    const c=context();mutate(c);c.client.estimateGas=async()=>assert.fail('Must not simulate');await assert.rejects(preflightStockDeployment(c));
  }
});
test('reorg, nonce race, expired snapshot, gas capacity and internal roles fail closed',async()=>{
  for(const mutate of [c=>{c.client.getBlock=async args=>({...c.block,hash:args?'0x'+'cd'.repeat(32):c.block.hash});},
    c=>{let n=0;c.now=()=>++n===1?1000000000:1000061000;},
    c=>{let n=0;c.client.getTransactionCount=async()=>++n===3?6:5;},c=>{c.block.gasLimit=1199999n;},
    c=>{c.input.treasury=getContractAddress({from:c.deployer,nonce:5n});},
    c=>{c.client.readContract=async()=>c.input.executionGate;},c=>{c.client.estimateGas=async()=>{throw Error('simulation failed');};}]){
    const c=context();mutate(c);await assert.rejects(preflightStockDeployment(c));
  }
});
test('commissioning refuses unsafe URLs, missing evidence and reduced confirmation depth without RPC',async()=>{
  const args={input:stockInput(),artifact:compiled,deployer:addr(99),keeper:addr(50),riskMonitorUrl:'https://risk.example',txHash:'0x'+'ab'.repeat(32)};
  for(const url of ['http://risk.example','https://risk.example?key=secret','https://secret@risk.example','https://risk.example/path','file:///tmp/risk','https://risk.example/#secret']){
    await assert.rejects(verifyStockDeployment({...args,riskMonitorUrl:url}),/origin/);
  }
  await assert.rejects(verifyStockDeployment({...args,confirmations:1}),/confirmations/);
  await assert.rejects(verifyStockDeployment(args),/runtimes required/);
});
