"use client";
import { useId } from 'react';
import { formatUnits } from 'viem';
import { quoteCashback, type CashbackCampaign, type CashbackEnrollment } from '../../../../shared/borrower-cashback.mjs';

export type CashbackEstimateState = {
  campaign?: CashbackCampaign | null;
  enrollment?: CashbackEnrollment | null;
  rewardsUnavailable?: boolean;
  walletRequired?: boolean;
};
type Props = CashbackEstimateState & {
  principal: bigint; aprBps: number | null; now: number; days: number; onDaysChange: (days: number) => void;
};
const usdg = (amount: bigint) => `${Number(formatUnits(amount, 6)).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDG`;
const date = (timestamp: number) => new Date(timestamp * 1000).toLocaleString('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});

export function LoanCostDetails({ principal, aprBps, now, days, onDaysChange, campaign, enrollment, rewardsUnavailable, walletRequired }: Props) {
  const periodId = useId();
  let quote = null;
  let unavailable = !!rewardsUnavailable;
  if (aprBps !== null && principal > 0n) {
    try { quote = quoteCashback({ principal, aprBps, now, days, campaign, enrollment }); }
    catch {
      unavailable = true;
      quote = quoteCashback({ principal, aprBps, now, days });
    }
  }
  return <div className="turret-loan-cost" aria-label="Borrowing cost">
    <div className="turret-interest-period">
      <label htmlFor={periodId}>Borrowing cost <span className="turret-sr-only">— estimate period</span></label>
      <select id={periodId} aria-label="Estimate period" value={days} onChange={event => onDaysChange(Number(event.target.value))}>
        {[7, 30, 90].map(value => <option key={value} value={value}>{value} days</option>)}
      </select>
    </div>
    <dl className="turret-cost-facts">
      <div><dt>Contractual APR</dt><dd>{aprBps === null ? '—' : `${aprBps / 100}%`}</dd></div>
      <div><dt>Estimated interest</dt><dd>{quote ? usdg(quote.grossInterest) : '—'}</dd></div>
      {(campaign || unavailable) && <div><dt>Estimated cashback</dt><dd>{quote && !unavailable ? usdg(quote.rebate) : '—'}</dd></div>}
      {(campaign || unavailable) && <div className="turret-loan-net-cost"><dt>Estimated net interest</dt><dd>{quote && !unavailable ? usdg(quote.netInterest) : '—'}</dd></div>}
    </dl>
    {walletRequired ? <p>Connect your wallet to check cashback eligibility.</p>
      : unavailable ? <p role="status">Cashback is unavailable. Check your terms before relying on a rebate.</p>
      : campaign ? <p className="turret-cashback-end">Cashback accrual ends {date(campaign.endsAt)}.</p>
      : <p>No borrower cashback campaign is active.</p>}
    {campaign && !walletRequired && !unavailable && !enrollment && <p>No cashback is included until you enroll for this market.</p>}
    <details className="turret-estimate-details">
      <summary>Estimate details{campaign ? ' & cashback terms' : ''}</summary>
      <p>Assumes the amount and APR stay unchanged. Network fees are extra.</p>
      {campaign && !walletRequired && !unavailable && <>
        <p>Only eligible interest accrued before the campaign ends receives the 50% rebate.</p>
        <p>Pay eligible interest by {date(campaign.settlementDeadline)} and claim by {date(campaign.claimDeadline)}. Cashback is paid separately after your repayment is verified.</p>
        {enrollment && <p>Your reserved cashback cap is {usdg(enrollment.cap)} across eligible borrowing covered by your enrollment.
          {quote?.capped ? ' Existing commitments limit the rebate shown here.' : ' Other eligible borrowing can use the same cap; public campaigns share it across markets.'}</p>}
      </>}
      <a href="/borrow/cashback-terms">Read borrower cashback terms ↗</a>
    </details>
  </div>;
}
