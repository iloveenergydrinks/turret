import { formatUnits, maxUint256 } from "viem";
import { positiveAmount } from "./dockyard-amount";
import type { IsolatedIntent, IsolatedMarketState } from "./isolated-credit";
import { repaymentProblem } from "./isolated-repayment";

// Display-only truncation. Inputs, approvals and transaction amounts retain
// their full precision; a displayed maximum must never round up.
export function displayTokenAmount(value: bigint | undefined, decimals = 6, digits = 6): string {
  if (value === undefined) return "—";
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const shown = fraction.slice(0, digits).replace(/0+$/, "");
  if (value > 0n && whole === "0" && !shown) return `<0.${"0".repeat(digits - 1)}1`;
  return `${whole}${shown ? `.${shown}` : ""}`;
}
const positive = (value: bigint) => value > 0n ? value : 0n;
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);

export function validateIsolatedForm(
  state: IsolatedMarketState | null,
  kind: IsolatedIntent["kind"],
  input: string,
  extra: string,
  symbol: string,
) {
  const collateralAction = kind === "addCollateral" || kind === "removeCollateral";
  const decimals = collateralAction ? 18 : kind === "redeem" || kind === "redeemWorthless" ? 12 : 6;
  const amount = positiveAmount(input, decimals);
  const deposit = kind === "depositBorrow" ? positiveAmount(extra, 18) : 0n;
  const amountErrors: string[] = [];
  let collateralError = "";
  if (input.trim() && (!amount || amount > maxUint256)) {
    amountErrors.push(`Enter a positive amount with no more than ${decimals} decimal places.`);
  }
  if (kind === "depositBorrow" && extra.trim() && (!deposit || deposit > maxUint256)) {
    collateralError = "Enter a positive collateral amount with no more than 18 decimal places.";
  }
  const borrowing = kind === "depositBorrow" || kind === "borrow";
  let belowCollateralMinimum = false;
  let preview: {
    maxAdditional: bigint; collateralLimit: bigint; poolLimit: bigint;
    totalCollateral: bigint; collateralValue: bigint; projectedDebt: bigint; projectedLtv: bigint | null;
  } | null = null;
  if (state) {
    if (kind === "depositBorrow" && deposit > state.collateralBalance) {
      collateralError = `Your wallet holds ${displayTokenAmount(state.collateralBalance, 18)} ${symbol}. Reduce the deposit or use your wallet balance.`;
    }
    if (borrowing && state.borrowingPrice !== null && state.borrowingPrice !== undefined && state.price) {
      const totalCollateral = state.collateral + deposit;
      // Match the contract's integer division order and include existing debt.
      const limit = totalCollateral * state.borrowingPrice / 10n ** 18n
        * BigInt(state.maxLtvBps) / 10000n / 10n ** 12n;
      const collateralLimit = positive(limit - state.debt);
      const poolLimit = min(state.cash, positive(state.debtLimit - state.principal));
      const collateralValue = totalCollateral * state.price / 10n ** 18n;
      const projectedDebt = state.debt + amount;
      preview = {
        collateralLimit, poolLimit, totalCollateral, collateralValue, projectedDebt,
        maxAdditional: state.riskPaused || state.maxDeposit === 0n ? 0n : min(collateralLimit, poolLimit),
        projectedLtv: totalCollateral > 0n
          ? projectedDebt * 10n ** 30n * 10000n / (totalCollateral * state.price) : null,
      };
      belowCollateralMinimum = !state.riskPaused && state.maxDeposit !== 0n
        && state.borrowingPrice > 0n && state.maxLtvBps > 0
        && (kind === "borrow" || deposit > 0n && !collateralError)
        && state.debt + collateralLimit < state.minimumDebt;
      if (belowCollateralMinimum) {
        // Invert each integer division in the contract, rounding requirements up.
        const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
        const valueNeeded = ceil(state.minimumDebt * 10n ** 12n * 10000n, BigInt(state.maxLtvBps));
        const totalNeeded = ceil(valueNeeded * 10n ** 18n, state.borrowingPrice);
        const roundedUp = (value: bigint) => displayTokenAmount(ceil(value, 10n ** 12n) * 10n ** 12n, 18);
        amountErrors.push(`This collateral supports only ${displayTokenAmount(state.debt + collateralLimit)} USDG, below the pool's ${displayTokenAmount(state.minimumDebt)} USDG minimum. At the current price, you need at least ${roundedUp(totalNeeded)} ${symbol} in total (${roundedUp(positive(totalNeeded - totalCollateral))} more). You can also request a smaller P2P loan.`);
        preview.maxAdditional = 0n;
      }
    }
    if (amount > 0n && amount <= maxUint256) {
      if (borrowing) {
        if (amount > state.cash) amountErrors.push(`Only ${displayTokenAmount(state.cash)} USDG is available in this pool. Reduce the loan amount.`);
        const headroom = positive(state.debtLimit - state.principal);
        if (amount > headroom && headroom < state.cash) amountErrors.push(`This market can lend another ${displayTokenAmount(headroom)} USDG under its borrowing cap.`);
        if (!belowCollateralMinimum && state.debt + amount < state.minimumDebt) amountErrors.push(`Your total loan must be at least ${displayTokenAmount(state.minimumDebt)} USDG.`);
        if (!belowCollateralMinimum && preview && (kind === "borrow" || deposit > 0n && !collateralError) && amount > preview.collateralLimit) {
          amountErrors.push(`This collateral supports at most ${displayTokenAmount(preview.collateralLimit)} USDG of additional borrowing. Deposit more collateral or borrow less.`);
        }
      } else if (kind === "addCollateral" && amount > state.collateralBalance) {
        amountErrors.push(`Your wallet holds ${displayTokenAmount(state.collateralBalance, 18)} ${symbol}. Reduce the amount.`);
      } else if (kind === "removeCollateral") {
        if (amount > state.collateral) amountErrors.push(`You have ${displayTokenAmount(state.collateral, 18)} ${symbol} deposited.`);
        else if (state.debt > 0n) {
          if (state.riskPaused || !state.borrowingPrice) amountErrors.push("Collateral withdrawal needs a verified price and an open market. You can still repay USDG.");
          else {
            const limit = (state.collateral - amount) * state.borrowingPrice / 10n ** 18n * BigInt(state.maxLtvBps) / 10000n / 10n ** 12n;
            if (state.debt > limit) amountErrors.push("This withdrawal would leave too little collateral. Withdraw less or repay part of your loan.");
          }
        }
      } else if (kind === "repay" || kind === "close") {
        const problem = repaymentProblem(state, kind, amount);
        if (problem) amountErrors.push(problem);
        else if (kind === "repay" && amount >= state.debt) {
          amountErrors.push("Choose “Repay in full” to repay the entire loan and return your collateral.");
        }
      }
    }
  }
  return { amountErrors, collateralError, preview, invalid: Boolean(collateralError || amountErrors.length) };
}
