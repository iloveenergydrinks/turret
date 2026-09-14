export const ROBINHOOD_CHAIN_ID = 4663;

export type ReadinessAction =
  | "depositBorrow"
  | "borrow"
  | "addCollateral"
  | "removeCollateral"
  | "repay"
  | "close"
  | "lend"
  | "withdraw"
  | "redeem"
  | "redeemWorthless";

export type ReadinessStatus = "available" | "needed" | "unknown" | "not-needed";
export type ReadinessToken = "collateral" | "usdg" | null;

export function tokenNeededForAction(action: ReadinessAction): ReadinessToken {
  if (action === "depositBorrow" || action === "addCollateral") return "collateral";
  if (action === "lend" || action === "repay" || action === "close") return "usdg";
  return null;
}

export type WalletReadinessInput = {
  connected: boolean;
  chainId?: number;
  action: ReadinessAction;
  collateralBalance?: bigint;
  usdgBalance?: bigint;
  nativeBalance?: bigint;
  requiredTokenAmount?: bigint;
  balancesError?: boolean;
  nativeBalanceError?: boolean;
};

/** Funding checks are informational. They never authorize a loan or assert gas sufficiency. */
export function getWalletReadiness(input: WalletReadinessInput) {
  const correctNetwork = input.connected && input.chainId === ROBINHOOD_CHAIN_ID;
  const token = tokenNeededForAction(input.action);
  const balance = token === "collateral" ? input.collateralBalance : input.usdgBalance;
  const required = input.requiredTokenAmount !== undefined && input.requiredTokenAmount > 0n
    ? input.requiredTokenAmount
    : undefined;
  let tokenStatus: ReadinessStatus = "unknown";
  if (token === null) tokenStatus = "not-needed";
  else if (correctNetwork && !input.balancesError && balance !== undefined) {
    tokenStatus = balance > 0n && (required === undefined || balance >= required) ? "available" : "needed";
  }
  const gasStatus: ReadinessStatus = !correctNetwork || input.nativeBalanceError || input.nativeBalance === undefined
    ? "unknown"
    : input.nativeBalance > 0n ? "available" : "needed";
  return {
    walletStatus: input.connected ? "available" as const : "needed" as const,
    networkStatus: correctNetwork ? "available" as const : input.connected ? "needed" as const : "unknown" as const,
    token,
    tokenStatus,
    gasStatus,
    // Never expose disconnected, wrong-network or failed reads as current wallet balances.
    tokenBalance: correctNetwork && !input.balancesError && token !== null ? balance : undefined,
    nativeBalance: correctNetwork && !input.nativeBalanceError ? input.nativeBalance : undefined,
    requiredTokenAmount: required,
  };
}
