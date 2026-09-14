import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CashbackLedger } from '../src/ledger.mjs';

const borrower = '0x00000000000000000000000000000000000a11ce';
const engine = '0x000000000000000000000000000000000000e001';
const policy = { startsAt: 1000, endsAt: 865000, settlementDeadline: 3457000,
  claimDeadline: 6049000, rebateBps: 5000, engines: { [engine]: { aprBps: 1000 } } };
const first = { number: 10, hash: 'a', parentHash: 'genesis', timestamp: 1000, receipts: [{ timestamp: 1000,
  transactionHash: 'tx1', events: [{ event: 'Enrolled', borrower, engine, cap: '10000000', startsAt: 1000 },
    { event: 'Borrowed', borrower, engine, amount: '365000000' }] }] };
const second = { number: 11, hash: 'b', parentHash: 'a', timestamp: 865000, receipts: [{ timestamp: 865000,
  transactionHash: 'tx2', events: [{ event: 'Repaid', borrower, engine, principal: '365000000', interest: '1000000' }] }] };

test('canonical rewards survive restart and duplicate block ingestion is idempotent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'turret-cashback-ledger-'));
  let ledger;
  try {
    ledger = new CashbackLedger({ path: join(directory, 'ledger.sqlite'), policy, startBlock: 10 });
    ledger.ingest(first);
    ledger.ingest(second);
    ledger.ingest(second);
    assert.equal(ledger.account(borrower)[0].confirmedRebate, 500000n);
    ledger.close();
    ledger = new CashbackLedger({ path: join(directory, 'ledger.sqlite'), policy, startBlock: 10 });
    assert.equal(ledger.account(borrower)[0].confirmedRebate, 500000n);
    assert.deepEqual(ledger.head(), { number: 11, hash: 'b', timestamp: 865000 });
  } finally { ledger?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a replacement canonical block removes orphaned rewards and rejects disconnected histories', () => {
  const ledger = new CashbackLedger({ path: ':memory:', policy, startBlock: 10 });
  try {
    ledger.ingest(first);
    ledger.ingest(second);
    ledger.ingest({ ...second, hash: 'replacement', receipts: [] });
    assert.equal(ledger.account(borrower)[0].confirmedRebate, 0n);
    assert.equal(ledger.account(borrower)[0].estimatedRebate, 500000n);
    assert.throws(() => ledger.ingest({ ...second, number: 12, hash: 'disconnected', parentHash: 'b' }), /canonical/);
    assert.equal(ledger.head().hash, 'replacement');
  } finally { ledger.close(); }
});

test('reorganizations affecting published entitlements stop for review instead of revoking claims', () => {
  const ledger = new CashbackLedger({ path: ':memory:', policy, startBlock: 10 });
  try {
    ledger.ingest(first); ledger.ingest(second);
    ledger.protectPublication('root', 11, 'b');
    assert.throws(() => ledger.ingest({ ...second, hash: 'replacement', receipts: [] }), /published/);
    assert.equal(ledger.account(borrower)[0].confirmedRebate, 500000n);
    assert.throws(() => ledger.protectPublication('other-root', 11, 'wrong-hash'), /canonical/);
  } finally { ledger.close(); }
});


test('historical ranges retain accounting and reject gaps, corruption and partial writes', () => {
 const ledger=new CashbackLedger({path:':memory:',policy,startBlock:10});
 try {
  const later={...second,number:100,parentHash:'intermediate'};
  ledger.ingestRange({from:10,to:100,blocks:[first,later]});
  assert.equal(ledger.account(borrower)[0].confirmedRebate,500000n);
  assert.equal(ledger.block(50),null);
  assert.throws(()=>ledger.ingestRange({from:102,to:103,blocks:[]}),/Disconnected/);
  assert.throws(()=>ledger.ingestRange({from:101,to:101,blocks:[{...later,number:101,hash:'bad',parentHash:'wrong'}]}),/Invalid/);
  ledger.protectPublication('root',100,'b');
  assert.throws(()=>ledger.ingest({...later,hash:'reorg'}),/published/);
  assert.equal(ledger.head().number,100);
 }finally{ledger.close();}
});
