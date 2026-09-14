import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessRetirement} from './verify-empty-markets.mjs';

const market = () => ({activeDebtPositions: 0n, principal: 0n, interest: 0n, pendingInterest: 0n,
  collateralBalances: [0n, 0n, 0n], shares: 0n, ownerShares: 0n, cash: 0n, fees: 0n,
  engineCash: 0n, exitCash: 0n, paused: true});
const legacy = () => ({debt: 0n, cash: 0n, collateralBalances: [0n], paused: true});

test('only empty and paused deployments clear the retirement state check', () => {
  assert.equal(assessRetirement([market()], [legacy()]).retirementStateClear, true);
  for (const key of ['activeDebtPositions', 'principal', 'interest', 'pendingInterest', 'shares', 'cash', 'fees', 'engineCash', 'exitCash']) {
    assert.equal(assessRetirement([{...market(), [key]: 1n}], [legacy()]).retirementStateClear, false, key);
  }
  assert.equal(assessRetirement([{...market(), paused: false}], [legacy()]).retirementStateClear, false);
  assert.equal(assessRetirement([market()], [{...legacy(), cash: 1n}]).retirementStateClear, false);
});

test('no loans does not imply no lender money or no collateral claims', () => {
  const result = assessRetirement([{...market(), shares: 10n, ownerShares: 9n, cash: 10n,
    collateralBalances: [1n, 0n, 0n]}], [legacy()]);
  assert.equal(result.noLoans, true);
  assert.equal(result.noFunds, false);
  assert.equal(result.noCollateral, false);
  assert.equal(result.ownerOnlyShares, false);
  assert.equal(result.retirementStateClear, false);
  assert.equal(assessRetirement([market()], [{...legacy(), collateralBalances: [1n]}]).retirementStateClear, false);
});

test('missing readings and an empty inventory cannot authorize retirement', () => {
  assert.throws(() => assessRetirement([], []));
  assert.equal(assessRetirement([{}], []).retirementStateClear, false);
  assert.equal(assessRetirement([market()], [{}]).retirementStateClear, false);
});
