import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountReceipts } from '../src/accounting.mjs';

const borrower = '0x00000000000000000000000000000000000a11ce';
const engine = '0x000000000000000000000000000000000000e001';
const day = 86400;
const policy = { startsAt: 1000, endsAt: 1000 + 10 * day, settlementDeadline: 1000 + 40 * day,
  claimDeadline: 1000 + 70 * day, rebateBps: 5000, engines: { [engine]: { aprBps: 1000 } } };
const enrollment = { event: 'Enrolled', borrower, engine, cap: '10000000', startsAt: 1000 };
const loan = { event: 'Borrowed', borrower, engine, amount: '365000000' };
const receipt = (timestamp, events, transactionHash = `tx-${timestamp}`) => ({ timestamp, transactionHash, events });

test('only campaign-period interest earns a rebate when paid after the campaign ends', () => {
  const result = accountReceipts(policy, [receipt(1000, [enrollment, loan]), receipt(1000 + 30 * day,
    [{ event: 'Repaid', borrower, engine, payer: 'relayer', principal: '365000000', interest: '3000000' }])]);
  assert.deepEqual(result, [{ borrower, engine, cap: 10000000n, startsAt: 1000,
    principal: 0n, eligiblePrincipal: 0n, unpaidInterest: 0n, estimatedRebate: 0n,
    confirmedRebate: 500000n, eligiblePaidInterest: 1000000n, committedRebate: 500000n }]);
});

test('liquidation consumes debt but never earns a rebate from its Repaid log', () => {
  const paid = { event: 'Repaid', borrower, engine, principal: '365000000', interest: '1000000' };
  const result = accountReceipts(policy, [receipt(1000, [enrollment, loan]), receipt(policy.endsAt,
    [paid, { event: 'Liquidated', borrower, engine }])]);
  assert.equal(result[0].confirmedRebate, 0n);
  assert.equal(result[0].estimatedRebate, 0n);
  assert.equal(result[0].principal, 0n);
});

test('oldest interest is paid first and pre-enrollment principal never qualifies', () => {
  const later = { ...policy, endsAt: 1000 + 40 * day, settlementDeadline: 1000 + 50 * day };
  const result = accountReceipts(later, [receipt(1000, [loan]),
    receipt(1000 + 10 * day, [{ ...enrollment, startsAt: 1000 + 10 * day }, loan]),
    receipt(1000 + 20 * day, [{ event: 'Repaid', borrower, engine, principal: '0', interest: '2000000' }])]);
  assert.equal(result[0].eligiblePaidInterest, 500000n);
  assert.equal(result[0].confirmedRebate, 250000n);
  assert.equal(result[0].estimatedRebate, 250000n);
  assert.equal(result[0].principal, 730000000n);
  assert.equal(result[0].eligiblePrincipal, 365000000n);
});

test('partial principal repayment retires eligible draws first', () => {
  const result = accountReceipts(policy, [receipt(999, [loan]), receipt(1000, [enrollment, loan]),
    receipt(1000, [{ event: 'Repaid', borrower, engine, principal: '365000000', interest: '1' }], 'partial')], policy.endsAt);
  assert.equal(result[0].eligiblePrincipal, 0n);
  assert.equal(result[0].estimatedRebate, 0n);
  assert.equal(result[0].confirmedRebate, 0n);
});

test('losses and payments after the settlement deadline do not earn cashback', () => {
  const late = accountReceipts(policy, [receipt(1000, [enrollment, loan]),
    receipt(1000 + 50 * day, [{ event: 'Repaid', borrower, engine, principal: '365000000', interest: '5000000' }])]);
  assert.equal(late[0].confirmedRebate, 0n);
  const loss = accountReceipts(policy, [receipt(1000, [enrollment, loan]), receipt(policy.endsAt,
    [{ event: 'PositionLoss', borrower, engine, principal: '365000000', interest: '1000000' },
      { event: 'Liquidated', borrower, engine }])]);
  assert.equal(loss[0].estimatedRebate, 0n);
  assert.equal(loss[0].confirmedRebate, 0n);
  assert.equal(loss[0].principal, 0n);
});

test('caps cumulative awards and carries sub-unit rebates across partial payments', () => {
  const smallCap = { ...enrollment, cap: '100000' };
  const capped = accountReceipts(policy, [receipt(1000, [smallCap, loan]), receipt(policy.endsAt,
    [{ event: 'Repaid', borrower, engine, principal: '0', interest: '1000000' }])]);
  assert.equal(capped[0].confirmedRebate, 100000n);
  const split = accountReceipts(policy, [receipt(1000, [enrollment, loan]), receipt(policy.endsAt,
    [{ event: 'Repaid', borrower, engine, principal: '0', interest: '1' },
      { event: 'Repaid', borrower, engine, principal: '0', interest: '1' }])]);
  assert.equal(split[0].confirmedRebate, 1n);
});

test('refuses incomplete histories, duplicate receipts and unapproved engines', () => {
  assert.throws(() => accountReceipts(policy, [receipt(1000, [enrollment]), receipt(1001,
    [{ event: 'Repaid', borrower, engine, principal: '0', interest: '1' }])]), /exceeds replayed/);
  assert.throws(() => accountReceipts(policy, [receipt(1000, [enrollment]), receipt(1000, [loan])]), /Duplicate/);
  assert.throws(() => accountReceipts(policy, [receipt(1000, [{ ...loan, engine: 'unknown' }])]), /Unapproved/);
});


test('public wallet cap is shared across markets in paid-receipt order, without reducing prior awards', () => {
 const other='0x000000000000000000000000000000000000e002';
 const publicPolicy={...policy,walletCap:'25000000',engines:{...policy.engines,[other]:{aprBps:1000}}};
 const enroll=e=>({...enrollment,engine:e,cap:'25000000'});
 const draw=e=>({...loan,engine:e,amount:'36500000000'});
 const pay=e=>({event:'Repaid',borrower,engine:e,principal:'0',interest:'40000000'});
 const initial=receipt(1000,[enroll(engine),enroll(other),draw(engine),draw(other)]);
 const first=receipt(1000+4*day,[pay(other)]);
 const firstRows=accountReceipts(publicPolicy,[initial,first]);
 assert.equal(firstRows.find(r=>r.engine===other).confirmedRebate,20_000000n);
 const rows=accountReceipts(publicPolicy,[initial,first,receipt(1000+5*day,[pay(engine)])]);
 assert.equal(rows.find(r=>r.engine===other).confirmedRebate,20_000000n);
 assert.equal(rows.find(r=>r.engine===engine).confirmedRebate,5_000000n);
 assert.equal(rows.reduce((sum,r)=>sum+r.committedRebate,0n),25_000000n);
});
