export const INTEREST_DENOMINATOR: bigint;
export type CashbackCampaign = {
  startsAt: number; endsAt: number; settlementDeadline: number; claimDeadline: number; rebateBps: number;
};
export type CashbackEnrollment = { startsAt: number; cap: bigint; committedRebate: bigint };
export type CashbackQuote = {
  grossInterest: bigint; eligibleInterest: bigint; rebate: bigint; netInterest: bigint;
  coveredSeconds: number; capped: boolean;
  status: 'inactive' | 'ended' | 'not-enrolled' | 'not-started' | 'enrolled';
};
export function quoteCashback(input: {
  principal: bigint; aprBps: number; now: number; days: number;
  campaign?: CashbackCampaign | null; enrollment?: CashbackEnrollment | null;
}): CashbackQuote;
