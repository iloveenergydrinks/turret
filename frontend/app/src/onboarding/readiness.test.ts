import { describe, expect, test } from "vitest";
import { getWalletReadiness, tokenNeededForAction, type WalletReadinessInput } from "./readiness";

const funded: WalletReadinessInput = {
  connected: true,
  chainId: 4663,
  action: "depositBorrow",
  collateralBalance: 10n ** 18n,
  usdgBalance: 50_000_000n,
  nativeBalance: 1n,
};

describe("wallet funding readiness", () => {
  test("disconnection and a different chain cannot reuse positive cached balances", () => {
    for (const input of [{ ...funded, connected: false }, { ...funded, chainId: 1 }, { ...funded, chainId: undefined }]) {
      expect(getWalletReadiness(input)).toMatchObject({
        tokenStatus: "unknown", gasStatus: "unknown", tokenBalance: undefined, nativeBalance: undefined,
      });
    }
  });

  test("repayment needs USDG even if the collateral balance is large", () => {
    expect(getWalletReadiness({ ...funded, action: "repay", usdgBalance: 0n })).toMatchObject({
      token: "usdg", tokenStatus: "needed", tokenBalance: 0n,
    });
    expect(getWalletReadiness({ ...funded, action: "lend", collateralBalance: 0n })).toMatchObject({
      token: "usdg", tokenStatus: "available",
    });
  });

  test("entered amounts use exact token units and allow an exact balance", () => {
    expect(getWalletReadiness({ ...funded, requiredTokenAmount: 10n ** 18n }).tokenStatus).toBe("available");
    expect(getWalletReadiness({ ...funded, requiredTokenAmount: 10n ** 18n + 1n }).tokenStatus).toBe("needed");
    expect(getWalletReadiness({ ...funded, action: "close", requiredTokenAmount: 50_000_001n }).tokenStatus).toBe("needed");
  });

  test("withdrawals and borrowing against deposited collateral do not require wallet collateral", () => {
    for (const action of ["borrow", "removeCollateral", "withdraw", "redeem", "redeemWorthless"] as const) {
      expect(tokenNeededForAction(action)).toBeNull();
      expect(getWalletReadiness({ ...funded, action, collateralBalance: 0n, usdgBalance: 0n }).tokenStatus).toBe("not-needed");
    }
    expect(tokenNeededForAction("addCollateral")).toBe("collateral");
  });

  test("failed or missing reads are unknown instead of reporting an empty wallet", () => {
    expect(getWalletReadiness({ ...funded, balancesError: true, nativeBalanceError: true })).toMatchObject({
      tokenStatus: "unknown", gasStatus: "unknown", tokenBalance: undefined, nativeBalance: undefined,
    });
    expect(getWalletReadiness({ ...funded, collateralBalance: undefined, nativeBalance: undefined })).toMatchObject({
      tokenStatus: "unknown", gasStatus: "unknown",
    });
  });

  test("zero gas is missing and a positive gas balance only means available, not sufficient", () => {
    expect(getWalletReadiness({ ...funded, nativeBalance: 0n }).gasStatus).toBe("needed");
    expect(getWalletReadiness(funded).gasStatus).toBe("available");
    expect(getWalletReadiness({ ...funded, requiredTokenAmount: 0n }).requiredTokenAmount).toBeUndefined();
    expect(getWalletReadiness({ ...funded, collateralBalance: 0n, requiredTokenAmount: 0n }).tokenStatus).toBe("needed");
  });
});
