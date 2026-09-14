import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {encodeAbiParameters,encodeEventTopics,keccak256} from 'viem';
import {Store} from '../../liquidator/src/store.mjs';
import {Collector,abi,distribution} from '../src/collector.mjs';
const router='0x1111111111111111111111111111111111111111',pool='0x2222222222222222222222222222222222222222',sender='0x3333333333333333333333333333333333333333';
const raw='0xabcd',hash=keccak256(raw),blockHash='0x'+'12'.repeat(32);
const head={number:100n,hash:blockHash};
const event=(gross=100n,share=50n)=>({address:router,topics:encodeEventTopics({abi,eventName:'RevenueDistributed',args:{pool}}),data:encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'}],[gross,share,gross-share])});
function harness(t,options={}){
  const store=new Store(':memory:',{test:1});store.acquireLease();t.after(()=>store.close());
  let sends=0,signs=0;
  const client={readContract:async({functionName})=>({totalStaked:options.stake??1n,allowance:options.allowance??1000n,protocolFees:100n}[functionName]),
    getTransactionCount:async({blockTag})=>blockTag==='pending'?(options.pendingNonce??0):0,
    getBalance:async()=>options.balance??10000n,simulateContract:async()=>{},
    sendRawTransaction:async()=>{sends++;assert.equal(store.pendingTx()?.hash,hash,'journal must exist before submission');if(options.timeout)throw Error('timeout');return hash;},
    getTransactionReceipt:async()=>{if(options.receipt)return options.receipt;const e=Error('not found');e.name='TransactionReceiptNotFoundError';throw e;},
    getBlock:async()=>({hash:options.canonicalHash??blockHash})};
  const account={address:sender,signTransaction:async(request)=>{signs++;assert.equal(request.to,router);assert.equal(request.value,0n);return raw;}};
  const wallet={prepareTransactionRequest:async request=>({...request,chainId:4663,gas:100n,gasPrice:1n})};
  const config={router,staking:sender,usdg:pool,treasury:sender,pools:[pool],mode:'execute',minFees:10n,maxTxFee:1000n,maxDailyGas:1000n,minEth:10n,...options.config};
  const collector=new Collector({client,wallet,account,store,config,verify:async()=>head});
  return {collector,store,client,options,counts:()=>({sends,signs})};
}
test('only router collection is signed and durably stored before broadcast',async t=>{
  const h=harness(t);assert.equal((await h.collector.cycle()).reason,'pending');assert.deepEqual(h.counts(),{sends:1,signs:1});assert.equal(h.store.budgets().gas,120n);
});
test('uncertain broadcast reuses identical persisted bytes without signing again',async t=>{
  const h=harness(t,{timeout:true});assert.equal((await h.collector.cycle()).reason,'broadcast_uncertain');await h.collector.cycle();assert.deepEqual(h.counts(),{sends:2,signs:1});
});
for(const [name,options,reason]of[
  ['no stake',{stake:0n},'no_stakers'],['allowance missing',{allowance:0n},'treasury_allowance_required'],
  ['unknown nonce',{pendingNonce:1},'untracked_pending_nonce'],['gas reserve',{balance:100n},'gas_funding_required'],
  ['transaction budget',{config:{maxTxFee:100n}},'gas_budget_exceeded'],['daily budget',{config:{maxDailyGas:100n}},'gas_budget_exceeded'],
  ['observation',{config:{mode:'observe'}},'observe'],['threshold',{config:{minFees:101n}},'below_collection_threshold'],
])test(name+' prevents signing',async t=>{const h=harness(t,options);assert.equal((await h.collector.cycle()).reason,reason);assert.deepEqual(h.counts(),{sends:0,signs:0});});
const receipt=(extra={})=>({transactionHash:hash,from:sender,to:router,blockNumber:90n,blockHash,status:'success',gasUsed:90n,effectiveGasPrice:1n,logs:[event()],...extra});
test('confirmed receipt settles gas and verifies 50/50 event',async t=>{const h=harness(t);await h.collector.cycle();h.options.receipt=receipt();assert.equal((await h.collector.cycle()).reason,'confirmed');assert.equal(h.store.pendingTx(),undefined);assert.equal(h.store.budgets().gas,90n);});
test('receipt reorg retains pending intent',async t=>{const h=harness(t,{canonicalHash:'0xwrong'});await h.collector.cycle();h.options.receipt=receipt();assert.equal((await h.collector.cycle()).reason,'receipt_reorg');assert.ok(h.store.pendingTx());});
test('insufficient confirmations retain pending intent',async t=>{const h=harness(t);await h.collector.cycle();h.options.receipt=receipt({blockNumber:100n});assert.equal((await h.collector.cycle()).reason,'confirming');});
test('wrong receipt identity fails closed',async t=>{const h=harness(t);await h.collector.cycle();h.options.receipt=receipt({to:pool});await assert.rejects(h.collector.cycle(),/receipt_identity/);assert.ok(h.store.pendingTx());});
test('missing distribution blocks further work',async t=>{const h=harness(t);await h.collector.cycle();h.options.receipt=receipt({logs:[]});assert.equal((await h.collector.cycle()).reason,'distribution_mismatch');assert.equal((await h.collector.cycle()).reason,'manual_reconciliation_required');assert.deepEqual(h.counts(),{sends:1,signs:1});});
test('consumed nonce with no receipt blocks further work',async t=>{const h=harness(t);await h.collector.cycle();h.client.getTransactionCount=async()=>1;assert.equal((await h.collector.cycle()).reason,'nonce_consumed_without_receipt');assert.equal(h.store.pendingTx().status,'blocked');});
test('reverted transactions count toward spending limit',async t=>{const h=harness(t);await h.collector.cycle();h.options.receipt=receipt({status:'reverted',logs:[]});assert.equal((await h.collector.cycle()).reason,'reverted');assert.equal(h.store.budgets().gas,90n);});
test('RPC failure never becomes receipt-not-found or a new broadcast',async t=>{const h=harness(t);await h.collector.cycle();h.client.getTransactionReceipt=async()=>{throw Error('timeout');};await assert.rejects(h.collector.cycle(),/timeout/);assert.deepEqual(h.counts(),{sends:1,signs:1});});
test('full on-disk journal survives restart and retains unresolved gas beyond one day',()=>{
  const dir=mkdtempSync(join(tmpdir(),'staking-collector-'));let store;
  try{store=new Store(dir,{id:1});store.acquireLease();store.saveTx({id:hash,hash,raw,status:'pending',createdAt:Date.now()-2*86400000,feeReserve:100n});store.close();store=new Store(dir,{id:1});store.acquireLease();assert.equal(store.pendingTx().raw,raw);assert.equal(store.budgets().gas,100n);}
  finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('odd base-unit carry allows only floor or ceiling half',()=>{assert.equal(distribution({logs:[event(101n,51n)]},router,pool).stakerShare,51n);assert.throws(()=>distribution({logs:[event(100n,49n)]},router,pool),/split_mismatch/);assert.throws(()=>distribution({logs:[event(),event()]},router,pool),/event_mismatch/);});
