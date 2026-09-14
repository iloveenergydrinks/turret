"use client";
type Props = {
  connected: boolean; wrongChain: boolean; amountReady: boolean; requiresApproval: boolean;
  approvalReady: boolean | null; submitted: boolean; confirmed: boolean; symbol: string;
};

/** Derived from current wallet/receipt state; never persists success across accounts. */
export function BorrowProgress({ connected, wrongChain, amountReady, requiresApproval, approvalReady,
  submitted, confirmed, symbol }: Props) {
  const steps = [wrongChain ? 'Switch to Robinhood Chain' : 'Connect wallet', 'Choose collateral and amount',
    ...(requiresApproval ? [`Approve ${symbol}`] : []), 'Review and sign loan', 'Receive USDG'];
  const signing = steps.length - 2;
  const active = confirmed ? steps.length : !connected || wrongChain ? 0 : submitted ? steps.length - 1
    : !amountReady ? 1 : requiresApproval && approvalReady !== true ? 2 : signing;
  return <nav className="turret-borrow-progress" aria-label="Loan steps">
    <details>
    <summary><span className="turret-step-current">{confirmed ? "USDG received" : steps[active]}</span><span role="status">{confirmed ? 'Loan confirmed' : `${steps.length - active} ${steps.length - active === 1 ? 'step' : 'steps'} remaining`}</span></summary>
    <ol>{steps.map((label, index) => <li key={label} data-state={index < active ? 'done' : index === active ? 'current' : 'upcoming'}
      aria-current={index === active ? 'step' : undefined}>
      <span className="turret-step-number" aria-hidden="true">{index + 1}</span>
      <span>{label}{index < active && <span className="turret-step-complete"> — complete</span>}</span>
    </li>)}</ol>
    </details>
    {submitted && !confirmed && <p>Your loan is awaiting confirmation. Signing alone does not mean USDG has arrived.</p>}
  </nav>;
}
