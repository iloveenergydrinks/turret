import type { IsolatedIntent } from "../../isolated-credit";

/** Describes the transaction's asset movement, not a quote or a promise of returns. */
export function actionExplanation(kind: IsolatedIntent["kind"], symbol: string): string {
  const explanations: Record<IsolatedIntent["kind"], string> = {
    depositBorrow: `You are borrowing. Your ${symbol} moves from your wallet into the lending contract as collateral. USDG moves from the pool to your wallet, and you owe that loan plus interest.`,
    borrow: `You receive more USDG from the pool. Your debt increases; the ${symbol} already in the contract continues to secure it.`,
    addCollateral: `You send more ${symbol} from your wallet to secure your loan. This action does not give you USDG or repay any debt.`,
    removeCollateral: `The contract sends ${symbol} collateral back to your wallet. Your USDG debt does not decrease. With less collateral, an outstanding loan has less protection against liquidation.`,
    repay: `You pay USDG from your wallet to reduce your debt. This action does not withdraw your ${symbol}; use Withdraw collateral or Repay & close to recover it.`,
    close: `You pay the full USDG debt, including accrued interest, from your wallet. The contract returns your remaining ${symbol} collateral to your wallet when the transaction succeeds.`,
    lend: `You are lending. USDG leaves your wallet and enters this pool. You receive pool shares representing your claim on its assets, not ${symbol} tokens. Borrowers pay interest; losses can reduce your shares’ value.`,
    withdraw: "The pool sends USDG to your wallet and burns the corresponding pool shares. Only currently available pool cash can be withdrawn; funds on loan may not be available yet.",
    redeem: "You exchange the selected pool shares for USDG sent to your wallet. Those shares are burned. The review shows the minimum USDG you will receive.",
    redeemWorthless: "You give up shares currently worth zero. Those shares are burned and you receive no USDG. This does not recover a loss.",
  };
  return explanations[kind];
}
