// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { P2PActivity, type ActivityMarket } from "./P2PActivity";
import { readP2PActivity, type ActivityPage } from "../../p2p/activity";
vi.mock("../../p2p/activity", async () => ({ ...await vi.importActual("../../p2p/activity"), readP2PActivity: vi.fn() }));

const lender = `0x${"11".repeat(20)}` as Address, other = `0x${"22".repeat(20)}` as Address;
const market = `0x${"33".repeat(20)}` as Address, hash = `0x${"aa".repeat(32)}` as Hex;
const markets = [{ config: { chainId: 4663, address: market, runtimeHash: hash, rpcUrl: "/api/rpc", collateralSymbol: "SLV", version: 3 }, client: {} }] as ActivityMarket[];
const page = (complete = true): ActivityPage => ({
  entries: [{ key: "withdrawal", market, marketSymbol: "SLV", chainId: 4663, version: 3, transactionHash: hash, logIndex: 1,
    blockNumber: 20n, timestamp: 1_800_000_000, action: "Funds withdrawn", recipient: other, actor: lender,
    amount: 123_456_789n, symbol: "USDG", decimals: 6 }],
  anchor: 20n, anchorHash: hash, scannedFrom: 16n, scannedTo: 20n,
  next: complete ? null : { account: lender, market, chainId: 4663, anchor: 20n, anchorHash: hash, before: 15n },
});
beforeEach(() => vi.mocked(readP2PActivity).mockReset());
afterEach(cleanup);

it("shows exact transfer and recipient details with an explorer link", async () => {
  vi.mocked(readP2PActivity).mockResolvedValue(page());
  render(<P2PActivity account={lender} markets={markets} />);
  expect(await screen.findByRole("heading", { name: "Funds withdrawn" })).toBeVisible();
  expect(screen.getByText("123.456789 USDG")).toBeVisible();
  fireEvent.click(screen.getByText("Transaction details"));
  expect(screen.getByText(other)).toBeVisible();
  expect(screen.getByRole("link", { name: hash })).toHaveAttribute("href", `https://explorer.mainnet.chain.robinhood.com/tx/${hash}`);
  expect(screen.getByRole("button", { name: "Export activity CSV" })).toBeEnabled();
});

it("never labels an empty bounded scan as a wallet with no activity and continues its cursor", async () => {
  vi.mocked(readP2PActivity).mockResolvedValueOnce({ ...page(false), entries: [] }).mockResolvedValueOnce({ ...page(), scannedFrom: 1n, scannedTo: 15n });
  render(<P2PActivity account={lender} markets={markets} />);
  expect(await screen.findByText(/No activity in the blocks checked/)).toBeVisible();
  expect(screen.queryByText("Your loan activity will appear here")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  expect(await screen.findByRole("heading", { name: "Funds withdrawn" })).toBeVisible();
  expect(vi.mocked(readP2PActivity).mock.calls[1]![2]!.cursor?.before).toBe(15n);
});

it("immediately hides the old wallet and ignores its late response", async () => {
  let finish!: (page: ActivityPage) => void;
  vi.mocked(readP2PActivity).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ ...page(), entries: [] });
  const view = render(<P2PActivity account={lender} markets={markets} />);
  await waitFor(() => expect(readP2PActivity).toHaveBeenCalledTimes(1));
  view.rerender(<P2PActivity account={other} markets={markets} />);
  await screen.findByText("Your loan activity will appear here");
  finish(page());
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Funds withdrawn" })).not.toBeInTheDocument());
});

it("reconstructs history again after a remount and refreshes after confirmed transactions", async () => {
  vi.mocked(readP2PActivity).mockResolvedValue(page());
  const view = render(<P2PActivity account={lender} markets={markets} refreshKey={0} />);
  await screen.findByRole("heading", { name: "Funds withdrawn" });
  view.rerender(<P2PActivity account={lender} markets={markets} refreshKey={1} />);
  await waitFor(() => expect(readP2PActivity).toHaveBeenCalledTimes(2));
  view.unmount(); render(<P2PActivity account={lender} markets={markets} />);
  await waitFor(() => expect(readP2PActivity).toHaveBeenCalledTimes(3));
});
