// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Address } from "viem";
import type { PoolPosition } from "../../portfolio/model";

const mocks = vi.hoisted(() => ({
  session: { account: null as Address | null, chainId: null as number | null },
  read: vi.fn(), discover: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("../../wallet/useWalletSession", () => ({
  useWalletSession: () => ({ ...mocks.session, provider: null, connecting: false, error: null,
    connect: mocks.connect, disconnect: mocks.disconnect }),
}));
vi.mock("../../portfolio/source", () => ({ createPortfolioSources: () => [
  { id: "pools", label: "Pooled markets", discover: mocks.discover },
  { id: "p2p", label: "P2P markets", discover: async () => [] },
] }));
vi.mock("../../profiles/WalletProfileEditor", () => ({ WalletProfileEditor: () => null }));
import { PortfolioScreen } from "./PortfolioScreen";

const account = "0x2222222222222222222222222222222222222222" as const;
const engine = "0x1111111111111111111111111111111111111111" as const;
const position: PoolPosition = { kind: "pool", account, now: 2_000_000_000, blockNumber: 1n,
  collateral: 14_000_000_000_000_000n, debt: 1_000_000n, shares: 30_000_000_000_000n,
  lendingAssets: 30_000_000n, maxWithdraw: 29_000_000n };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { account: null, chainId: null };
  mocks.read.mockReset().mockResolvedValue(position);
  mocks.discover.mockReset().mockResolvedValue([
    { id: "pool:aapl", kind: "pool", symbol: "AAPL", name: "Apple", legacy: false,
      engine, collateralDecimals: 18, read: mocks.read },
  ]);
});
afterEach(cleanup);

test("uses the shared connection control and does not read a disconnected wallet", () => {
  render(<PortfolioScreen />);
  expect(screen.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(mocks.discover).not.toHaveBeenCalled();
});

test("loads pooled loan and lender positions from the existing application session", async () => {
  mocks.session = { account, chainId: 4663 };
  render(<PortfolioScreen />);
  expect(await screen.findByRole("heading", { name: "AAPL Borrow" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "AAPL Earn" })).toBeVisible();
  expect(mocks.read).toHaveBeenCalledWith(account, undefined);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Manage lending" })).toHaveAttribute("href", `/earn?engine=${engine}`);
});

test("account and network changes follow the shared session without retaining old positions", async () => {
  mocks.session = { account, chainId: 4663 };
  const view = render(<PortfolioScreen />);
  await screen.findByRole("heading", { name: "AAPL Borrow" });
  mocks.session = { account, chainId: 1 };
  view.rerender(<PortfolioScreen />);
  expect(screen.getByRole("heading", { name: "Switch to Robinhood Chain" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "AAPL Borrow" })).not.toBeInTheDocument();
  const next = "0x3333333333333333333333333333333333333333" as const;
  mocks.read.mockResolvedValue({ ...position, account: next, collateral: 0n, debt: 0n });
  mocks.session = { account: next, chainId: 4663 };
  view.rerender(<PortfolioScreen />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(next, undefined));
  expect(await screen.findByRole("heading", { name: "AAPL Earn" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "AAPL Borrow" })).not.toBeInTheDocument();
  mocks.session = { account: null, chainId: null };
  view.rerender(<PortfolioScreen />);
  expect(screen.getByRole("heading", { name: "Connect your wallet" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "AAPL Earn" })).not.toBeInTheDocument();
});

test("does not present an RPC failure as an empty portfolio", async () => {
  mocks.session = { account, chainId: 4663 };
  mocks.read.mockRejectedValue(new Error("RPC unavailable"));
  render(<PortfolioScreen />);
  expect(await screen.findByText(/AAPL market unavailable/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry AAPL market" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "No pooled positions" })).not.toBeInTheDocument();
});
