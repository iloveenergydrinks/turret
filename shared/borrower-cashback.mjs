/** USDG amounts are six-decimal integers. Time is Unix seconds. */
export const INTEREST_DENOMINATOR = 10000n * 365n * 86400n;
const min = (a, b) => a < b ? a : b;
const ceilDiv = (a, b) => (a + b - 1n) / b;

/** An estimate, not a loan APR change or a published claim entitlement.
 * committedRebate includes earlier confirmed AND estimated unpaid eligible interest;
 * callers must not reuse the same reserved cap for overlapping loan estimates.
 */
export function quoteCashback({ principal, aprBps, now, days, campaign, enrollment }) {
  if (typeof principal !== 'bigint' || principal < 0n || !Number.isSafeInteger(aprBps) || aprBps < 0
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(days) || days < 0 || days > 3650)
    throw new Error('Invalid loan estimate');
  const seconds = days * 86400;
  const grossInterest = ceilDiv(principal * BigInt(aprBps) * BigInt(seconds), INTEREST_DENOMINATOR);
  const empty = (status) => ({ grossInterest, eligibleInterest: 0n, rebate: 0n, netInterest: grossInterest,
    coveredSeconds: 0, capped: false, status });
  if (!campaign) return empty('inactive');
  const { startsAt, endsAt, settlementDeadline, claimDeadline, rebateBps } = campaign;
  if (![startsAt, endsAt, settlementDeadline, claimDeadline, rebateBps].every(Number.isSafeInteger)
    || startsAt < 0 || endsAt <= startsAt || settlementDeadline < endsAt || claimDeadline <= settlementDeadline
    || rebateBps !== 5000) throw new Error('Invalid cashback campaign');
  if (now >= endsAt) return empty('ended');
  if (!enrollment) return empty('not-enrolled');
  if (!Number.isSafeInteger(enrollment.startsAt) || enrollment.startsAt < startsAt || enrollment.startsAt >= endsAt
    || typeof enrollment.cap !== 'bigint' || typeof enrollment.committedRebate !== 'bigint'
    || enrollment.cap <= 0n || enrollment.committedRebate < 0n || enrollment.committedRebate > enrollment.cap)
    throw new Error('Invalid cashback enrollment');
  // A draw before enrollment/campaign start is ineligible even if held into the campaign.
  if (now < enrollment.startsAt) return empty('not-started');
  const coveredSeconds = Math.max(0, Math.min(now + seconds, endsAt) - now);
  const numerator = principal * BigInt(aprBps) * BigInt(coveredSeconds);
  const eligibleInterest = numerator / INTEREST_DENOMINATOR;
  const uncapped = numerator * BigInt(rebateBps) / (INTEREST_DENOMINATOR * 10000n);
  const rebate = min(uncapped, enrollment.cap - enrollment.committedRebate);
  return { grossInterest, eligibleInterest, rebate, netInterest: grossInterest - rebate,
    coveredSeconds, capped: rebate < uncapped, status: 'enrolled' };
}
