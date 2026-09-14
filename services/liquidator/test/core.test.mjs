import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liquidationQuote,feedHealth,USD } from '../src/risk.mjs';
import { Store } from '../src/store.mjs';
import { configFromEnv } from '../src/config.mjs';
import { syncPositions } from '../src/indexer.mjs';
import { createStatusServer } from '../src/http.mjs';
import { Alerts,incident } from '../src/alerts.mjs';
import { errorCode } from '../src/chain.mjs';

const borrower='0x0000000000000000000000000000000000000001';
const collateral='0x0000000000000000000000000000000000000002';
const identity={chainId:4663,vault:collateral};
function memory(){const store=new Store(':memory:',identity);store.acquireLease();return store;}

test('exact liquidation threshold, partial repayment, and collateral exhaustion match vault arithmetic',()=>{
  const args={collateral:USD,debt:70000000n,price:100n*USD,ltvBps:7000,bonusBps:500,scale:10n**12n,maxRepay:100000000n};
  assert.equal(liquidationQuote(args).eligible,false);
  // LTV getter rounds to 7000; exact _isSafe nevertheless rejects this debt.
  assert.equal(liquidationQuote({...args,debt:70000001n}).eligible,true);
  const partial=liquidationQuote({...args,debt:80000000n,maxRepay:10000000n});
  assert.equal(partial.repaid,10000000n);assert.equal(partial.seized,105n*10n**15n);
  const exhausted=liquidationQuote({...args,debt:200000000n});
  assert.equal(exhausted.seized,USD);assert.equal(exhausted.repaid,95238095n);
  assert.equal(liquidationQuote({...args,collateral:0n}).badDebt,true);
});
test('oracle staleness boundary, future time, invalid round and failover input',()=>{
  assert.equal(feedHealth([1n,100n,0n,1000n,1n],8,1099n,100n).valid,true);
  assert.equal(feedHealth([1n,100n,0n,1000n,1n],8,1100n,100n).valid,false);
  assert.equal(feedHealth([1n,100n,0n,1000n,1n],8,999n,100n).valid,false);
  assert.equal(feedHealth([2n,100n,0n,1000n,1n],8,1000n,100n).valid,false);
  assert.equal(feedHealth(undefined,8,1000n,100n).valid,false);
});
test('execution requires a signer and pinned bytecode; never implicitly enables execution',()=>{
  assert.equal(configFromEnv({KEEPER_RPC_URL:'http://localhost:8545'}).mode,'observe');
  assert.throws(()=>configFromEnv({KEEPER_RPC_URL:'http://localhost:8545',KEEPER_MODE:'execute'}));
  assert.throws(()=>configFromEnv({KEEPER_RPC_URL:'http://localhost:8545',NODE_ENV:'production'}));
});
test('SQLite persists discovery, nonce journal, budgets and enforces a single keeper lease',()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-store-'));
  try {
    const first=new Store(directory,identity);first.acquireLease();
    first.indexBatch([{collateral,borrower}],100n,'0xabc');
    const other=new Store(directory,identity);
    assert.throws(()=>other.acquireLease(),/Another keeper/);
    other.close();first.assertLease();
    first.saveTx({id:'tx',status:'pending',kind:'liquidation',createdAt:Date.now(),maxRepay:25n,feeReserve:10n,attempts:[{hash:'0x123',raw:'0x456'}]});
    first.close();
    const restored=new Store(directory,identity);restored.acquireLease();
    assert.equal(restored.get('cursor').blockNumber,100n);
    assert.equal(restored.positions().length,1);
    assert.equal(restored.pendingTx().attempts[0].raw,'0x456');
    assert.deepEqual(restored.budgets(),{daily:25n,inventory:25n,gas:10n});
    assert.throws(()=>new Store(directory,{...identity,chainId:1}),/identity mismatch/);
    restored.close();
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('failed index requests never advance cursor; reorg discovery restarts and retains old identities',async()=>{
  const store=memory();
  const config={startBlock:10n,logChunk:5n,maxChunksPerCycle:5,vault:collateral};
  const chain={client:{
    getBlock:async({blockNumber})=>({hash:`hash${blockNumber}`}),
    getLogs:async()=>[{args:{collateral,borrower},removed:false}],
  }};
  assert.equal((await syncPositions(chain,store,config,{number:14n,hash:'hash14'})).complete,true);
  assert.equal(store.positions().length,1);
  chain.client.getLogs=async()=>{throw new Error('RPC down');};
  await assert.rejects(syncPositions(chain,store,config,{number:15n,hash:'hash15'}));
  assert.equal(store.get('cursor').blockNumber,14n);
  chain.client.getLogs=async()=>[];
  chain.client.getBlock=async({blockNumber})=>({hash:`new${blockNumber}`});
  assert.equal((await syncPositions(chain,store,config,{number:15n,hash:'new15'})).reorg,true);
  assert.equal(store.positions().length,1);
  store.close();
});
test('status and metrics are authenticated, readiness is not process liveness',async()=>{
  const server=createStatusServer({statusToken:'a'.repeat(40),heartbeatMaxAgeMs:180000},()=>({lastProgress:Date.now()}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url+'/healthz')).status,200);
    assert.equal((await fetch(url+'/status')).status,401);
    assert.equal((await fetch(url+'/metrics')).status,401);
    assert.equal((await fetch(url+'/readyz',{headers:{Authorization:'Bearer '+'a'.repeat(40)}})).status,503);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('alerts deduplicate, remind, resolve and retain failed delivery for retry',async()=>{
  const store=memory(), alerts=new Alerts(store,{alertReminderMs:3600000,alertWebhook:'https://example.invalid'});
  const sent=[];alerts.deliver=async value=>{sent.push(value);return true;};
  const value=incident('oracle','critical','Oracle unavailable');
  await alerts.update([value]);await alerts.update([value]);
  assert.equal(sent.length,1);
  await alerts.update([]);assert.equal(sent.length,1,'Recovery is recorded without another inbox notification');
  assert.deepEqual(store.get('alerts'),{});
  await alerts.update([value]);assert.equal(sent.length,1,'A flapping incident remains in its reminder cooldown');
  const fresh=incident('transaction_failed','critical','A different actionable incident');
  alerts.deliver=async()=>false;
  await alerts.update([fresh]);assert.equal(store.get('alertDelivery').delivered,false);
  alerts.deliver=async value=>{sent.push(value);return true;};
  await alerts.update([fresh]);assert.equal(store.get('alertDelivery').delivered,true);
  store.close();
});
test('errors never log RPC URLs or nested request secrets',()=>{
  const error={name:'HttpRequestError',message:'https://example.invalid/API_SECRET',cause:{message:'private key'}};
  assert.equal(errorCode(error),'HttpRequestError');
  assert.equal(errorCode({cause:{data:{errorName:'PositionIsHealthy'}}}),'PositionIsHealthy');
});
test('V2 deployment requires a paired address and discovery block and preserves V1 by default',()=>{
  const base={ALCHEMY_RPC_URL:'https://rpc.example.test'};
  const current=configFromEnv(base);
  const next=configFromEnv({...base,KEEPER_VAULT_ADDRESS:'0x0000000000000000000000000000000000000123',KEEPER_START_BLOCK:'52850000'});
  assert.notEqual(next.vault,current.vault);assert.equal(next.startBlock,52850000n);
  assert.throws(()=>configFromEnv({...base,KEEPER_VAULT_ADDRESS:next.vault}));
  assert.throws(()=>configFromEnv({...base,KEEPER_START_BLOCK:'52850000'}));
});
