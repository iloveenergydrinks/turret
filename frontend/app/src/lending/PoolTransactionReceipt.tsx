import { useEffect, useRef } from "react";
import { decodeFunctionData, formatUnits, type Hex } from "viem";
import { isolatedPoolAbi, type IsolatedMarketState } from "@/src/isolated-credit";
import "./pool-transaction.css";

export type PoolConfirmation = { hash: Hex; block: bigint; kind: "lend" | "withdraw" | "redeem" | "transaction"; amount?: bigint };

// Call only after the successful receipt and the reviewed transaction match.
// Decode the verified calldata so recovery after a reload gets the same receipt.
export function confirmedPoolAction(data: Hex, hash: Hex, block: bigint): PoolConfirmation {
  try {
    const call = decodeFunctionData({ abi: isolatedPoolAbi, data });
    const kind = call.functionName.startsWith("deposit") ? "lend"
      : call.functionName.startsWith("withdraw") ? "withdraw"
      : call.functionName.startsWith("redeem") ? "redeem" : "transaction";
    const amount = call.args?.[0];
    if (kind !== "transaction" && typeof amount === "bigint") return { hash, block, kind, amount };
  } catch { /* Unknown calls get a factual generic receipt. */ }
  return { hash, block, kind: "transaction" };
}

export function PoolTransactionReceipt({ confirmation, symbol, state, explorer, onDone, rewardActivation = false, rewardStatus = "checking" }: {
  confirmation: PoolConfirmation; symbol: string; state: IsolatedMarketState | null;
  explorer?: string; rewardActivation?: boolean; rewardStatus?: "checking" | "needed" | "active" | "unavailable"; onDone: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [confirmation.hash]);
  const { kind, amount, hash, block } = confirmation;
  const amountText = amount === undefined ? "" : formatUnits(amount, kind === "redeem" ? 12 : 6);
  const title = kind === "lend" ? `Lent ${amountText} USDG`
    : kind === "withdraw" ? `Withdrew ${amountText} USDG`
    : kind === "redeem" ? `Redeemed ${amountText} shares` : "Transaction confirmed";
  const unfinished = kind === "lend" && rewardActivation && !["active", "unavailable"].includes(rewardStatus);
  const fresh = state && state.blockNumber >= block;
  const value = fresh ? state.shares * (state.totalAssets + 1n) / (state.totalShares + 1_000_000n) : 0n;
  return <section className="turret-pool-receipt" aria-label="Transaction receipt">
    <div role="status" aria-live="polite">
      {!unfinished && <svg className="turret-pool-receipt-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true"><circle cx="18" cy="18" r="16" stroke="currentColor" strokeWidth="1.5"/><path d="m11 18 5 5 10-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      <h2 ref={heading} tabIndex={-1}>{title}</h2>
      <p>{kind === "lend" ? `Your deposit into the ${symbol} pool is confirmed.`
        : kind === "withdraw" ? "The USDG has been returned to your wallet."
        : `Your ${symbol} pool transaction is confirmed.`}</p>
    </div>
    {!unfinished && (fresh ? <dl className="turret-pool-receipt-balances">
      <div><dt>Shares held in wallet · estimated value</dt><dd>{formatUnits(value, 6)} USDG</dd></div>
      <div><dt>Wallet balance</dt><dd>{formatUnits(state.cashBalance, 6)} USDG</dd></div>
    </dl> : <p role="status">Updating your position and wallet balances… Your transaction is confirmed.</p>)}
    <div className="turret-pool-receipt-actions">
      {kind === "lend" && rewardActivation && <p>{rewardStatus === "active" ? "Your deposit and TURRET reward activation are complete." : rewardStatus === "unavailable" ? "Your USDG is lent. TURRET rewards are currently unavailable; pool interest depends on borrowing activity." : "Your USDG is lent. TURRET rewards are a separate step: check and finish activation below before leaving."}</p>}
      {!unfinished && <button type="button" className="dockyard-primary-action" onClick={onDone}>Done</button>}
      {!unfinished && <a href="/portfolio">View portfolio</a>}
      {explorer && <a href={`${explorer.replace(/\/$/, "")}/tx/${hash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    </div>
  </section>;
}
