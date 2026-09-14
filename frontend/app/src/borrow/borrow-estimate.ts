/** UI estimates use the contracts' integer order and units: collateral/price 18, USDG 6. */
export type BorrowInputs = {
 collateral: bigint; debt: bigint; borrowingPrice: bigint | null; price?: bigint | null;
 maxLtvBps: number; cash: bigint; principal: bigint; debtLimit: bigint; minimumDebt: bigint;
 riskPaused: boolean;
};
const positive = (x: bigint) => x > 0n ? x : 0n;
export function borrowCapacity(s: BorrowInputs, extra: bigint): bigint | null {
 if (s.borrowingPrice === null || s.borrowingPrice <= 0n || s.riskPaused || extra < 0n) return null;
 const limit = (s.collateral + extra) * s.borrowingPrice / 10n ** 18n * BigInt(s.maxLtvBps) / 10000n / 10n ** 12n;
 const capacity = [positive(limit - s.debt), s.cash, positive(s.debtLimit - s.principal)].reduce((a,b) => a < b ? a : b);
 return s.debt + capacity < s.minimumDebt ? 0n : capacity;
}
export function startingLtv(s: BorrowInputs, extra: bigint, borrowed: bigint): bigint | null {
 const value = (s.collateral + extra) * (s.price ?? 0n);
 return value > 0n ? ((s.debt + borrowed) * 10n ** 30n * 10000n + value - 1n) / value : null;
}
export function estimatedInterest(amount: bigint, aprBps: number, days: number): bigint {
 return (amount * BigInt(aprBps) * BigInt(days) + 3649999n) / 3650000n;
}
export function repaymentShortfall(balance: bigint, debt: bigint, requested: bigint, close: boolean): bigint {
 const needed = close ? (requested > debt ? requested : debt) : (requested < debt ? requested : debt);
 return positive(needed - balance);
}
export function freshSnapshot(timestamp: bigint, now: number, expiry?: bigint | null): boolean {
 const seconds = BigInt(Math.floor(now / 1000));
 return timestamp <= seconds && seconds - timestamp < 30n && (expiry == null || expiry > seconds);
}

export function closeFundingBudget(debt:bigint,aprBps:number):bigint {
 return debt>0n?debt+(debt*BigInt(aprBps)*300n+315359999999n)/315360000000n+2n:0n;
}
