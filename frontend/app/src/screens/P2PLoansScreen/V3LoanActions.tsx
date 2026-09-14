import { useId, useState } from "react";
import type { Address, EIP1193Provider } from "viem";
import type { Deployment, Loan, P2PClient, TransactionStage } from "../../p2p/client";
import { collateralAmount, displayDate, finalDeadline, loanAmount, sameAddress, shortAddress, validAddress } from "./loanPresentation";
import { parseUtcInput, planCreditRepayment } from "./v3Terms";

export type V3Action = (client: P2PClient, provider: EIP1193Provider, onStage: (stage: TransactionStage) => void) => Promise<unknown>;
type Run = (action: V3Action, success: string) => void;

type Shared = { market: Deployment; loan: Loan; account: Address; disabled: boolean; run: Run };

export function V3CreditRepayment({ market, loan, account, disabled, run, loans, walletBalance, walletBalanceUnavailable }: Shared & { loans: Loan[]; walletBalance: bigint; walletBalanceUnavailable?: boolean }) {
  const [reviewed, setReviewed] = useState("");
  const plan = planCreditRepayment(loans, account, loan.id, loan.principal + loan.interest);
  const identity = `${loan.id}:${finalDeadline(loan)}:${plan.sourceIds.join()}:${plan.sourceAmounts.join()}:${plan.walletAmount}`;
  if (!plan.creditAmount) return null;
  return <section className="p2p-controls p2p-v3-action">
    <h3>Repay using your USDG credits</h3>
    <p className="p2p-help">Use credits you own in this market and pay any remainder from your wallet. The entire loan is repaid in one transaction.</p>
    <dl className="p2p-cost">
      <div><dt>Your credits</dt><dd>{loanAmount(plan.creditAmount, market)}</dd></div>
      <div><dt>From your wallet</dt><dd>{loanAmount(plan.walletAmount, market)}</dd></div>
      <div className="p2p-total"><dt>Full repayment</dt><dd>{loanAmount(loan.principal + loan.interest, market)}</dd></div>
    </dl>
    <ul className="p2p-credit-sources" aria-label="Credits used for repayment">{plan.sourceIds.map((id, index) => <li key={id.toString()}>Loan #{id.toString()}: {loanAmount(plan.sourceAmounts[index]!, market)}</li>)}</ul>
    <p className="p2p-help">Only loaded credits from this market are included, up to 16 loans per repayment. The borrower receives the collateral remaining in this loan’s vault.</p>
    <label className="p2p-check"><input type="checkbox" disabled={disabled} checked={reviewed === identity} onChange={event => setReviewed(event.target.checked ? identity : "")} /><span>I approve these credits and {loanAmount(plan.walletAmount, market)} from my wallet to fully repay loan #{loan.id.toString()}.</span></label>
    <button className="p2p-button p2p-secondary" disabled={disabled || reviewed !== identity || walletBalance < plan.walletAmount || (!!walletBalanceUnavailable && plan.walletAmount > 0n)} onClick={() => run((client, provider, stage) => client.repayWithCredits(provider, loan.id, plan.sourceIds, plan.sourceAmounts, plan.walletAmount, stage), "Loan repaid using your credits and wallet funds. Settlement credits are ready to withdraw.")}>Repay with credits</button>
    {walletBalanceUnavailable && plan.walletAmount > 0n ? <p className="p2p-help">Your wallet balance is unavailable. Refresh before paying a remainder from your wallet.</p> : walletBalance < plan.walletAmount && <p className="p2p-help">Your wallet needs {loanAmount(plan.walletAmount, market)} to cover the remainder.</p>}
  </section>;
}

export function V3LoanCredit({ market, loan, account, disabled, run, token, recipient }: Shared & { token: "USDG" | "COLLATERAL"; recipient: string }) {
  const [acknowledged, setAcknowledged] = useState("");
  const credit = loan.loanCredits?.[token];
  if (credit?.unavailable && (sameAddress(loan.lender, account) || sameAddress(loan.borrower, account))) return <section className="p2p-credit p2p-v3-credit" aria-label={`Loan ${loan.id} ${token} withdrawal`}><p role="status">Loan #{loan.id.toString()} · {token === "USDG" ? market.loanSymbol : market.collateralSymbol} credit balance unavailable.</p><p className="p2p-help">The token balance could not be read. Refresh this market before withdrawing; the other token and loan actions remain available.</p></section>;
  if (!credit || !sameAddress(credit.beneficiary, account) || credit.nominal === 0n) return null;
  const amount = (value: bigint) => token === "USDG" ? loanAmount(value, market) : collateralAmount(value, market);
  const shortfall = credit.nominal > credit.available ? credit.nominal - credit.available : 0n;
  const identity = `${credit.nominal}:${credit.available}:${recipient.toLowerCase()}`;
  const recipientValid = validAddress(recipient) && !sameAddress(recipient, market.address) && (!loan.vault || !sameAddress(recipient, loan.vault));
  return <section className="p2p-credit p2p-v3-credit" aria-label={`Loan ${loan.id} ${token} withdrawal`}>
    <p><strong>{amount(credit.available)} available</strong><span>{market.collateralSymbol} · Loan #{loan.id.toString()}</span></p>
    <dl className="p2p-cost">
      <div><dt>Recorded credit</dt><dd>{amount(credit.nominal)}</dd></div>
      <div><dt>Available in this vault</dt><dd>{amount(credit.available)}</dd></div>
      {shortfall > 0n && <div><dt>Token shortfall</dt><dd>{amount(shortfall)}</dd></div>}
    </dl>
    {shortfall > 0n ? <>
      <p className="p2p-help">This vault holds less than the recorded credit. You can wait, or withdraw what remains and permanently give up the rest of this credit. Other loans do not cover this loss.</p>
      {credit.available > 0n && <button className="p2p-button p2p-secondary" disabled={disabled || !recipientValid} onClick={() => recipientValid && run((client, provider, stage) => client.withdrawCredit(provider, loan.id, token, credit.available, recipient, stage), "Available funds withdrawn. The unpaid balance remains recorded in this loan’s credit.")}>Withdraw available, keep unpaid credit</button>}
      <label className="p2p-check"><input type="checkbox" checked={acknowledged === identity} disabled={disabled} onChange={event => setAcknowledged(event.target.checked ? identity : "")} /><span>I accept at least {amount(credit.available)} and permanently write off the unpaid balance of this credit, currently {amount(shortfall)}.</span></label>
      <button className="p2p-button p2p-secondary" disabled={disabled || !recipientValid || acknowledged !== identity} onClick={() => recipientValid && run((client, provider, stage) => client.withdrawAvailableCredit(provider, loan.id, token, credit.available, recipient, stage), "Available funds withdrawn and the remaining credit permanently written off.")}>{credit.available === 0n ? "Write off this credit" : "Withdraw available and write off rest"}</button>
    </> : <button className="p2p-button p2p-secondary" disabled={disabled || !recipientValid} onClick={() => recipientValid && run((client, provider, stage) => client.withdrawCredit(provider, loan.id, token, credit.nominal, recipient, stage), `Loan #${loan.id} funds withdrawn to ${shortAddress(recipient)}.`)}>Withdraw {token === "USDG" ? market.loanSymbol : market.collateralSymbol}</button>}
    {!recipientValid && <p className="p2p-help">Enter a valid recipient different from this market and its loan vault.</p>}
  </section>;
}

export function V3Extension({ market, loan, account, disabled, run, now }: Shared & { now: number }) {
  const field = useId();
  const [deadline, setDeadline] = useState("");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ oldDeadline: number; newDeadline: number; expiresAt: number } | null>(null);
  const [accepted, setAccepted] = useState("");
  if (loan.status !== "active" || (!sameAddress(account, loan.lender) && !sameAddress(account, loan.borrower))) return null;
  const proposal = loan.extensionProposal;
  const currentDeadline = finalDeadline(loan);
  const validProposal = proposal && proposal.expiresAt > now && proposal.oldDeadline === currentDeadline && proposal.newDeadline > now;
  const isProposer = proposal && sameAddress(proposal.proposer, account);
  const proposalKey = proposal ? `${proposal.nonce}:${proposal.oldDeadline}:${proposal.newDeadline}:${proposal.expiresAt}:${proposal.proposer}` : "";
  const draftValid = draft && draft.oldDeadline === currentDeadline && draft.expiresAt > now && draft.newDeadline > now;
  return <section className="p2p-controls p2p-v3-action">
    <h3>Agree a deadline extension</h3>
    <p className="p2p-help">Both lender and borrower must agree on-chain. Repayment stays {loanAmount(loan.principal + loan.interest, market)}; no extra interest is added. A proposal does not pause the current deadline or prevent the lender claiming after it.</p>
    <p className="p2p-help">Current final deadline: <strong>{displayDate(currentDeadline)}</strong>. An overdue loan can be extended only before it is settled.</p>
    {validProposal ? <div className="p2p-extension-review">
      <h3>{isProposer ? "Your proposed extension" : "Extension to review"}</h3>
      <dl className="p2p-cost"><div><dt>Current final deadline</dt><dd>{displayDate(proposal.oldDeadline)}</dd></div><div><dt>Proposed final deadline</dt><dd>{displayDate(proposal.newDeadline)}</dd></div><div><dt>Accept before</dt><dd>{displayDate(proposal.expiresAt)}</dd></div><div><dt>Unchanged full repayment</dt><dd>{loanAmount(loan.principal + loan.interest, market)}</dd></div></dl>
      {isProposer ? <><p className="p2p-help">Waiting for the other party to accept. Your current deadline still applies.</p><button className="p2p-button p2p-secondary" disabled={disabled} onClick={() => run((client, provider, stage) => client.cancelExtension(provider, loan.id, proposal.nonce, stage), "Extension proposal cancelled. The loan deadline is unchanged.")}>Cancel extension proposal</button></> : <>
        <label className="p2p-check"><input type="checkbox" disabled={disabled} checked={accepted === proposalKey} onChange={event => setAccepted(event.target.checked ? proposalKey : "")} /><span>I agree to the exact final deadline above. Repayment and collateral terms stay unchanged.</span></label>
        <button className="p2p-button" disabled={disabled || accepted !== proposalKey} onClick={() => run((client, provider, stage) => client.acceptExtension(provider, loan.id, proposal, stage), "Extension agreed. Download fresh calendar reminders for the new final deadline.")}>Accept deadline extension</button>
      </>}
    </div> : <form onSubmit={event => {
      event.preventDefault(); setError("");
      try {
        const newDeadline = parseUtcInput(deadline), expiresAt = parseUtcInput(expires);
        if (newDeadline <= currentDeadline || newDeadline <= now) throw new Error("Choose a final deadline later than the current deadline and the current time.");
        if (expiresAt <= now || expiresAt > newDeadline) throw new Error("The proposal must expire after now and no later than the proposed final deadline.");
        setDraft({ oldDeadline: currentDeadline, newDeadline, expiresAt });
      } catch (cause) { setDraft(null); setError(cause instanceof Error ? cause.message : "Check the extension dates."); }
    }}>
      <div className="p2p-form-grid"><label htmlFor={`${field}-deadline`}>New final deadline · UTC<input id={`${field}-deadline`} type="datetime-local" value={deadline} disabled={disabled} onChange={event => { setDeadline(event.target.value); setDraft(null); }} /></label><label htmlFor={`${field}-expires`}>Proposal expires · UTC<input id={`${field}-expires`} type="datetime-local" value={expires} disabled={disabled} onChange={event => { setExpires(event.target.value); setDraft(null); }} /></label></div>
      <p className="p2p-help">Both fields use UTC. The new final deadline includes all grace time; no additional grace period is added.</p>
      {error && <p role="alert" className="p2p-help">{error}</p>}
      {draftValid ? <div className="p2p-extension-review"><p>Propose moving the final deadline from <strong>{displayDate(draft.oldDeadline)}</strong> to <strong>{displayDate(draft.newDeadline)}</strong>. The other party must accept before <strong>{displayDate(draft.expiresAt)}</strong>.</p><p className="p2p-help">Full repayment remains {loanAmount(loan.principal + loan.interest, market)}. The existing deadline applies until acceptance confirms.</p><button className="p2p-button" type="button" disabled={disabled} onClick={() => run((client, provider, stage) => client.proposeExtension(provider, loan.id, draft.newDeadline, draft.expiresAt, stage), "Extension proposed. The current deadline still applies until the other party accepts.")}>Confirm extension proposal</button></div> : <button type="submit" className="p2p-button p2p-secondary" disabled={disabled}>Review extension</button>}
    </form>}
  </section>;
}
