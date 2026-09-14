import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Address } from "viem";
import type { Deployment, Loan, Snapshot } from "../../p2p/client";
import type { V3Action } from "./V3LoanActions";
import { collateralAmount, sameAddress, shortAddress } from "./loanPresentation";

/** Keep debt settlement and collateral delivery distinct, in one borrower flow. */
export function RepaymentFlow({ market, loan, account, snapshot, disabled, run, children }: {
  market: Deployment;
  loan: Loan;
  account: Address | null;
  snapshot: Snapshot | null;
  disabled: boolean;
  run: (action: V3Action, success: string) => void;
  children: ReactNode;
}) {
  const [withdrawn, setWithdrawn] = useState<bigint | null>(null);
  const nextStep = useRef<HTMLHeadingElement>(null);
  const repaid = loan.status === "repaid";
  const wasRepaid = useRef(repaid);
  useEffect(() => {
    if (repaid && !wasRepaid.current) {
      nextStep.current?.focus({ preventScroll: true });
      nextStep.current?.scrollIntoView?.({ block: "center", behavior: "instant" });
    }
    wasRepaid.current = repaid;
  }, [repaid]);
  if (!account || !sameAddress(account, loan.borrower)) return children;

  const credit = loan.loanCredits?.COLLATERAL;
  const creditKnown = market.version === 3
    ? !!credit && !credit.unavailable && (credit.nominal === 0n || sameAddress(credit.beneficiary, account))
    : !!snapshot && sameAddress(snapshot.account, account);
  const available = market.version === 3 ? credit?.available ?? 0n : snapshot?.credits.COLLATERAL ?? 0n;
  const nominal = market.version === 3 ? credit?.nominal ?? 0n : loan.collateral;
  // V1/V2 pool credits across loans. Never sweep unrelated collateral credits.
  const amount = available < nominal ? available : nominal;
  const shortfall = market.version === 3 && creditKnown && available < nominal;

  return <section className="p2p-repayment-flow" aria-label="Repay and receive collateral">
    <ol className="p2p-repayment-steps" aria-label="Repayment steps">
      <li aria-current={!repaid ? "step" : undefined} data-complete={repaid}>
        <span aria-hidden="true">{repaid ? "✓" : "1"}</span><strong>Repay USDG</strong>
      </li>
      <li aria-current={repaid && withdrawn === null ? "step" : undefined} data-complete={withdrawn !== null}>
        <span aria-hidden="true">{withdrawn !== null ? "✓" : "2"}</span><strong>Receive {market.collateralSymbol}</strong>
      </li>
    </ol>
    {!repaid ? <>
      <p>Two transactions: repay your loan, then withdraw {market.collateralSymbol} to your wallet here. Your wallet may also request token approval before repayment.</p>
      {children}
    </> : <div className="p2p-repayment-receive">
      <h3 ref={nextStep} tabIndex={-1}>Loan repaid</h3>
      {withdrawn !== null ? <p role="status">{collateralAmount(withdrawn, market)} sent to your wallet. Your loan remains repaid.</p>
        : <>
          <p>Your debt is settled. Complete the second transaction to receive your {market.collateralSymbol}.</p>
          {!creditKnown ? <p role="status">Checking available collateral. Refresh this market if the balance cannot be loaded.</p>
            : amount > 0n ? <>
              <p><strong>{collateralAmount(amount, market)}</strong> available to send to your wallet ({shortAddress(account)}).</p>
              {market.version !== 3 && <p className="p2p-help">This market combines collateral credits from settled loans. This withdrawal is capped at this loan’s collateral amount.</p>}
              {shortfall && <p className="p2p-help">Only part of your collateral is available. Withdrawing this amount preserves your unpaid credit.</p>}
              <button className="p2p-button" disabled={disabled} onClick={() => run(async (client, provider, stage) => {
                if (!client.account || !sameAddress(client.account, account)) throw new Error("Your wallet changed. Review the withdrawal again.");
                const receipt = market.version === 3
                  ? await client.withdrawCredit(provider, loan.id, "COLLATERAL", amount, account, stage)
                  : await client.withdraw(provider, "COLLATERAL", amount, account, stage);
                setWithdrawn(amount);
                return receipt;
              }, `${collateralAmount(amount, market)} withdrawn to your wallet. Your loan remains repaid.`)}>Withdraw {market.collateralSymbol}</button>
              <p className="p2p-help">If you cancel this withdrawal, your loan stays repaid. You can return here to try again.</p>
            </> : <p role="status">No collateral is currently available to withdraw{shortfall ? ". Your unpaid credit remains recorded" : ". It may already have been withdrawn"}.</p>}
        </>}
    </div>}
  </section>;
}
