// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { positiveAmount } from "@/src/dockyard-amount";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DockyardBorrowScreen } from "./DockyardBorrowScreen";
import { PositionHealth } from "./PositionHealth";
const mocks = vi.hoisted(() => ({
  wallet: "0x1111111111111111111111111111111111111111",
  chainId: 4663,
  oracleError: false,
  positionError: false,
  paused: false,
  allowance: 10n ** 30n,
  write: vi.fn(),
  reset: vi.fn(),
  refetch: vi.fn(),
  status: undefined as "success" | "reverted" | undefined,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: mocks.wallet, isConnected: true, chainId: mocks.chainId }),
  useReadContract: ({ functionName }: { functionName: string }) => {
    const values: Record<string, unknown> = {
      positions: [10n ** 18n, 45_000000n],
      price: 100n * 10n ** 18n,
      markets: [0, 0, 0, 4500, 5000, 0, 0, 0, 0, true],
      paused: mocks.paused,
      availableLiquidity: 1000_000000n,
      originationFeeBps: 50,
      balanceOf: 100n * 10n ** 18n,
      allowance: mocks.allowance,
    };
    const isError = (functionName === "price" && mocks.oracleError)
      || (functionName === "positions" && mocks.positionError);
    return {
      data: isError ? undefined : values[functionName],
      isError,
      isLoading: false,
      dataUpdatedAt: Date.now(),
      refetch: mocks.refetch,
    };
  },
  useWriteContract: () => ({ writeContractAsync: mocks.write, reset: mocks.reset, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({
    isSuccess: Boolean(mocks.status),
    isLoading: false,
    data: mocks.status ? { status: mocks.status } : undefined,
  }),
}));
vi.mock(
  "@/src/dockyard-config",
  () => ({
    DOCKYARD_VAULT_ADDRESS: "0x576c510e9A268B06448f67598B7BF1ed33388e20",
    DOCKYARD_USDG_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  }),
);
vi.mock("./BorrowerAlerts", () => ({ BorrowerAlerts: () => null }));
vi.mock("./WalletHistory", () => ({ WalletHistory: () => null }));
const market = {
  symbol: "AAPL",
  name: "Apple",
  address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  maxLtvBps: 5214,
  liquidationLtvBps: 5714,
} as const;
beforeEach(() => {
  mocks.oracleError = false;
  mocks.positionError = false;
  mocks.paused = false;
  mocks.chainId = 4663;
  mocks.allowance = 10n ** 30n;
  mocks.status = undefined;
  mocks.write.mockReset().mockResolvedValue("0x123");
  mocks.refetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("strict amounts reject negative, exponential and overprecision input", () => {
  for (const value of ["-1", "1e3", "0.0000001", "NaN", "1,000", "1.", ""]) expect(positiveAmount(value, 6)).toBe(0n);
  expect(positiveAmount("1.000001", 6)).toBe(1000001n);
});
test("health panel displays live LTV, price and remaining decline", () => {
  render(
    <PositionHealth
      collateral={10n ** 18n}
      debt={45_000000n}
      price={100n * 10n ** 18n}
      liquidationLtvBps={5000}
      updatedAt={Date.now()}
      unavailable={false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Approaching liquidation");
  expect(screen.getByText("45.00%")).toBeVisible();
  expect(screen.getByText("$90")).toBeVisible();
  expect(screen.getByText("10.00%")).toBeVisible();
});
test("stale or failed reads do not display a healthy state", () => {
  render(
    <PositionHealth
      collateral={10n ** 18n}
      debt={40_000000n}
      price={100n * 10n ** 18n}
      liquidationLtvBps={5000}
      updatedAt={Date.now() - 46000}
      unavailable={false}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Risk data unavailable");
});
test("unavailable position is not represented as no debt or empty position", () => {
  mocks.positionError = true;
  render(<DockyardBorrowScreen market={market} />);
  expect(screen.getByText(/Position unavailable/)).toBeVisible();
  expect(screen.queryByText(/No AAPL position/)).not.toBeInTheDocument();
});
test("partial repayment calls repay with the exact six-decimal amount and connected borrower", async () => {
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("USDG to repay"), { target: { value: "1.123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Repay USDG" }));
  await waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 4663, functionName: "repay", args: [market.address, mocks.wallet, 1123456n] }),
    )
  );
});
test("top-up calls depositCollateral without borrowing more", async () => {
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("Add AAPL collateral"), { target: { value: "0.2" } });
  fireEvent.click(screen.getByRole("button", { name: "Add collateral" }));
  await waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "depositCollateral", args: [market.address, 2n * 10n ** 17n] }),
    )
  );
});
test("approvals grant only the requested protection amount", async () => {
  mocks.allowance = 0n;
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("USDG to repay"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve partial repayment" }));
  await waitFor(() =>
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "approve",
        args: ["0x576c510e9A268B06448f67598B7BF1ed33388e20", 2000000n],
      }),
    )
  );
});
test("paused borrowing and oracle outage block top-ups but preserve partial repayment", () => {
  mocks.paused = true;
  mocks.oracleError = true;
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("Add AAPL collateral"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("USDG to repay"), { target: { value: "1" } });
  expect(screen.getByRole("button", { name: "Add collateral" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Repay USDG" })).toBeEnabled();
});
test("wrong chain and repayment greater than debt are blocked", () => {
  mocks.chainId = 1;
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("USDG to repay"), { target: { value: "1" } });
  expect(screen.getByRole("button", { name: "Repay USDG" })).toBeDisabled();
  expect(screen.getByText(/Switch your wallet/)).toBeVisible();
});
test("repayment over debt is disabled", () => {
  render(<DockyardBorrowScreen market={market} />);
  fireEvent.change(screen.getByLabelText("USDG to repay"), { target: { value: "46" } });
  expect(screen.getByRole("button", { name: "Repay USDG" })).toBeDisabled();
});
test("reverted receipt is reported as failure rather than successful confirmation", () => {
  mocks.status = "reverted";
  render(<DockyardBorrowScreen market={market} />);
  expect(screen.getByText(/Transaction reverted/)).toBeVisible();
  expect(screen.queryByText("Transaction confirmed on Robinhood Chain.")).not.toBeInTheDocument();
});
