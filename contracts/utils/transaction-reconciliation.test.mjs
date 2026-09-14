import assert from 'node:assert/strict';
import test from 'node:test';

import {getTransactionEventually} from './transaction-reconciliation.mjs';

test('retries when a mined transaction is not indexed by the current RPC backend yet', async () => {
  let attempts = 0;
  const client = {
    async getTransaction({hash}) {
      attempts += 1;
      if (attempts < 3) throw new Error(`Transaction with hash ${hash} could not be found.`);
      return {hash, from: '0xowner'};
    },
  };

  const transaction = await getTransactionEventually(
    client,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    {attempts: 3, delayMs: 0},
  );

  assert.equal(transaction.from, '0xowner');
  assert.equal(attempts, 3);
});

test('preserves the final lookup error after the retry budget is exhausted', async () => {
  let attempts = 0;
  const client = {
    async getTransaction() {
      attempts += 1;
      throw new Error(`backend miss ${attempts}`);
    },
  };

  await assert.rejects(
    getTransactionEventually(client, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', {
      attempts: 2,
      delayMs: 0,
    }),
    /backend miss 2/,
  );
  assert.equal(attempts, 2);
});
