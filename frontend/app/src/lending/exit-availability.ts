export type ExitSnapshot = {
  shares: bigint;
  totalAssets: bigint;
  totalShares: bigint;
  cash: bigint;
  maxWithdraw: bigint;
};

/** Uses this pool's ERC-4626 virtual-share accounting; never estimates an exit date. */
export function lenderExitAvailability(snapshot: ExitSnapshot) {
  if ([snapshot.shares, snapshot.totalAssets, snapshot.totalShares, snapshot.cash, snapshot.maxWithdraw]
    .some(value => typeof value !== "bigint" || value < 0n)) {
    throw new Error("Invalid withdrawal snapshot");
  }
  const value = snapshot.shares * (snapshot.totalAssets + 1n) / (snapshot.totalShares + 1_000_000n);
  const available = [value, snapshot.cash, snapshot.maxWithdraw].reduce((a, b) => a < b ? a : b);
  const unavailable = value - available;
  const status = snapshot.shares === 0n ? "empty"
    : value === 0n ? snapshot.totalAssets === 0n ? "loss" : "dust"
    : available === value ? "available"
    : available > 0n ? "partial"
    : snapshot.cash === 0n ? "no-cash" : "checks";
  return { value, available, unavailable, status } as const;
}
