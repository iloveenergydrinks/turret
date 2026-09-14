import type { Deployment, Loan } from "../../p2p/client";
import { collateralAmount } from "./loanPresentation";

export function collateralRecovery(loan: Loan) {
  const available = loan.collateralAvailable === undefined ? undefined
    : loan.collateralAvailable < loan.collateral ? loan.collateralAvailable : loan.collateral;
  return { available, shortfall: available === undefined ? undefined : loan.collateral - available };
}

export const collateralReviewKey = (market: Deployment, loan: Loan) =>
  `${market.address}:${loan.id}:${loan.collateral}:${loan.collateralAvailable ?? "unknown"}:${loan.principal + loan.interest}`;

export function CollateralRecovery({ market, loan }: { market: Deployment; loan: Loan }) {
  if (market.version !== 3 || loan.status !== "active") return null;
  const { available, shortfall } = collateralRecovery(loan);
  return <section className="p2p-collateral-recovery" aria-label="Collateral recovery before repayment">
    <dl className="p2p-cost">
      <div><dt>Originally locked</dt><dd>{collateralAmount(loan.collateral, market)}</dd></div>
      <div><dt>Available after repayment</dt><dd>{available === undefined ? "Balance unavailable" : collateralAmount(available, market)}</dd></div>
      {shortfall !== undefined && shortfall > 0n && <div><dt>Collateral shortfall</dt><dd>{collateralAmount(shortfall, market)}</dd></div>}
    </dl>
    {available === undefined ? <p role="status" className="p2p-help">The vault’s collateral balance could not be read. The full debt is still due; repayment does not guarantee recovery of the original collateral. Refresh to check the balance.</p>
      : shortfall! > 0n ? <p role="status" className="p2p-help">The vault has lost collateral. Full repayment releases a claim for the {collateralAmount(available, market)} currently available. It does not restore the missing tokens.</p>
      : <p className="p2p-help">This is the latest verified vault balance. Token restrictions can still prevent withdrawal and balances can change before confirmation.</p>}
  </section>;
}
