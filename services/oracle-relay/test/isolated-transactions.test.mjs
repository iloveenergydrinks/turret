import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {publicationIntent,confirmedPublication,verificationValueReserved,IsolatedOracleTransactions} from '../src/isolated-transactions.mjs';
import {isolatedHubAbi} from '../src/isolated-publication.mjs';
import {envelope} from './fixtures/isolated-pyth.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {encodeFunctionData,encodeEventTopics,encodeAbiParameters,parseAbiParameters,keccak256}=require('viem');
const hub='0x'+'11'.repeat(20),account='0x'+'22'.repeat(20),hash='0x'+'ab'.repeat(32);
const publication={hub,policy:{collateralFeedId:3441,usdgFeedId:232}};
function fixture() {
  const base={timestampUs:1000000000n,sourceUs:999000000n,price:100000000n,confidence:10000n,publishers:3,exponent:-8,session:0};
  const feeds=[{...base,id:3441},{...base,id:232}];
  const logs=feeds.map(f=>({address:hub,topics:encodeEventTopics({abi:isolatedHubAbi,eventName:'ReportUpdated',args:{feedId:f.id}}),
    data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint16'),[f.timestampUs,f.sourceUs,f.session])}));
  const tx={kind:'isolated_oracle_update',attempts:[{hash}],request:{to:hub,value:1n,data:encodeFunctionData({abi:isolatedHubAbi,functionName:'update',args:[envelope(feeds)]})}};
  const receipt={from:account,to:hub,transactionHash:hash,blockNumber:123n,logs};
  const cached=Object.fromEntries(feeds.map(f=>[f.id,{timestampUs:f.timestampUs,feedUpdateTimestampUs:f.sourceUs,price:f.price,
    confidence:f.confidence,publishers:f.publishers,exponent:f.exponent,session:f.session}]));
  const reads=[];
  const context={publication,account,client:{readContract:async args=>{reads.push(args);return cached[args.args[0]];}}};
  return {tx,receipt,cached,context,reads};
}
test('confirmed publication requires exact events and cache contents at the receipt block',async()=>{
  const f=fixture(),result=await confirmedPublication(f.receipt,f.tx,f.context);
  assert.deepEqual(result.publicationResult.updatedFeedIds,[3441,232]);
  assert.deepEqual(result.publicationResult.supersededFeedIds,[]);
  assert.ok(f.reads.every(r=>r.blockNumber===123n));
});
test('permissionless publication races are recorded as no-ops, not our updates',async()=>{
  for(const newer of [false,true]){
    const f=fixture();f.receipt.logs=[];
    if(newer)for(const value of Object.values(f.cached)){value.timestampUs+=1n;value.price=123n;}
    const result=await confirmedPublication(f.receipt,f.tx,f.context);
    assert.deepEqual(result.publicationResult.updatedFeedIds,[]);
    assert.deepEqual(result.publicationResult.supersededFeedIds,[3441,232]);
  }
});
test('wrong receipt identity or journal operation cannot confirm',async()=>{
  for(const mutate of [f=>{f.receipt.from=hub;},f=>{f.receipt.to=account;},f=>{f.receipt.transactionHash='0x'+'cd'.repeat(32);},f=>{f.tx.kind='approval';}]){
    const f=fixture();mutate(f);await assert.rejects(confirmedPublication(f.receipt,f.tx,f.context));
  }
});
test('duplicated, removed or altered publication events cannot confirm',async()=>{
  for(const mutate of [f=>{f.receipt.logs.push(f.receipt.logs[0]);},f=>{f.receipt.logs[0].removed=true;},f=>{f.receipt.logs[0].data='0x';},
    f=>{f.receipt.logs[0].data=encodeAbiParameters(parseAbiParameters('uint64,uint64,uint16'),[1000000000n,999000000n,4]);}]){
    const f=fixture();mutate(f);await assert.rejects(confirmedPublication(f.receipt,f.tx,f.context));
  }
});
test('older or altered cache contents cannot confirm a successful receipt',async()=>{
  for(const field of ['timestampUs','feedUpdateTimestampUs','price','confidence','publishers','exponent','session']){
    const f=fixture();f.cached[3441][field]=BigInt(f.cached[3441][field])-1n;
    await assert.rejects(confirmedPublication(f.receipt,f.tx,f.context));
  }
});
test('publication intent restricts target, fee and signed feed identities',()=>{
  const f=fixture();assert.equal(publicationIntent(f.tx.request,publication).report.feeds.length,2);
  for(const patch of [{to:account},{value:-1n},{value:1000000001n},{data:'0x1234'}])assert.throws(()=>publicationIntent({...f.tx.request,...patch},publication));
  assert.throws(()=>publicationIntent(f.tx.request,{...publication,policy:{collateralFeedId:1,usdgFeedId:2}}),/feeds/);
});
test('value reserves never age pending or blocked intents out and count replacements once',()=>{
  const now=1800000000000;
  const tx=status=>({kind:'isolated_oracle_update',status,createdAt:now-172800000,request:{value:7n},attempts:[{},{}]});
  assert.equal(verificationValueReserved([tx('pending'),tx('blocked')],now),14n);
  assert.equal(verificationValueReserved([tx('reverted')],now),0n);
  assert.equal(verificationValueReserved([{...tx('confirmed'),verificationFeeConfirmedAt:now}],now),7n);
  assert.equal(verificationValueReserved([{...tx('confirmed'),verificationFeeConfirmedAt:now-86400000}],now),0n);
  assert.equal(verificationValueReserved([tx('confirmed')],now),7n,'legacy confirmation without time remains reserved');
  assert.equal(verificationValueReserved([{...tx('confirmed'),verificationFeeConfirmedAt:now+10000}],now),7n,'clock rollback cannot free budget');
});
test('malformed publication records cannot silently free verification budget',()=>{
  for(const patch of [{status:'unknown'},{request:{value:-1n}},{request:{value:1000000001n}},
    {status:'confirmed',verificationFeeConfirmedAt:NaN}]){
    assert.throws(()=>verificationValueReserved([{kind:'isolated_oracle_update',status:'pending',request:{value:1n},...patch}],1800000000000));
  }
});
test('exhausted verification budget stops before signing or RPC calls; exact remaining budget is allowed',async()=>{
  const f=fixture();let sent=0;
  const store={pendingTx:()=>undefined,transactions:()=>[{...f.tx,status:'confirmed',verificationFeeConfirmedAt:1800000000000}]};
  const config={mode:'execute',publication,maxDailyVerificationValue:1n};
  const manager=new IsolatedOracleTransactions({},store,config,{now:()=>1800000000000});
  manager.submit=async()=>{sent++;return [];};
  const plan={hub,signatureVerified:true,shouldSubmit:true,...f.tx.request};
  assert.equal((await manager.publish(plan))[0].code,'oracle_verification_budget');assert.equal(sent,0);
  config.maxDailyVerificationValue=2n;assert.deepEqual(await manager.publish(plan),[]);assert.equal(sent,1);
});
test('last signing check enforces value budget and preserves replacement identity',async()=>{
  const f=fixture(),runtime='0x6000',pin=keccak256(runtime);let pending,signs=0;
  const config={publication:{...publication,hubCodeHash:pin,verifierCodeHash:pin},maxDailyVerificationValue:1n};
  const store={assertLease(){},pendingTx:()=>pending,transactions:()=>pending?[pending]:[]};
  const chain={account:{address:account,async signTransaction(){signs++;return '0x1234';}},client:{
    async getBlock(){return {number:123n,timestamp:1000n,hash};},async getCode(){return runtime;},async simulateContract(){},
  }};
  const manager=new IsolatedOracleTransactions(chain,store,config,{now:()=>1000000});
  const request={...f.tx.request,nonce:3};
  await manager.makeAttempt(request);assert.equal(signs,1);
  pending={...f.tx,request,status:'pending'};
  await manager.makeAttempt({...request,gasPrice:2n});assert.equal(signs,2,'same-nonce replacement does not double reserve value');
  await assert.rejects(manager.makeAttempt({...request,nonce:4}),/intent/);
  await assert.rejects(manager.makeAttempt({...request,value:2n}),/intent/);
  pending=undefined;await assert.rejects(manager.makeAttempt({...request,value:2n}),/budget/);
  assert.equal(signs,2);
});
