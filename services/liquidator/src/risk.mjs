export const USD = 10n ** 18n;
export const BPS = 10000n;
export const min = (...values) => values.reduce((a, b) => a < b ? a : b);

// Deliberately matches the two floors in DockyardUSDGCreditVault._isSafe.
// Comparing the rounded positionLtvBps getter instead misses boundary cases.
export function liquidationQuote({ collateral, debt, price, ltvBps, bonusBps, scale, maxRepay }) {
  const value = collateral * price / USD;
  const maximumDebt = value * BigInt(ltvBps) / BPS;
  const eligible = debt * scale > maximumDebt;
  const collateralCap = (value * BPS / (BPS + BigInt(bonusBps))) / scale;
  const repaid = eligible ? min(maxRepay, debt, collateralCap) : 0n;
  const seizeValue = repaid * scale * (BPS + BigInt(bonusBps)) / BPS;
  const seized = repaid === 0n ? 0n : repaid === collateralCap ? collateral : min(collateral, seizeValue * USD / price);
  return { eligible, repaid, seized, value, maximumDebt, collateralCap, badDebt: eligible && repaid === 0n };
}

export function feedHealth(round, decimals, timestamp, staleness) {
  if (!round) return { valid: false, reason: 'unavailable' };
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const age = timestamp - updatedAt;
  const valid = answer > 0n && updatedAt > 0n && age >= 0n && age < staleness && answeredInRound >= roundId;
  return { valid, age: age.toString(), roundId: roundId.toString(), updatedAt: updatedAt.toString(),
    reason: valid ? 'valid' : 'invalid_or_stale', price: valid ? answer * 10n ** BigInt(18 - decimals) : 0n };
}
