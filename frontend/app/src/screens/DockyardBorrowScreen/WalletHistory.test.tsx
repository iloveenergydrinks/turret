// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { HISTORY_START_BLOCK, type HistoryPage, loadWalletHistory } from "@/src/dockyard-history";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WalletHistory } from "./WalletHistory";

vi.mock("@/src/env", () => ({ CHAIN_BLOCK_EXPLORER: { url: "https://robinhoodchain.blockscout.com" } }));
vi.mock("@/src/dockyard-config", async (original) => ({
  ...await original<object>(),
  DOCKYARD_VAULT_ADDRESS: "0x576c510e9A268B06448f67598B7BF1ed33388e20",
}));
vi.mock("wagmi", () => ({ usePublicClient: () => ({ chain: { id: 4663 } }) }));
vi.mock("@/src/dockyard-history", async (original) => ({ ...await original<object>(), loadWalletHistory: vi.fn() }));
const wallet = "0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086" as const;
const other = "0x0000000000000000000000000000000000000001" as const;
const hash = "0x013fe09be49e3b44575551dbe38c76696593a9658db03df124142a9099ded119" as const;
const page: HistoryPage = {
  fromBlock: HISTORY_START_BLOCK,
  toBlock: 52_502_863n,
  before: null,
  entries: [{
    id: hash,
    transactionHash: hash,
    blockNumber: 52_502_741n,
    logIndex: 4,
    timestamp: 1_788_344_812,
    market: "AAPL",
    title: "Repaid and withdrew",
    liquidated: false,
    effects: [{ label: "Debt repaid", amount: 502_500n, symbol: "USDG", decimals: 6 }, {
      label: "Collateral withdrawn",
      amount: 10_000_000_000_000_000n,
      symbol: "AAPL",
      decimals: 18,
    }],
  }],
};
function setup(props: Parameters<typeof WalletHistory>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { ...render(<WalletHistory {...props} />, { wrapper }), client };
}
beforeEach(() => {
  vi.mocked(loadWalletHistory).mockReset();
  vi.mocked(loadWalletHistory).mockResolvedValue(page);
});
afterEach(cleanup);

describe("Wallet history interface", () => {
  test("loads only after a valid lookup when no wallet is connected", async () => {
    setup();
    expect(loadWalletHistory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/look up a wallet address/), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(screen.getByRole("alert")).toHaveTextContent("valid Ethereum wallet address");
    expect(loadWalletHistory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/look up a wallet address/), { target: { value: wallet } });
    fireEvent.click(screen.getByRole("button", { name: "View history" }));
    expect(await screen.findByText("Repaid and withdrew")).toBeVisible();
    expect(loadWalletHistory).toHaveBeenCalledWith(expect.objectContaining({ wallet }));
  });

  test("shows exact amounts and a transaction explorer link for the connected wallet", async () => {
    setup({ address: wallet });
    expect(await screen.findByText("0.5025 USDG")).toBeVisible();
    expect(screen.getByText("0.01 AAPL")).toBeVisible();
    expect(screen.getByRole("link", { name: /View repaid and withdrew transaction/ })).toHaveAttribute(
      "href",
      `https://robinhoodchain.blockscout.com/tx/${hash}`,
    );
    expect(screen.queryByRole("button", { name: "View history" })).not.toBeInTheDocument();
    expect(screen.getByText(/All activity since vault deployment/)).toBeVisible();
  });

  test("distinguishes a scanned empty range from a wallet with no lifetime history", async () => {
    vi.mocked(loadWalletHistory).mockResolvedValueOnce({ ...page, entries: [], before: 52_402_863n });
    setup({ address: wallet });
    expect(await screen.findByText(/No activity in the blocks checked so far/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier activity" }));
    expect(await screen.findByText("Repaid and withdrew")).toBeVisible();
    expect(loadWalletHistory).toHaveBeenLastCalledWith(expect.objectContaining({ before: 52_402_863n }));
  });

  test("retains current records if loading older records fails, with a retry action", async () => {
    vi.mocked(loadWalletHistory).mockResolvedValueOnce({ ...page, before: 52_402_863n }).mockRejectedValue(
      new Error("RPC unavailable"),
    );
    setup({ address: wallet });
    await screen.findByText("Repaid and withdrew");
    fireEvent.click(screen.getByRole("button", { name: "Load earlier activity" }));
    expect(await screen.findByText(/Couldn’t load older activity/)).toBeVisible();
    expect(screen.getByText("Repaid and withdrew")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  test("refreshes after a confirmed transaction and does not leak rows across wallets", async () => {
    const view = setup({ address: wallet });
    await screen.findByText("Repaid and withdrew");
    view.rerender(<WalletHistory address={wallet} confirmedTransaction={hash} />);
    await waitFor(() => expect(loadWalletHistory).toHaveBeenCalledTimes(2));
    vi.mocked(loadWalletHistory).mockResolvedValue({ ...page, entries: [] });
    view.rerender(<WalletHistory address={other} />);
    expect(screen.queryByText("Repaid and withdrew")).not.toBeInTheDocument();
    expect(await screen.findByText(/No Turret loan or collateral activity/)).toBeVisible();
    expect(loadWalletHistory).toHaveBeenLastCalledWith(expect.objectContaining({ wallet: other }));
  });
});
