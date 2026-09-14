import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters,encodeEventTopics,parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Store } from '../src/store.mjs';
import { Transactions, ReceiptValidationError } from '../src/transactions.mjs';
import { vaultAbi } from '../src/abi.mjs';

const account=privateKeyToAccount('0x'+'01'.padStart(64,'0'));
const vault='0x0000000000000000000000000000000000000002';
const collateral='0x0000000000000000000000000000000000000003';
const borrower='0x0000000000000000000000000000000000000004';
function harness(){
  const store=new Store(':memory:',{});store.acquireLease();
  const config={mode:'execute',chainId:4663,vault,usdg:vault,maxTxFee:1000000000n,maxDailyGas:10000000000n,minEth:1n,confirmations:2n,replaceAfterMs:1,maxReplacements:3,dailyBudget:100n,inventoryBudget:100n,maxRepay:50n};
  const receiptMissing=Object.assign(new Error(),{name:'TransactionReceiptNotFoundError'});
  const chain={account,consistent:true,client:{
    getTransactionCount:async()=>0,getBalance:async()=>10n**18n,
    sendRawTransaction:async()=>{throw new Error('Ambiguous timeout');},
    getTransactionReceipt:async()=>{throw receiptMissing;},getBlock:async()=>({hash:'blockhash'}),
  },wallet:{prepareTransactionRequest:async args=>({...args,chainId:4663,type:'legacy',gas:21000n,gasPrice:1n})}};
  return {store,config,chain,txs:new Transactions(chain,store,config)};
}
test('ambiguous broadcast retains signed intent; replacements keep nonce and calldata',async()=>{
  const {store,chain,config,txs}=harness();
  const alerts=await txs.submit('liquidation',vault,'0x',{maxRepay:20n,collateral,borrower});
  assert.equal(alerts[0].code,'broadcast_uncertain');
  const before=store.pendingTx();
  assert.equal(before.request.nonce,0);assert.equal(before.attempts.length,1);
  await new Promise(resolve=>setTimeout(resolve,5));
  await txs.recover({number:100n},true);
  const after=store.pendingTx();
  assert.equal(after.attempts.length,2);assert.equal(after.request.nonce,0);assert.equal(after.request.data,'0x');
  assert.ok(after.request.gasPrice > before.request.gasPrice);
  assert.equal(store.budgets().inventory,20n);
  await assert.rejects(txs.submit('approval',vault,'0x'),/Pending/);
  store.close();
});
test('unknown nonce consumption blocks new sends instead of silently incrementing nonce',async()=>{
  const {store,chain,txs}=harness();
  await txs.submit('approval',vault,'0x',{maxRepay:0n});
  chain.client.getTransactionCount=async()=>1;
  const incidents=await txs.recover({number:100n},true);
  assert.equal(incidents[0].code,'nonce_consumed');assert.equal(store.pendingTx().status,'blocked');
  store.close();
});
test('switching to observe never rebroadcasts or replaces a journaled transaction',async()=>{
  const {store,chain,config,txs}=harness();
  await txs.submit('risk_trip',vault,'0x1234');
  const before=store.pendingTx();
  config.mode='observe';
  chain.client.sendRawTransaction=async()=>{assert.fail('Observe mode broadcast');};
  chain.account={...account,signTransaction:async()=>{assert.fail('Observe mode signed a replacement');}};
  for(const replaceAfterMs of [1000000,0]){
    config.replaceAfterMs=replaceAfterMs;
    const incidents=await txs.recover({number:100n},true);
    assert.equal(incidents[0].code,'pending_execution_blocked');
    assert.deepEqual(store.pendingTx().attempts,before.attempts);
  }
  store.close();
});
test('canonical receipt needs confirmations and its exact liquidation event',async()=>{
  const {store,chain,txs}=harness();
  await txs.submit('liquidation',vault,'0x',{maxRepay:20n,collateral,borrower});
  const tx=store.pendingTx();
  const receipt={transactionHash:tx.attempts[0].hash,blockNumber:100n,blockHash:'blockhash',status:'success',gasUsed:21000n,effectiveGasPrice:1n,logs:[{
    address:vault,topics:encodeEventTopics({abi:vaultAbi,eventName:'Liquidated',args:{collateral,borrower,liquidator:account.address}}),
    data:encodeAbiParameters(parseAbiParameters('uint256,uint256'),[15n,100n]),
  }]};
  chain.client.getTransactionReceipt=async()=>receipt;
  await txs.recover({number:101n},false);assert.ok(store.pendingTx());
  await txs.recover({number:102n},false);assert.equal(store.pendingTx(),undefined);
  assert.equal(store.transactions()[0].actualRepay,15n);assert.equal(store.budgets().inventory,15n);
  store.close();
});
test('reverts release repayment reserve, retain gas cost, and establish a retry cooldown',async()=>{
  const {store,chain,txs}=harness();
  await txs.submit('liquidation',vault,'0x',{maxRepay:20n,collateral,borrower});
  chain.client.getTransactionReceipt=async()=>({transactionHash:store.pendingTx().attempts[0].hash,blockNumber:100n,blockHash:'blockhash',status:'reverted',gasUsed:20000n,effectiveGasPrice:1n,logs:[]});
  await txs.recover({number:102n},false);
  assert.deepEqual(store.budgets(),{daily:0n,inventory:0n,gas:20000n});
  assert.ok(store.get(`retry:${collateral}:${borrower}`)>Date.now());store.close();
});
test('oracle verification value is journaled and preserved across fee replacement',async()=>{
  const {store,txs}=harness();
  await txs.submit('oracle_update',vault,'0x1234',{},7n);
  assert.equal(store.pendingTx().request.value,7n);
  await new Promise(resolve=>setTimeout(resolve,5));
  await txs.recover({number:100n},true);
  assert.equal(store.pendingTx().request.value,7n);
  assert.equal(store.pendingTx().request.data,'0x1234');
  store.close();
});
test('oracle verification value cannot consume the gas reserve',async()=>{
  const {store,chain,txs}=harness();chain.client.getBalance=async()=>25205n;
  const incidents=await txs.submit('oracle_update',vault,'0x',{},7n);
  assert.equal(incidents[0].code,'gas_reserve');assert.equal(store.pendingTx(),undefined);store.close();
});
test('receipt extension retries transient read failures but durably blocks proven mismatches',async()=>{
  const {store,chain,txs}=harness();
  await txs.submit('isolated_oracle_update',vault,'0x1234');
  const hash=store.pendingTx().attempts[0].hash;
  chain.client.getTransactionReceipt=async()=>({transactionHash:hash,blockNumber:100n,blockHash:'blockhash',status:'success',gasUsed:20000n,effectiveGasPrice:1n,logs:[]});
  txs.confirmationDetails=async()=>{throw Error('temporary RPC read failure');};
  await assert.rejects(txs.recover({number:102n},false),/temporary/);
  assert.equal(store.pendingTx().status,'pending');
  txs.confirmationDetails=async()=>{throw new ReceiptValidationError('wrong cache contents');};
  const incidents=await txs.recover({number:102n},false);
  assert.equal(incidents[0].code,'transaction_receipt_mismatch');
  assert.equal(store.pendingTx().status,'blocked');
  assert.equal(store.pendingTx().actualGas,20000n);
  store.close();
});
