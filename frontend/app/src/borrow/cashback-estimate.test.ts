import { describe, expect, it } from 'vitest';
import { quoteCashback } from '../../../../shared/borrower-cashback.mjs';

const day = 86400;
const campaign = { startsAt: 1000, endsAt: 1000 + 10 * day, settlementDeadline: 1000 + 40 * day,
  claimDeadline: 1000 + 70 * day, rebateBps: 5000 };
const enrollment = { startsAt: 1000, cap: 10_000_000n, committedRebate: 0n };

describe('borrower cost quotation', () => {
  it('keeps the full rate for days after the cashback campaign ends', () => {
    expect(quoteCashback({ principal: 365_000_000n, aprBps: 1000, now: 1000, days: 30, campaign, enrollment }))
      .toEqual({ grossInterest: 3_000_000n, eligibleInterest: 1_000_000n, rebate: 500_000n,
        netInterest: 2_500_000n, coveredSeconds: 10 * day, capped: false, status: 'enrolled' });
  });
  it('limits a new estimate by commitments already using the reserved cap', () => {
    const result = quoteCashback({ principal: 365_000_000n, aprBps: 1000, now: 1000, days: 30, campaign,
      enrollment: { ...enrollment, committedRebate: 9_900_000n } });
    expect(result.rebate).toBe(100_000n);
    expect(result.netInterest).toBe(2_900_000n);
    expect(result.capped).toBe(true);
  });
  it('does not promise cashback without enrollment or a campaign', () => {
    const input = { principal: 365_000_000n, aprBps: 1000, now: 1000, days: 30 };
    expect(quoteCashback(input)).toMatchObject({ rebate: 0n, netInterest: 3_000_000n, status: 'inactive' });
    expect(quoteCashback({ ...input, campaign })).toMatchObject({ rebate: 0n, status: 'not-enrolled' });
  });
  it('excludes a draw before enrollment and draws at or after campaign end', () => {
    const input = { principal: 365_000_000n, aprBps: 1000, days: 30, campaign, enrollment };
    expect(quoteCashback({ ...input, now: 999 })).toMatchObject({ rebate: 0n, status: 'not-started' });
    expect(quoteCashback({ ...input, now: campaign.endsAt })).toMatchObject({ rebate: 0n, status: 'ended' });
  });
  it('never rounds cashback up to exceed eligible interest', () => {
    expect(quoteCashback({ principal: 1n, aprBps: 1000, now: 1000, days: 1, campaign, enrollment }))
      .toMatchObject({ grossInterest: 1n, rebate: 0n, netInterest: 1n });
  });
  it('rejects invalid campaign bounds and unreserved commitments', () => {
    const input = { principal: 1n, aprBps: 1000, now: 1000, days: 1, campaign, enrollment };
    expect(() => quoteCashback({ ...input, campaign: { ...campaign, rebateBps: 10000 } })).toThrow();
    expect(() => quoteCashback({ ...input, enrollment: { ...enrollment, committedRebate: 11_000_000n } })).toThrow();
    expect(() => quoteCashback({ ...input, days: NaN })).toThrow();
  });
});
