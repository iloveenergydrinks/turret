import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {decodeAbiParameters,encodeAbiParameters,getContractAddress,keccak256} from 'viem';
import {configParameter,encodeConfiguration,deploymentData,preflightDeployment} from './prepare-isolated-deployment.mjs';

const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const code='0x60006000';
const hash=keccak256(code);
function input() {
  return {chainId:'4663',deadline:'1000300',credit:{usdg:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    collateral:'0x020bfc650a365f8bb26819deaabf3e21291018b4',primary:addr(10),secondary:addr(11),guardian:addr(12),
    staleness:'3600',maxLtvBps:'5000',liquidationLtvBps:'6500',bonusBps:'500',deviationBps:'500',minimumDebt:'1000000'},
    treasury:addr(13),debtLimit:'10000000000',revenueFeeBps:'1000',borrowAprBps:'1000',
    intermediate:addr(14),firstPool:addr(15),secondPool:addr(16),factory:addr(17),
    pins:Object.fromEntries(['usdg','collateral','primary','secondary','intermediate','firstPool','secondPool','factory'].map(k=>[k,hash]))};
}
function artifact() {return {abi:[{type:'constructor',inputs:[configParameter,{name:'expectedConfigHash',type:'bytes32'}]}],bytecode:{object:code}};}
function context() {
  const reads=[];
  const block={number:123n,timestamp:1000000n,hash:'0x'+'ab'.repeat(32),gasLimit:30000000n};
  const client={
    async getChainId(){return 4663;},async getBlock(){return block;},
    async getCode(args){reads.push(args);return code;},
    async getTransactionCount(){return 5;},
    async estimateGas(args){reads.push(args);return 1000000n;},
  };
  return {input:input(),artifact:artifact(),deployer:addr(99),client,now:()=>1000000000,reads,block};
}

test('encoding preserves exact integer units, field order and compiled constructor ABI',()=>{
  const c=input();c.debtLimit='9007199254740993';
  const prepared=encodeConfiguration(c);
  const decoded=decodeAbiParameters([configParameter],prepared.encoded)[0];
  assert.equal(decoded.debtLimit,9007199254740993n);
  assert.equal(prepared.configHash,keccak256(prepared.encoded));
  const compiled=JSON.parse(readFileSync(new URL('../out/DockyardIsolatedMarketDeployment.sol/DockyardIsolatedMarketDeployment.json',import.meta.url),'utf8'));
  const result=deploymentData(prepared,compiled);
  const params=compiled.abi.find(a=>a.type==='constructor').inputs;
  assert.equal(result.data,compiled.bytecode.object+encodeAbiParameters(params,[prepared.config,prepared.configHash]).slice(2));
  const [roundTrip,digest]=decodeAbiParameters(params,'0x'+result.data.slice(compiled.bytecode.object.length));
  assert.equal(roundTrip.debtLimit,9007199254740993n);assert.equal(digest,prepared.configHash);
});
test('missing fields, unexpected fields and accidental credentials are rejected',()=>{
  for(const mutate of [c=>delete c.deadline,c=>{c.extra=true;},c=>{c.privateKey='not-a-key';},c=>{c.credit.extra=true;},c=>{c.pins={};}]) {
    const c=input();mutate(c);assert.throws(()=>encodeConfiguration(c));
  }
});
test('integer strings and ABI bounds are strict',()=>{
  for(const v of [1000,1000n,'01','1e3','1.5','-1',' 1','+1',null,(1n<<256n).toString()]){
    const c=input();c.debtLimit=v;assert.throws(()=>encodeConfiguration(c));
  }
  const c=input();c.borrowAprBps='65536';assert.throws(()=>encodeConfiguration(c),/ABI range/);
});
test('canonical assets, nonzero addresses and distinct dependencies required',()=>{
  for(const mutate of [c=>{c.chainId='1';},c=>{c.credit.usdg=addr(1);},c=>{c.credit.collateral=addr(2);},
    c=>{c.credit.guardian=addr(0);},c=>{c.credit.primary=c.credit.secondary;},c=>{c.firstPool=c.secondPool;},
    c=>{c.intermediate=c.credit.usdg;},c=>{c.pins.factory='0x'+'00'.repeat(32);}]) {
    const c=input();mutate(c);assert.throws(()=>encodeConfiguration(c));
  }
  const c=input();c.credit.collateral='0x39dbed3a2bd333467115de45665cc57f813c4571';assert.doesNotThrow(()=>encodeConfiguration(c));
});
test('unsafe or unusable risk parameters rejected before any RPC request',()=>{
  for(const [key,value] of [['staleness','0'],['minimumDebt','0'],['maxLtvBps','6500'],['liquidationLtvBps','10000'],
    ['bonusBps','1501'],['deviationBps','0'],['deviationBps','2501']]) {
    const c=input();c.credit[key]=value;assert.throws(()=>encodeConfiguration(c));
  }
  for(const [key,value] of [['debtLimit','999999'],['revenueFeeBps','2001'],['borrowAprBps','10001']]){
    const c=input();c[key]=value;assert.throws(()=>encodeConfiguration(c));
  }
  const c=input();c.credit.liquidationLtvBps='9000';c.credit.bonusBps='1500';assert.throws(()=>encodeConfiguration(c));
});
test('changed ABI, unresolved bytecode and oversized initcode rejected',()=>{
  const prepared=encodeConfiguration(input());
  const a=artifact();a.abi[0].inputs[1].name='other';assert.throws(()=>deploymentData(prepared,a),/ABI/);
  for(const value of ['0x','0x__placeholder__','0x'+'00'.repeat(49152)]){
    const a=artifact();a.bytecode.object=value;assert.throws(()=>deploymentData(prepared,a));
  }
});
test('preflight pins reads and simulation, predicts addresses, and never claims approval',async()=>{
  const c=context(),result=await preflightDeployment(c);
  assert.equal(result.predicted.receipt,getContractAddress({from:c.deployer,nonce:5n}));
  assert.equal(result.predicted.engine,getContractAddress({from:result.predicted.receipt,nonce:1n}));
  assert.equal(result.gasLimit,1200000n);
  assert.equal(c.reads.length,9);
  assert.ok(c.reads.every(r=>r.blockNumber===123n));
  assert.equal(result.productionApproved,false);assert.equal(result.borrowingEnabled,false);
});
test('wrong chain, stale head and expired deadline prevent simulation',async()=>{
  for(const mutate of [c=>{c.client.getChainId=async()=>1;},c=>{c.block.timestamp=999939n;},c=>{c.block.timestamp=1000016n;},
    c=>{c.input.deadline='999999';},c=>{c.input.deadline='1086401';}]) {
    const c=context();mutate(c);c.client.estimateGas=async()=>assert.fail('Must not simulate');
    await assert.rejects(preflightDeployment(c));
  }
});
test('runtime mismatches and pending transactions prevent simulation',async()=>{
  for(const mutate of [c=>{c.client.getCode=async()=>undefined;},c=>{c.client.getCode=async()=>'0x61';},
    c=>{c.client.getTransactionCount=async args=>args.blockTag?6:5;}]) {
    const c=context();mutate(c);c.client.estimateGas=async()=>assert.fail('Must not simulate');
    await assert.rejects(preflightDeployment(c));
  }
});
test('reorg, aging snapshot, nonce race and block gas capacity fail closed',async()=>{
  for(const mutate of [c=>{c.client.getBlock=async args=>({...c.block,hash:args?'0x'+'cd'.repeat(32):c.block.hash});},
    c=>{let call=0;c.now=()=>++call===1?1000000000:1000061000;},
    c=>{let call=0;c.client.getTransactionCount=async()=>++call===3?6:5;},
    c=>{c.block.gasLimit=1199999n;}]) {
    const c=context();mutate(c);await assert.rejects(preflightDeployment(c));
  }
});
test('internal guardian/treasury and rejected constructor simulation never produce a plan',async()=>{
  const c=context();c.input.treasury=getContractAddress({from:c.deployer,nonce:5n});
  await assert.rejects(preflightDeployment(c),/Internal/);
  const d=context();d.client.estimateGas=async()=>{throw Error('constructor reverted');};
  await assert.rejects(preflightDeployment(d),/constructor reverted/);
});
