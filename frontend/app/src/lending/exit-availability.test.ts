import { expect, test } from "vitest";
import { lenderExitAvailability } from "./exit-availability";

const snapshot = { shares: 100n * 10n ** 12n, totalShares: 100n * 10n ** 12n,
  totalAssets: 100_000_000n, cash: 100_000_000n, maxWithdraw: 100_000_000n };

test("full exit uses the contract limit and share value", () => {
  expect(lenderExitAvailability(snapshot)).toEqual({ value: 100_000_000n, available: 100_000_000n,
    unavailable: 0n, status: "available" });
});
test("partial liquidity does not turn accrued position value into spendable cash", () => {
  const exit = lenderExitAvailability({ ...snapshot, totalAssets: 110_000_000n, cash: 20_000_000n, maxWithdraw: 20_000_000n });
  expect(exit.status).toBe("partial");
  expect(exit.available).toBe(20_000_000n);
  expect(exit.unavailable).toBe(exit.value - 20_000_000n);
});
test("distinguishes cash shortage from a blocked contract limit", () => {
  expect(lenderExitAvailability({ ...snapshot, cash: 0n, maxWithdraw: 0n }).status).toBe("no-cash");
  expect(lenderExitAvailability({ ...snapshot, maxWithdraw: 0n }).status).toBe("checks");
});
test("never offers more than actual cash or the user's current position", () => {
  expect(lenderExitAvailability({ ...snapshot, cash: 5n }).available).toBe(5n);
  expect(lenderExitAvailability({ ...snapshot, maxWithdraw: 200_000_000n }).available).toBe(100_000_000n);
});
test("zero-value shares are distinct from a wallet without shares", () => {
  expect(lenderExitAvailability({ ...snapshot, shares: 0n }).status).toBe("empty");
  expect(lenderExitAvailability({ ...snapshot, totalAssets: 0n, cash: 0n, maxWithdraw: 0n }).status).toBe("loss");
  expect(lenderExitAvailability({ ...snapshot, shares: 1n }).status).toBe("dust");
});
test("rejects incomplete and invalid money data rather than displaying zero", () => {
  expect(() => lenderExitAvailability({ ...snapshot, cash: -1n })).toThrow();
  expect(() => lenderExitAvailability({ ...snapshot, maxWithdraw: undefined as unknown as bigint })).toThrow();
});
