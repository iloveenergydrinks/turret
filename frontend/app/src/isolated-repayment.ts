import { formatUnits } from "viem";

type RepaymentState = { debt: bigint; cashBalance: bigint; minimumDebt: bigint };

// The reviewed maximum covers five minutes of interest plus two micro USDG for
// rounding. The contract takes only the actual debt; never exceed the wallet.
export function getFullRepaymentAmount(state: { debt: bigint; cashBalance: bigint; aprBps: number }): bigint {
  if (state.debt <= 0n || state.cashBalance <= 0n) return 0n;
  const denominator = 10000n * 365n * 86400n;
  const interest = (state.debt * BigInt(state.aprBps) * 300n + denominator - 1n) / denominator;
  const cap = state.debt + interest + 2n;
  return cap < state.cashBalance ? cap : state.cashBalance;
}

// Match the contract: repay caps the transfer at the debt, while close also
// requires clearing it. Choosing whether to return collateral belongs to the UI.
export function repaymentProblem(state: RepaymentState, kind: "repay" | "close", amount: bigint): string | undefined {
  if (state.debt === 0n) return "You have no outstanding loan to repay.";
  if (kind === "close" && state.cashBalance < state.debt) {
    return `Your wallet holds ${formatUnits(state.cashBalance, 6)} USDG, but full repayment needs ${formatUnits(state.debt, 6)} USDG. Add ${formatUnits(state.debt - state.cashBalance, 6)} USDG to repay in full.`;
  }
  if (amount <= 0n) return "Enter a positive repayment amount.";
  const paid = amount < state.debt ? amount : state.debt;
  if (paid > state.cashBalance) {
    return `Your wallet holds ${formatUnits(state.cashBalance, 6)} USDG. Add USDG or reduce the repayment.`;
  }
  const remaining = state.debt - paid;
  if (kind === "close" && remaining > 0n) {
    return "This amount will not close your loan. Review repayment again to update the amount for accrued interest.";
  }
  if (remaining > 0n && remaining < state.minimumDebt) {
    const maximum = state.debt > state.minimumDebt ? state.debt - state.minimumDebt : 0n;
    return maximum > 0n
      ? `Repay at most ${formatUnits(maximum, 6)} USDG to leave at least ${formatUnits(state.minimumDebt, 6)} USDG of debt, or choose “Repay in full”.`
      : `A partial repayment must leave at least ${formatUnits(state.minimumDebt, 6)} USDG of debt. Choose “Repay in full” to clear this loan.`;
  }
  return undefined;
}
