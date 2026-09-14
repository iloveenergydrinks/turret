import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { IsolatedEngine } from '../src/isolated/engine.mjs';
import { IsolatedTransactions } from '../src/isolated/transactions.mjs';
import { isolatedAbi, exitAbi } from '../src/isolated/abi.mjs';
import { Store } from '../src/store.mjs';

// Real Dockyard engine, transaction signing/calldata, receipt decoding and SQLite.
// Every chain/transport boundary is a local fixture; this file cannot send to RPCs.
// Quotes are contract-response fixtures, not claims of EVM/AMM integration coverage.
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const blockHash = n => `0x${n.toString(16).padStart(64, '0')}`;
const vault = address(20), pool = address(21), collateral = address(22), executor = address(23), usdg = address(24);
const borrower = address(100);
const signer = privateKeyToAccount(`0x${'01'.padStart(64, '0')}`);
const min = (...xs) => xs.reduce((a, b) => a < b ? a : b);
const failure = name => Object.assign(new Error('fixture failure'), { name });
const revert = errorName => ({ data: { errorName } });
const day = 86_400_000;

function harness(t, { stock = false, atomic = true, durable = false } = {}) {
  const h = {
    now: 1_788_600_000_000, balance: 10_000n, allowance: 10_000n, eth: 10n ** 18n,
    head: { number: 100n, hash: blockHash(100), timestamp: 1_788_600_000n },
    rows: [{ borrower, principal: 100n, debt: 100n, collateralAmount: 1_000n }],
    reads: [], quotes: [], simulations: [], signed: [], broadcasts: [], receipts: new Map(),
    proof: '0x1234', latestNonce: 0, pendingNonce: 0,
  };
  t.mock.method(Date, 'now', () => h.now);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected network access'));
  h.config = {
    mode: 'execute', chainId: 4663, vault, pool, collateral, usdg,
    marketKind: stock ? 'stock' : 'generic', stock: stock ? {} : undefined,
    executor: atomic ? executor : undefined, retainCollateral: !atomic,
    minProfit: 1n, minProfitBps: 50, slippageBps: 100,
    maxRepay: 80n, dailyBudget: 10_000n, inventoryBudget: 10_000n,
    minUsdg: 1n, minEth: 1n, maxTxFee: 1_000_000n, maxDailyGas: 10_000_000n,
    confirmations: 2n, replaceAfterMs: 100, maxReplacements: 2,
    deploymentVerifyIntervalMs: 60_000, alertWebhook: 'https://example.invalid/never-called',
  };
  h.directory = durable ? mkdtempSync(join(tmpdir(), 'dockyard-stress-')) : ':memory:';
  const identity = { protocol: stock ? 'stock-isolated-v1' : 'isolated-v1', vault, pool, executor: h.config.executor ?? null, account: signer.address };
  h.store = new Store(h.directory, identity);
  h.store.acquireLease();
  t.after(() => {
    h.store.close();
    if (durable) rmSync(h.directory, { recursive: true, force: true });
  });
  h.row = who => {
    const row = h.rows.find(row => row.borrower === who);
    assert.ok(row, `Unknown fixture borrower ${who}`);
    return row;
  };
  h.quote = (who, cap) => {
    const paid = min(cap, h.row(who).debt);
    return [paid, paid * 10n];
  };
  const quote = async (who, cap, at, proof) => {
    h.quotes.push({ who, cap, at, proof });
    if (stock) assert.equal(proof, h.proof);
    return h.quote(who, cap);
  };
  h.chain = {
    consistent: true, active: { name: 'fixture' }, probeStatus: [],
    account: { ...signer, signTransaction: async request => {
      h.signed.push(request);
      return signer.signTransaction(request);
    } },
    select: async () => h.head, verifyDeployment: async () => true,
    stockLiveness: async () => h.proof, stockPrice: async () => 10n ** 18n, stockQuote: quote,
    read: async (name, args = [], at) => {
      h.reads.push({ name, args, at });
      if (name === 'activeDebtPositions') return BigInt(h.rows.length);
      if (name === 'activeBorrowerAt') return h.rows[Number(args[0])].borrower;
      if (name === 'positions') {
        const row = h.row(args[0]);
        return [row.collateralAmount, row.principal, row.debt - row.principal, 0n, 1n];
      }
      if (name === 'positionDebt') return h.row(args[0]).debt;
      if (name === 'liquidationQuote') return quote(...args, at);
      if (name === 'riskPaused') return false;
      if (name === 'price') return 10n ** 18n;
      assert.fail(`Unexpected read ${name}`);
    },
    capital: async (name, args, at) => {
      h.reads.push({ name, args, at });
      if (name === 'debtLimit') return 10_000n;
      if (name === 'availableCash') return 0n;
      if (name === 'pendingInterest') return 0n;
      if (name === 'outstandingPrincipal') return h.rows.reduce((n, row) => n + row.principal, 0n);
      if (name === 'interestReceivable') return h.rows.reduce((n, row) => n + row.debt - row.principal, 0n);
      assert.fail(`Unexpected capital read ${name}`);
    },
    token: async (token, name, args, at) => {
      h.reads.push({ name, args, at });
      return name === 'allowance' ? h.allowance : token === usdg ? h.balance : 0n;
    },
    client: {
      getBlock: async args => args?.blockNumber === undefined ? h.head
        : { ...h.head, number: args.blockNumber, hash: blockHash(Number(args.blockNumber)) },
      getBalance: async () => h.eth,
      getTransactionCount: async ({ blockTag }) => blockTag === 'pending' ? h.pendingNonce : h.latestNonce,
      getTransactionReceipt: async ({ hash }) => {
        if (!h.receipts.has(hash)) throw failure('TransactionReceiptNotFoundError');
        return h.receipts.get(hash);
      },
      simulateContract: async request => {
        h.simulations.push(request);
        return h.simulate(request);
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        // Exercise the ambiguous-send path without calling a transport.
        const pending = h.store.pendingTx();
        assert.equal(pending.attempts.at(-1).raw, serializedTransaction, 'Journal must precede send');
        assert.equal(pending.attempts.at(-1).hash, keccak256(serializedTransaction));
        h.broadcasts.push(serializedTransaction);
        throw failure('TimeoutError');
      },
    },
    wallet: { prepareTransactionRequest: async args => ({ ...args, chainId: 4663, type: 'legacy', gas: 100_000n, gasPrice: 1n }) },
  };
  h.simulate = async ({ functionName, args }) => {
    if (functionName === 'approve') return { result: true };
    const [paid, seized] = h.quote(args[0], args[1]);
    return { result: atomic ? [paid, seized, paid + args[3] + 1n] : [paid, seized] };
  };
  const bind = () => {
    h.txs = new IsolatedTransactions(h.chain, h.store, h.config);
    h.engine = new IsolatedEngine(h.chain, h.store, h.config, h.txs);
  };
  bind();
  h.restart = () => {
    assert.ok(durable);
    h.store.close();
    h.store = new Store(h.directory, identity);
    h.store.acquireLease();
    bind();
  };
  h.advance = ms => { h.now += ms; h.store.acquireLease(); };
  h.liquidate = (who = borrower) => h.txs.liquidate({ borrower: who, collateral });
  return h;
}

function receipt(h, { tx = h.store.pendingTx(), hash = tx.attempts.at(-1).hash,
  blockNumber = 100n, canonicalHash = blockHash(Number(blockNumber)), status = 'success', paid = tx.maxRepay, seized = paid * 10n,
  who = tx.borrower, keeper = signer.address, emitter = vault } = {}) {
  const logs = [{
    address: emitter,
    topics: encodeEventTopics({ abi: isolatedAbi, eventName: 'Liquidated', args: { borrower: who, liquidator: tx.executor ?? keeper } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [paid, seized]),
  }];
  if (tx.executor) logs.push({
    address: tx.executor,
    topics: encodeEventTopics({ abi: exitAbi, eventName: 'LiquidationExited', args: { borrower: who, keeper } }),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint256,uint256'), [paid, seized, paid + tx.minProfit, tx.minProfit]),
  });
  return { transactionHash: hash, blockNumber, blockHash: canonicalHash, status,
    gasUsed: 100_000n, effectiveGasPrice: 1n, logs: status === 'success' ? logs : [] };
}

function history(h, { paid = 30n, recovered = false, age = 1, gas = 0n } = {}) {
  h.store.saveTx({ id: `history-${h.store.transactions().length}`, kind: 'liquidation', status: 'confirmed',
    createdAt: h.now - age, maxRepay: paid, actualRepay: paid, actualGas: gas, feeReserve: gas,
    inventoryRecovered: recovered, attempts: [] });
}

function assertNoIntent(h) {
  assert.equal(h.store.pendingTx(), undefined);
  assert.equal(h.signed.length, 0);
  assert.equal(h.broadcasts.length, 0);
}

// Seeded inputs probe the worker's budget/profit/slippage policy across different
// quote fills. They do not reimplement the production sizing decision.
test('stress: 192 seeded caps preserve all four funding bounds and rounded profit/slippage', async t => {
  let seed = 0xD0C2026;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return BigInt(seed % n + 1); };
  for (let i = 0; i < 192; i++) await t.test(`case ${i}`, async t => {
    const h = harness(t, { stock: i % 2 === 0 });
    history(h);
    h.config.maxRepay = random(100_000);
    h.config.dailyBudget = 30n + random(100_000);
    h.config.inventoryBudget = 30n + random(100_000);
    h.balance = random(100_000);
    h.allowance = 100_000n;
    h.config.minProfitBps = Number(random(10_000));
    h.config.slippageBps = Number(random(501) - 1n);
    const budget = h.store.budgets();
    const cap = min(h.config.maxRepay, h.config.dailyBudget - budget.daily, h.config.inventoryBudget - budget.inventory, h.balance);
    const paid = min(random(100_000), cap), seized = random(1_000_000);
    h.quote = () => [paid, seized];
    await h.liquidate();
    const tx = h.store.pendingTx();
    assert.ok(tx);
    const args = decodeFunctionData({ abi: exitAbi, data: tx.request.data }).args;
    assert.equal(args[1], cap);
    assert.equal(args[2], seized * BigInt(10_000 - h.config.slippageBps) / 10_000n || 1n);
    assert.equal(args[3], (paid * BigInt(h.config.minProfitBps) + 9999n) / 10_000n);
    assert.ok(h.store.budgets().daily <= h.config.dailyBudget);
    assert.ok(h.store.budgets().inventory <= h.config.inventoryBudget);
    assert.equal(h.signed.length, 1);
    assert.ok(h.reads.every(read => read.at === 100n));
    assert.ok(h.quotes.every(quote => quote.at === 100n));
  });
});

for (const stock of [false, true]) {
  const kind = stock ? 'stock' : 'generic';
  test(`stress: ${kind} minimum micro-USDG and one collateral unit keep positive bounds`, async t => {
    const h = harness(t, { stock });
    h.config.maxRepay = 1n;
    h.quote = () => [1n, 1n];
    await h.liquidate();
    assert.equal(h.store.pendingTx().minCollateral, 1n);
    assert.equal(h.store.pendingTx().minProfit, 1n);
    assert.equal(h.store.pendingTx().sizingAttempts, 1);
  });

  test(`stress: ${kind} price-impact retries stop if the next quote hits minimum-debt protection`, async t => {
    const h = harness(t, { stock });
    h.config.maxRepay = 1_000_000n;
    h.balance = h.allowance = h.config.dailyBudget = h.config.inventoryBudget = 1_000_000n;
    h.quote = (_who, cap) => {
      if (cap < 1_000_000n) throw revert('InvalidAmount');
      return [1_000_000n, 10n ** 16n];
    };
    h.simulate = async () => { throw revert('InsufficientReturn'); };
    const incidents = await h.liquidate();
    assert.deepEqual(h.quotes.map(q => q.cap), [1_000_000n, 500_000n]);
    assert.equal(h.simulations.length, 1);
    assert.equal(incidents[0].details.error, 'InvalidAmount');
    assertNoIntent(h);
  });

  test(`stress: ${kind} no profitable dust size terminates without zero-cap retry or approval`, async t => {
    const h = harness(t, { stock });
    h.config.maxRepay = 3n;
    h.simulate = async () => { throw revert('InsufficientReturn'); };
    const incidents = await h.liquidate();
    assert.deepEqual(h.simulations.map(s => s.args[1]), [3n, 1n]);
    assert.equal(incidents[0].details.error, 'NoExecutableLiquidationSize');
    assertNoIntent(h);
  });

  for (const code of ['OracleUnavailable', 'LivenessExpired', 'RouteChanged', 'UnsupportedTransfer', 'PoolEmpty']) {
    test(`stress: ${kind} ${code} after one size reduction stops without weakening policy`, async t => {
      const h = harness(t, { stock });
      h.simulate = async () => { throw revert(h.simulations.length === 1 ? 'InsufficientReturn' : code); };
      const incidents = await h.liquidate();
      assert.deepEqual(h.simulations.map(s => s.args[1]), [80n, 40n]);
      assert.equal(incidents[0].details.error, code);
      assertNoIntent(h);
    });
  }
}

test('stress: 64 borrowers scan at one block; failed largest exit does not starve the next borrower', async t => {
  const h = harness(t, { stock: true });
  h.rows = Array.from({ length: 64 }, (_, i) => ({ borrower: address(100 + i), principal: BigInt(i + 1), debt: BigInt(i + 1), collateralAmount: 1000n }));
  let active = 0, peak = 0;
  const read = h.chain.read;
  h.chain.read = async (...args) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await read(...args); }
    finally { active--; }
  };
  const simulate = h.simulate;
  h.simulate = async request => {
    if (request.args[0] === address(163)) throw revert('InsufficientReturn');
    return simulate(request);
  };
  const snapshot = await h.engine.cycle();
  assert.equal(snapshot.openPositions, 64);
  assert.equal(snapshot.unhealthyPositions, 64);
  assert.equal(snapshot.totalDebt, 2080n);
  assert.equal(snapshot.reconciled, true);
  assert.equal(snapshot.availableLiquidity, 0n, 'Empty lender cash does not prevent keeper-funded repayment');
  assert.ok(peak <= 8, `Concurrent position reads were ${peak}`);
  assert.ok(h.reads.every(read => read.at === 100n));
  assert.deepEqual(h.simulations.map(s => s.args[0]), [address(163), address(163), address(163), address(163), address(162)]);
  assert.equal(h.store.pendingTx().borrower, address(162));
  assert.equal(h.signed.length, 1);
});

test('stress: competitor heals the largest position after scan; smaller candidate still executes', async t => {
  const h = harness(t);
  h.rows.push({ borrower: address(101), principal: 60n, debt: 60n, collateralAmount: 1000n });
  const quote = h.quote;
  let largestQuotes = 0;
  h.quote = (who, cap) => {
    if (who === borrower && ++largestQuotes > 1) throw revert('HealthyPosition');
    return quote(who, cap);
  };
  const snapshot = await h.engine.cycle();
  assert.equal(h.store.pendingTx().borrower, address(101));
  assert.equal(snapshot.incidents.some(i => i.code.startsWith('simulation:')), false);
  assert.equal(h.signed.length, 1);
});

test('stress: all 64 unprofitable borrowers have bounded attempts and durable per-borrower cooldown', async t => {
  const h = harness(t);
  h.rows = Array.from({ length: 64 }, (_, i) => ({ borrower: address(100 + i), principal: 80n, debt: 80n, collateralAmount: 1000n }));
  h.simulate = async () => { throw revert('InsufficientReturn'); };
  const first = await h.engine.cycle();
  assert.equal(first.incidents.filter(i => i.code.startsWith('simulation:')).length, 64);
  assert.equal(h.simulations.length, 256);
  await h.engine.cycle();
  assert.equal(h.simulations.length, 256, 'Cooldown prevents another 256 simulations');
  h.advance(30_000);
  await h.engine.cycle();
  assert.equal(h.simulations.length, 512, 'Every borrower becomes retryable at the boundary');
  assertNoIntent(h);
});

for (const stock of [false, true]) test(`stress: ${stock ? 'stock liveness' : 'oracle'} outage reconciles an actual pending receipt without another send`, async t => {
  const h = harness(t, { stock });
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h));
  h.head = { ...h.head, number: 102n, hash: blockHash(102) };
  if (stock) h.chain.stockLiveness = async () => { throw failure('LivenessUnavailable'); };
  else {
    const read = h.chain.read;
    h.chain.read = async (name, ...rest) => {
      if (name === 'price') throw revert('OracleUnavailable');
      return read(name, ...rest);
    };
  }
  const snapshot = await h.engine.cycle();
  assert.equal(h.store.pendingTx(), undefined);
  assert.equal(h.store.transactions()[0].status, 'confirmed');
  assert.equal(h.store.budgets().inventory, 0n);
  assert.equal(h.broadcasts.length, 1);
  assert.ok(snapshot.incidents.some(i => i.code === (stock ? 'execution_liveness_unavailable' : 'oracle_blocked')));
});

test('stress: stock proof changes between scan and preparation; only the new proof is signed', async t => {
  const h = harness(t, { stock: true });
  let calls = 0;
  h.chain.stockLiveness = async () => { h.proof = ++calls === 1 ? '0x1111' : '0x2222'; return h.proof; };
  await h.engine.cycle();
  assert.deepEqual(h.quotes.map(q => q.proof), ['0x1111', '0x2222']);
  assert.equal(decodeFunctionData({ abi: exitAbi, data: h.store.pendingTx().request.data }).args.at(-1), '0x2222');
});

for (const fault of ['reorg-after-sizing', 'clock-regresses', 'height-regresses', 'snapshot-expires']) {
  test(`stress: ${fault} prevents signing after a successful smaller simulation`, async t => {
    const h = harness(t);
    const simulate = h.simulate;
    h.simulate = async request => {
      if (h.simulations.length === 1) throw revert('InsufficientReturn');
      h.chain.client.getBlock = async args => {
        if (args?.blockNumber !== undefined) return { ...h.head, hash: fault === 'reorg-after-sizing' ? blockHash(999) : h.head.hash };
        return { ...h.head, number: fault === 'height-regresses' ? 99n : 101n,
          timestamp: h.head.timestamp + (fault === 'clock-regresses' ? -1n : fault === 'snapshot-expires' ? 31n : 1n) };
      };
      return simulate(request);
    };
    const incidents = await h.liquidate();
    assert.equal(incidents[0].severity, 'critical');
    assert.equal(h.simulations.length, 2);
    assertNoIntent(h);
  });
}

test('stress: unknown pending nonce prevents signing even after successful liquidation simulation', async t => {
  const h = harness(t);
  h.pendingNonce = 1;
  const incidents = await h.liquidate();
  assert.equal(incidents[0].code, 'unknown_pending_nonce');
  assert.equal(h.simulations.length, 1);
  assertNoIntent(h);
});

test('stress: restart recovers the original attempt after two replacements and charges exactly once', async t => {
  const h = harness(t, { stock: true, durable: true });
  await h.liquidate();
  const original = h.store.pendingTx();
  for (let i = 0; i < 2; i++) { h.advance(100); await h.txs.recover(h.head, true); }
  const pending = h.store.pendingTx();
  assert.equal(pending.attempts.length, 3);
  for (const request of h.signed) {
    assert.equal(request.data, original.request.data);
    assert.equal(request.nonce, original.request.nonce);
    assert.equal(request.value, original.request.value);
  }
  h.restart();
  h.config.mode = 'observe';
  h.receipts.set(original.attempts[0].hash, receipt(h, { hash: original.attempts[0].hash }));
  await h.txs.recover({ number: 102n }, true);
  await h.txs.recover({ number: 103n }, true);
  assert.equal(h.store.transactions().length, 1);
  assert.equal(h.store.transactions()[0].receipt.hash, original.attempts[0].hash);
  assert.deepEqual(h.store.budgets(), { daily: 80n, inventory: 0n, gas: 100_000n });
  assert.equal(h.broadcasts.length, 3);
});

test('stress: receipt disappears on reorg, then a replacement mines; reserve survives until canonical confirmation', async t => {
  const h = harness(t);
  await h.liquidate();
  const first = h.store.pendingTx();
  h.receipts.set(first.attempts[0].hash, receipt(h, { canonicalHash: blockHash(999) }));
  assert.equal((await h.txs.recover({ number: 102n }, true))[0].code, 'receipt_reorg');
  assert.equal(h.store.budgets().inventory, 80n);
  h.receipts.clear(); h.advance(100);
  await h.txs.recover({ number: 102n }, true);
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[1].hash, receipt(h));
  await h.txs.recover({ number: 102n }, false);
  assert.equal(h.store.pendingTx(), undefined);
  assert.equal(h.store.budgets().inventory, 0n);
  assert.equal(h.store.transactions()[0].receipt.hash, tx.attempts[1].hash);
});

test('stress: competition revert releases capital, charges gas and lets the next borrower run', async t => {
  const h = harness(t);
  h.rows.push({ borrower: address(101), principal: 60n, debt: 60n, collateralAmount: 1000n });
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h, { status: 'reverted' }));
  h.head = { ...h.head, number: 102n, hash: blockHash(102) };
  h.latestNonce = h.pendingNonce = 1;
  await h.engine.cycle();
  assert.equal(h.store.transactions()[0].status, 'reverted');
  assert.equal(h.store.pendingTx().borrower, address(101));
  assert.equal(h.store.pendingTx().request.nonce, 1);
  assert.equal(h.store.budgets().daily, 80n, 'Reserve follows signed cap, not quote fill');
  assert.equal(h.store.budgets().gas, 220_000n);
  assert.equal(h.store.get(`retry:${collateral}:${borrower}`), h.now + 60_000);
});

test('stress: a malformed receipt permanently blocks the nonce across restart and a corrected later response', async t => {
  const h = harness(t, { durable: true });
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h, { keeper: address(999) }));
  assert.equal((await h.txs.recover({ number: 102n }, false))[0].code, 'liquidation_receipt_mismatch');
  h.restart();
  h.receipts.set(tx.attempts[0].hash, receipt(h));
  assert.equal((await h.txs.recover({ number: 103n }, true))[0].code, 'transaction_requires_review');
  assert.equal(h.store.pendingTx().status, 'blocked');
  assert.equal(h.store.budgets().inventory, 80n);
  assert.equal(h.broadcasts.length, 1);
});

test('stress: transient receipt RPC timeout preserves journal and retries without signing', async t => {
  const h = harness(t);
  await h.liquidate();
  const before = h.store.pendingTx();
  h.chain.client.getTransactionReceipt = async () => { throw failure('TimeoutError'); };
  await assert.rejects(h.txs.recover({ number: 102n }, true), { name: 'TimeoutError' });
  assert.deepEqual(h.store.pendingTx(), before);
  assert.equal(h.signed.length, 1);
});

test('stress: replacement gas ceiling and maximum count are enforced with a current journal', async t => {
  const h = harness(t);
  await h.liquidate();
  h.config.maxDailyGas = 200_000n;
  h.advance(100);
  assert.equal((await h.txs.recover(h.head, true))[0].code, 'replacement_budget');
  assert.equal(h.signed.length, 1);
  h.config.maxDailyGas = 1_000_000n;
  for (let i = 0; i < 2; i++) { h.advance(100); await h.txs.recover(h.head, true); }
  h.advance(100);
  assert.equal((await h.txs.recover(h.head, true))[0].code, 'transaction_stuck');
  assert.equal(h.signed.length, 3);
  assert.equal(h.store.budgets().inventory, 80n);
});

for (const [label, result] of [
  ['zero repayment', [0n, 800n, 100n]],
  ['over-cap repayment', [81n, 800n, 100n]],
  ['below-minimum seizure', [80n, 791n, 100n]],
  ['no profit', [80n, 800n, 80n]],
  ['missing return', [80n, 800n]],
]) test(`stress: hostile simulation response with ${label} creates no intent`, async t => {
  const h = harness(t, { stock: true });
  h.simulate = async () => ({ result });
  const incidents = await h.liquidate();
  assert.equal(incidents[0].severity, 'critical');
  assert.equal(h.simulations.length, 1);
  assertNoIntent(h);
});

test('stress: 8 consecutive liquidations drain a changing registry without repeating a borrower or nonce', async t => {
  const h = harness(t, { stock: true });
  h.rows = Array.from({ length: 8 }, (_, i) => ({ borrower: address(100 + i), principal: BigInt(8 + i), debt: BigInt(8 + i), collateralAmount: 1000n }));
  const originalDebt = h.rows.reduce((n, row) => n + row.debt, 0n);
  const executed = [];
  for (let i = 0; i < 8; i++) {
    await h.engine.cycle();
    const tx = h.store.pendingTx();
    assert.ok(tx);
    assert.equal(tx.request.nonce, i);
    const row = h.row(tx.borrower);
    executed.push(tx.borrower);
    // A quote may pay less than its cap; receipts must account the actual fill.
    h.receipts.set(tx.attempts[0].hash, receipt(h, { blockNumber: h.head.number, paid: row.debt, seized: row.debt * 10n }));
    const index = h.rows.indexOf(row);
    h.rows[index] = h.rows.at(-1); h.rows.pop(); // Onchain swap-and-pop removal.
    h.latestNonce = h.pendingNonce = i + 1;
    const next = h.head.number + 2n;
    h.head = { ...h.head, number: next, hash: blockHash(Number(next)), timestamp: h.head.timestamp + 2n };
    await h.txs.recover(h.head, false);
    assert.equal(h.store.pendingTx(), undefined);
  }
  const empty = await h.engine.cycle();
  assert.deepEqual(executed, Array.from({ length: 8 }, (_, i) => address(107 - i)));
  assert.equal(new Set(executed).size, 8);
  assert.equal(empty.openPositions, 0);
  assert.equal(empty.reconciled, true);
  assert.equal(h.store.budgets().daily, originalDebt);
  assert.equal(h.store.budgets().inventory, 0n);
  assert.equal(h.broadcasts.length, 8);
});

test('stress: nonce consumed without any matching receipt remains blocked across restart', async t => {
  const h = harness(t, { stock: true, durable: true });
  await h.liquidate();
  h.latestNonce = h.pendingNonce = 1;
  assert.equal((await h.txs.recover(h.head, true))[0].code, 'nonce_consumed');
  h.restart();
  await h.engine.cycle();
  assert.equal(h.store.pendingTx().status, 'blocked');
  assert.equal(h.store.budgets().inventory, 80n);
  assert.equal(h.broadcasts.length, 1);
});

test('stress: lease expiry while signing prevents journaling and broadcast of the returned signature', async t => {
  const h = harness(t);
  const sign = h.chain.account.signTransaction;
  h.chain.account.signTransaction = async request => {
    const raw = await sign(request);
    h.now += 120_001;
    return raw;
  };
  const incidents = await h.liquidate();
  assert.equal(incidents[0].severity, 'critical');
  assert.equal(h.signed.length, 1);
  assert.equal(h.store.pendingTx(), undefined);
  assert.equal(h.broadcasts.length, 0);
});

test('stress: retained spend confirmed before the daily cutoff still constrains the next borrower', async t => {
  const h = harness(t, { atomic: false });
  h.config.dailyBudget = 100n;
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.advance(day - 1);
  h.receipts.set(tx.attempts[0].hash, receipt(h));
  await h.txs.recover({ number: 102n }, false);
  h.latestNonce = h.pendingNonce = 1;
  h.rows.push({ borrower: address(101), principal: 100n, debt: 100n, collateralAmount: 1000n });
  await h.liquidate(address(101));
  assert.equal(h.store.pendingTx().maxRepay, 20n);
  assert.equal(h.store.budgets().daily, 100n);
});

// Permanent regressions for the four recovery/accounting findings.
test('FINDING R1: a receipt for a different transaction must not release the signed intent',
  async t => {
    const h = harness(t);
    await h.liquidate();
    const tx = h.store.pendingTx();
    h.receipts.set(tx.attempts[0].hash, receipt(h, { hash: blockHash(999) }));
    await h.txs.recover({ number: 102n }, false);
    assert.notEqual(h.store.transactions()[0].status, 'confirmed', 'Unrelated transaction receipt was accepted');
    assert.equal(h.store.budgets().inventory, 80n);
  });

test('FINDING R2: a cached orphan receipt must not mask a canonical mined replacement',
  async t => {
    const h = harness(t);
    await h.liquidate();
    h.advance(100); await h.txs.recover(h.head, true);
    const tx = h.store.pendingTx();
    h.receipts.set(tx.attempts[0].hash, receipt(h, { hash: tx.attempts[0].hash, canonicalHash: blockHash(999) }));
    h.receipts.set(tx.attempts[1].hash, receipt(h));
    for (let i = 0; i < 3; i++) await h.txs.recover({ number: 102n + BigInt(i) }, false);
    assert.equal(h.store.transactions()[0].status, 'confirmed', 'Mined replacement is hidden by stale orphan receipt');
    assert.equal(h.store.transactions()[0].receipt.hash, tx.attempts[1].hash);
  });

test('FINDING R3: replacing a pending intent older than one day must obey the full daily gas ceiling',
  async t => {
    const h = harness(t, { atomic: false });
    await h.liquidate();
    h.advance(day + 1);
    h.config.maxDailyGas = 200_000n;
    await h.txs.recover(h.head, true);
    const reserved = h.store.pendingTx().feeReserve;
    assert.ok(reserved <= h.config.maxDailyGas, `Replacement reserves ${reserved} wei despite a ${h.config.maxDailyGas} wei daily ceiling`);
  });

test('FINDING R4: a retained liquidation mined today must consume today\'s repayment budget after a long pending period',
  async t => {
    const h = harness(t, { atomic: false });
    h.config.dailyBudget = 100n;
    await h.liquidate();
    const tx = h.store.pendingTx();
    h.advance(day + 1);
    h.receipts.set(tx.attempts[0].hash, { ...receipt(h), blockNumber: 200n, blockHash: blockHash(200) });
    h.head = { number: 202n, hash: blockHash(202), timestamp: h.head.timestamp + 86_401n };
    await h.txs.recover(h.head, false);
    const dailyAfterConfirmation = h.store.budgets().daily;
    h.latestNonce = h.pendingNonce = 1;
    h.rows.push({ borrower: address(101), principal: 100n, debt: 100n, collateralAmount: 1000n });
    await h.liquidate(address(101));
    assert.equal(h.store.pendingTx().maxRepay, 20n,
      `Confirmed 80 today, daily accounting reports ${dailyAfterConfirmation}; another 80 would exceed the 100 limit`);
  });

test('regression: wrong receipt identity is retryable after restart without releasing reserves', async t => {
  const h = harness(t, { durable: true });
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h, { hash: blockHash(999) }));
  h.advance(2 * day);
  assert.equal((await h.txs.recover({ number: 102n }, true))[0].code, 'transaction_receipt_identity');
  assert.deepEqual(h.store.budgets(), { daily: 80n, inventory: 80n, gas: 120_000n });
  h.restart();
  h.receipts.set(tx.attempts[0].hash, receipt(h));
  await h.txs.recover({ number: 102n }, false);
  assert.equal(h.store.pendingTx(), undefined);
  assert.equal(h.store.transactions()[0].settledAt, h.now);
  assert.equal(h.signed.length, 1);
});

test('regression: canonical replacement still waits for confirmations behind an orphan', async t => {
  const h = harness(t);
  await h.liquidate();
  h.advance(100);
  await h.txs.recover(h.head, true);
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h, { hash: tx.attempts[0].hash, canonicalHash: blockHash(999) }));
  h.receipts.set(tx.attempts[1].hash, receipt(h));
  await h.txs.recover({ number: 101n }, true);
  assert.equal(h.store.pendingTx().status, 'pending');
  assert.equal(h.signed.length, 2);
  await h.txs.recover({ number: 102n }, false);
  assert.equal(h.store.transactions()[0].receipt.hash, tx.attempts[1].hash);
});

test('regression: long-pending replacement substitutes exactly one fully reserved fee', async t => {
  const h = harness(t, { atomic: false });
  history(h, { paid: 10n, gas: 20_000n, recovered: true });
  await h.liquidate();
  h.advance(2 * day);
  assert.deepEqual(h.store.budgets(), { daily: 80n, inventory: 80n, gas: 120_000n });
  h.config.maxDailyGas = 240_000n;
  await h.txs.recover(h.head, true);
  assert.equal(h.store.pendingTx().attempts.length, 2);
  assert.equal(h.store.budgets().gas, 240_000n);
  h.advance(100);
  assert.equal((await h.txs.recover(h.head, true))[0].code, 'replacement_budget');
  assert.equal(h.signed.length, 2);
});

for (const status of ['success', 'reverted']) {
  test(`regression: late ${status} spends age from settlement and survive restart`, async t => {
    const h = harness(t, { durable: true, atomic: false });
    await h.liquidate();
    const tx = h.store.pendingTx();
    h.advance(2 * day);
    h.receipts.set(tx.attempts[0].hash, receipt(h, { status }));
    await h.txs.recover({ number: 102n }, false);
    const settledAt = h.now;
    h.advance(day - 1);
    h.restart();
    await h.txs.recover({ number: 103n }, false);
    assert.equal(h.store.transactions()[0].settledAt, settledAt);
    assert.deepEqual(h.store.budgets(), { daily: status === 'success' ? 80n : 0n,
      inventory: status === 'success' ? 80n : 0n, gas: 100_000n });
    h.advance(1);
    assert.deepEqual(h.store.budgets(), { daily: 0n, inventory: status === 'success' ? 80n : 0n, gas: 0n });
  });
}

test('regression: legacy settled records get one persisted conservative upgrade window', async t => {
  const h = harness(t, { durable: true });
  history(h, { paid: 80n, age: 10 * day, gas: 20_000n, recovered: true });
  // Emulate the old journal version, which had no settlement time or migration epoch.
  h.store.db.prepare('DELETE FROM kv WHERE key=?').run('budgetAccountingEpoch');
  h.advance(2 * day);
  h.restart();
  const epoch = h.store.get('budgetAccountingEpoch');
  assert.equal(epoch, h.now);
  assert.deepEqual(h.store.budgets(), { daily: 80n, inventory: 0n, gas: 20_000n });
  h.advance(day - 1);
  h.restart();
  assert.equal(h.store.get('budgetAccountingEpoch'), epoch);
  assert.equal(h.store.budgets().daily, 80n);
  h.advance(1);
  h.restart();
  assert.equal(h.store.get('budgetAccountingEpoch'), epoch);
  assert.deepEqual(h.store.budgets(), { daily: 0n, inventory: 0n, gas: 0n });
});

test('regression: blocked semantic receipt retains the full signed fee and repayment budgets', async t => {
  const h = harness(t, { durable: true });
  await h.liquidate();
  const tx = h.store.pendingTx();
  h.receipts.set(tx.attempts[0].hash, receipt(h, { keeper: address(999) }));
  await h.txs.recover({ number: 102n }, false);
  h.advance(3 * day);
  h.restart();
  assert.equal(h.store.pendingTx().status, 'blocked');
  assert.deepEqual(h.store.budgets(), { daily: 80n, inventory: 80n, gas: 120_000n });
});
