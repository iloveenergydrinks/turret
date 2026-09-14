import { TermLabel } from "../comps/FieldInfo/FieldInfo";
import { formatUnits } from "viem";
import { lenderExitAvailability, type ExitSnapshot } from "./exit-availability";
import "./lending-exit.css";

export function LenderExitStatus({ snapshot, connected, refreshing, onRefresh, onWithdraw, disabled = false }: {
  snapshot: ExitSnapshot | null;
  connected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onWithdraw: (amount: bigint) => void;
  disabled?: boolean;
}) {
  const exit = connected && snapshot ? lenderExitAvailability(snapshot) : null;
  return <section className="turret-exit-status" aria-label="Withdrawal availability">
    {!connected ? <p>Connect your wallet to see how much you can withdraw. Before depositing, allow for some or all of your USDG to remain on loan until liquidity returns.</p>
      : !exit ? <p role="status">{refreshing ? "Checking withdrawal availability…" : "Withdrawal data is unavailable. Refresh to try again."}</p>
      : exit.status === "empty" ? <p>Before depositing, allow for some or all of your USDG to remain on loan until liquidity returns.</p>
      : <>
        <div className="turret-exit-available">
        <dl>
          <div><dt><TermLabel topic="withdrawable" helpLabel="Available to withdraw now">Available to withdraw now</TermLabel></dt><dd>{formatUnits(exit.available, 6)} USDG</dd></div>
          {exit.unavailable > 0n && <div><dt><TermLabel topic="unavailable" helpLabel="Unavailable to withdraw">Unavailable to withdraw</TermLabel></dt><dd>{formatUnits(exit.unavailable, 6)} USDG</dd></div>}
        </dl>
        {exit.available > 0n && <button type="button" disabled={disabled || refreshing}
          onClick={() => onWithdraw(exit.available)}>Use available amount</button>}
        </div>
        {exit.status !== "available" && <p role="status">
          {exit.status === "partial" ? "You can withdraw part of your position now. The rest becomes available when pool liquidity returns."
            : exit.status === "no-cash" ? "The pool has no available USDG. Withdrawals can resume when liquidity returns and market checks pass."
            : exit.status === "checks" ? "The pool has cash, but its current withdrawal limit is zero. Market checks are preventing an exit; more deposits alone may not resolve this."
            : exit.status === "dust" ? "Your share value is below one USDG base unit. There is no withdrawable amount at the token's current precision."
            : "Your shares currently have no redeemable USDG value. Review the pool's loss information before surrendering shares."}
        </p>}
      </>}
    <details>
      <summary>How withdrawals work</summary>
      <p>You can withdraw the USDG currently available to your shares. Money on loan may become available as borrowers repay or liquidity enters the pool. There is no guaranteed date for a full withdrawal.</p>
      <p>Availability can change before your transaction confirms. Position value may include unpaid interest and can fall after losses.</p>
      {connected && <button type="button" disabled={refreshing || disabled} onClick={onRefresh}>
        {refreshing ? "Refreshing…" : "Refresh availability"}
      </button>}
    </details>
  </section>;
}
