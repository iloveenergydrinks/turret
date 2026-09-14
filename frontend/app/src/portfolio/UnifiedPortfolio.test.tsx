// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Address } from "viem";
import { afterEach, expect, test, vi } from "vitest";
import type { Deployment, Loan } from "../p2p/client";
import type { NFTMarket, NFTPosition, P2PMarket, P2PPosition, PoolMarket, PoolPosition, PortfolioSource } from "./model";
import { UnifiedPortfolio } from "./UnifiedPortfolio";

const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const engine = "0x3333333333333333333333333333333333333333" as Address;
const contract = "0x4444444444444444444444444444444444444444" as Address;
const now = 2_000_000_000;
const config: Deployment = {
  chainId: 4663,
  chainName: "Robinhood Chain",
  rpcUrl: "/api/rpc",
  address: contract,
  loanToken: "0x5555555555555555555555555555555555555555",
  collateralToken: "0x6666666666666666666666666666666666666666",
  loanSymbol: "USDG",
  collateralSymbol: "SLV",
  loanDecimals: 6,
  collateralDecimals: 18,
  version: 2,
  collateralName: "Silver",
  runtimeHash: `0x${"0".repeat(64)}`,
  startBlock: "1",
};
function poolData(overrides: Partial<PoolPosition> = {}): PoolPosition {
  return {
    kind: "pool",
    account,
    now,
    blockNumber: 20n,
    shares: 1n,
    lendingAssets: 25_000_000n,
    maxWithdraw: 20_000_000n,
    collateral: 2n * 10n ** 18n,
    debt: 3_000_000n,
    ...overrides,
  };
}
function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 1n,
    lender: account,
    borrower: other,
    principal: 10_000_000n,
    collateral: 3n * 10n ** 18n,
    interest: 1_000_000n,
    durationDays: 30,
    expiresAt: now + 3600,
    dueAt: now + 86400,
    createdAt: now - 3600,
    isPublic: true,
    status: "active",
    ...overrides,
  };
}
function p2pData(overrides: Partial<P2PPosition> = {}): P2PPosition {
  return {
    kind: "p2p",
    account,
    now,
    blockNumber: 20n,
    offers: [loan()],
    credits: { USDG: 0n, COLLATERAL: 0n },
    nextCursor: null,
    ...overrides,
  };
}
function pool(read = vi.fn<PoolMarket["read"]>().mockResolvedValue(poolData()), id = "pool:aapl"): PoolMarket {
  return { id, kind: "pool", symbol: "AAPL", name: "Apple", legacy: false, engine, collateralDecimals: 18, read };
}
function p2p(read = vi.fn<P2PMarket["read"]>().mockResolvedValue(p2pData())): P2PMarket {
  return { id: "p2p:slv", kind: "p2p", symbol: "SLV", name: "Silver", legacy: false, deployment: config, read };
}
function sources(pools: PoolMarket[] = [pool()], peers: P2PMarket[] = [p2p()]): PortfolioSource[] {
  return [
    { id: "pools", label: "Pooled markets", discover: vi.fn().mockResolvedValue(pools) },
    { id: "p2p", label: "P2P markets", discover: vi.fn().mockResolvedValue(peers) },
  ];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const connect = vi.fn();
const props = (source: readonly PortfolioSource[]) => ({ account, chainId: 4663, sources: source, onConnect: connect });
test("NFT debt, credits, collateral identity and additional pages are included in the unified portfolio", async () => {
  const nft = (id: bigint, borrower: Address, lender: Address, status: number, credit = 0n) => ({
    id, lender, terms: { borrower, collection: config.collateralToken, tokenId: id - 1n, principal: 10_000_000n, interest: 2_000_000n, duration: 86400n, expiresAt: BigInt(now + 100) },
    vault: engine, dueAt: BigInt(now + 1000), status, usdgCredit: credit, nftBeneficiary: status === 3 ? borrower : "0x0000000000000000000000000000000000000000" as Address,
  });
  const read = vi.fn<NFTMarket["read"]>().mockImplementation(async (wallet, cursor): Promise<NFTPosition> => ({ kind: "nft", account: wallet, now, blockNumber: 20n,
    offers: cursor ? [nft(3n, account, other, 2)] : [nft(1n, account, other, 2), nft(2n, other, account, 3, 12_000_000n)], nextCursor: cursor ? null : 2n }));
  const market: NFTMarket = { id: "nft:cats", kind: "nft", symbol: "NFT", name: "NFT loans", legacy: false, read,
    deployment: { version: 1, chainId: 4663, address: contract, loanToken: config.loanToken, loanDecimals: 6, runtimeHash: config.runtimeHash, startBlock: "1", rpcUrl: "/api/rpc",
      collections: [{ address: config.collateralToken, name: "Cash Cats", slug: "cash-cats", image: "", enabled: true }] } };
  const source: PortfolioSource[] = [...sources([], []), { id: "nft", label: "NFT P2P loans", discover: async () => [market] }];
  render(<UnifiedPortfolio {...props(source)} />);
  const section = await screen.findByRole("region", { name: "NFT loans & offers" });
  await within(section).findByRole("link", { name: "Manage NFT loan #1" });
  expect(within(section).getByText("Cash Cats #0")).toBeInTheDocument();
  expect(within(section).getByRole("link", { name: "Manage NFT loan #1" })).toHaveAttribute("href", "/borrow/nfts?offer=1");
  const balances = screen.getByRole("region", { name: "Loaded portfolio balances" });
  expect(within(balances).getAllByText("12 USDG")).toHaveLength(2);
  fireEvent.click(within(section).getByRole("button", { name: "Load more NFT loans" }));
  await within(section).findByText("Cash Cats #2");
  expect(within(balances).getByText("24 USDG")).toBeInTheDocument();
  expect(within(balances).getByText("12 USDG")).toBeInTheDocument();
  expect(read).toHaveBeenLastCalledWith(account, 2n);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("disconnected and wrong-chain portfolios never read another wallet's positions", () => {
  const source = sources();
  const view = render(<UnifiedPortfolio {...props(source)} account={null} chainId={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  expect(connect).toHaveBeenCalledOnce();
  expect(source[0]!.discover).not.toHaveBeenCalled();
  view.rerender(<UnifiedPortfolio {...props(source)} chainId={1} />);
  expect(screen.getByRole("heading", { name: "Switch to Robinhood Chain" })).toBeVisible();
  expect(source[0]!.discover).not.toHaveBeenCalled();
});

test("a ready P2P position appears while eight pooled reads are unresolved", async () => {
  const slow = deferred<PoolPosition>();
  const source = sources(Array.from({ length: 12 }, (_, index) => pool(vi.fn().mockReturnValue(slow.promise), `pool:${index}`)));
  render(<UnifiedPortfolio {...props(source)} />);
  expect(await screen.findByRole("heading", { name: /SLV P2P lending/ })).toBeVisible();
  expect(screen.getByText(/Still loading 12 markets/)).toBeVisible();
  const poolMarkets = await source[0]!.discover();
  expect(poolMarkets.filter(market => vi.mocked(market.read).mock.calls.length > 0)).toHaveLength(8);
  const balances = screen.getByRole("region", { name: "Loaded portfolio balances" });
  expect(within(balances).getByText("Pool lending value").nextElementSibling).toHaveTextContent("—");
  expect(screen.getByText(/Partial totals from loaded positions/)).toBeVisible();
  expect(screen.queryByText("No pooled positions")).not.toBeInTheDocument();
});

test("pooled Borrow and Earn positions use their exact active and legacy management links", async () => {
  const legacy = { ...pool(), legacy: true };
  render(<UnifiedPortfolio {...props(sources([legacy], []))} />);
  expect(await screen.findByRole("link", { name: "Manage lending" })).toHaveAttribute("href", `/earn?engine=${engine}`);
  expect(screen.getByRole("link", { name: "Manage loan" })).toHaveAttribute(
    "href",
    `/borrow?engine=${engine}`,
  );
  expect(screen.getByText("Legacy pool")).toBeVisible();
  expect(screen.getByText("Legacy market")).toBeVisible();
  expect(screen.getByText("20 USDG")).toBeVisible();
});

test("a failed market does not hide a healthy position and only that market is retried", async () => {
  const healthy = pool();
  const failedRead = vi.fn<PoolMarket["read"]>().mockRejectedValueOnce(new Error("RPC unavailable"))
    .mockResolvedValue(poolData({ debt: 7_000_000n, shares: 0n }));
  const failed = { ...pool(failedRead, "pool:msft"), symbol: "MSFT" };
  render(<UnifiedPortfolio {...props(sources([healthy, failed], []))} />);
  expect(await screen.findByRole("heading", { name: "AAPL Earn" })).toBeVisible();
  expect(await screen.findByText(/MSFT market unavailable/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry MSFT market" }));
  expect(await screen.findByRole("heading", { name: "MSFT Borrow" })).toBeVisible();
  expect(healthy.read).toHaveBeenCalledOnce();
  expect(failedRead).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/MSFT market unavailable/)).not.toBeInTheDocument();
});

test("source discovery failure is isolated from the other product and retries independently", async () => {
  const source = sources();
  source[1]!.discover = vi.fn().mockRejectedValueOnce(new Error("Registry unavailable")).mockResolvedValue([p2p()]);
  render(<UnifiedPortfolio {...props(source)} />);
  expect(await screen.findByRole("heading", { name: "AAPL Earn" })).toBeVisible();
  expect(await screen.findByRole("heading", { name: "P2P positions are unavailable" })).toBeVisible();
  expect(screen.queryByText("Loading P2P positions…")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry p2p markets" }));
  expect(await screen.findByRole("heading", { name: /SLV P2P lending/ })).toBeVisible();
  expect(source[0]!.discover).toHaveBeenCalledOnce();
});

test("wallet switch immediately removes old positions and ignores delayed results", async () => {
  const old = deferred<PoolPosition>();
  const read = vi.fn<PoolMarket["read"]>().mockImplementation((owner) =>
    owner === account
      ? old.promise
      : Promise.resolve(poolData({ account: other, lendingAssets: 91_000_000n }))
  );
  const source = sources([pool(read)], []);
  const view = render(<UnifiedPortfolio {...props(source)} />);
  await waitFor(() => expect(read).toHaveBeenCalledWith(account, undefined));
  view.rerender(<UnifiedPortfolio {...props(source)} account={other} />);
  await screen.findByRole("heading", { name: "AAPL Earn" });
  await act(async () => old.resolve(poolData({ lendingAssets: 999_000_000n })));
  expect(screen.queryByText("999 USDG")).not.toBeInTheDocument();
  expect(screen.getAllByText("91 USDG")).toHaveLength(2);
  view.rerender(<UnifiedPortfolio {...props(source)} account={null} chainId={null} />);
  expect(screen.queryByText("91 USDG")).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Your lending, all in one place" })).toBeVisible();
});

test("disconnect hides already loaded positions before outstanding reads complete", async () => {
  const slow = deferred<PoolPosition>();
  const source = sources([pool(vi.fn().mockReturnValue(slow.promise))]);
  const view = render(<UnifiedPortfolio {...props(source)} />);
  await screen.findByRole("heading", { name: /SLV P2P lending/ });
  view.rerender(<UnifiedPortfolio {...props(source)} account={null} />);
  await act(async () => slow.resolve(poolData()));
  expect(screen.queryByRole("link", { name: "Manage P2P loan" })).not.toBeInTheDocument();
  expect(screen.queryByText("25 USDG")).not.toBeInTheDocument();
});

test("borrowed, lent, open and history P2P records retain precise market and loan links", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValue(p2pData({
    offers: [
      loan({ id: 1n }),
      loan({ id: 2n, borrower: account, lender: other }),
      loan({ id: 3n, status: "open", dueAt: 0 }),
      loan({ id: 4n, status: "repaid" }),
      loan({ id: 5n, status: "claimed" }),
      loan({ id: 6n, status: "cancelled" }),
    ],
  }));
  render(<UnifiedPortfolio {...props(sources([], [{ ...p2p(read), legacy: true }]))} />);
  await screen.findByRole("heading", { name: /SLV offer #3/ });
  expect(screen.getByRole("heading", { name: /SLV P2P borrowing #2/ })).toBeVisible();
  for (const id of [1, 2, 3]) {
    expect(document.querySelector(`a[href="/borrow/p2p?market=${contract}&offer=${id}"]`)).not.toBeNull();
  }
  fireEvent.click(screen.getByRole("button", { name: "Borrowing" }));
  expect(screen.getByRole("heading", { name: /SLV P2P borrowing #2/ })).toBeVisible();
  expect(screen.queryByRole("heading", { name: /SLV P2P lending #1/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Lending" }));
  expect(screen.getByRole("heading", { name: /SLV P2P lending #1/ })).toBeVisible();
  expect(screen.getByText(/Open offers earn no interest/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "P2P history" }));
  for (const id of [4, 5, 6]) {
    expect(document.querySelector(`a[href="/borrow/p2p?market=${contract}&offer=${id}"]`)).not.toBeNull();
  }
  expect(screen.getAllByText(/Previous contract/).length).toBeGreaterThan(0);
});

test("P2P credits are shown per market and lead to actual withdrawal controls", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValue(
    p2pData({ offers: [], credits: { USDG: 12_000_000n, COLLATERAL: 5n * 10n ** 18n } }),
  );
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  expect(await screen.findByRole("heading", { name: "Ready to withdraw" })).toBeVisible();
  expect(screen.getByText("5 SLV")).toBeVisible();
  expect(screen.getByRole("link", { name: "Withdraw funds" })).toHaveAttribute(
    "href",
    `/borrow/p2p?market=${contract}#p2p-credits`,
  );
});

test("defaulted borrower loan explains entire collateral settlement and excludes further USDG debt", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValue(
    p2pData({ offers: [loan({ lender: other, borrower: account, dueAt: now - 86401 })] }),
  );
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  expect(await screen.findByText(/All collateral is claimable by the lender; no further USDG repayment is due/))
    .toBeVisible();
  const total = screen.getByRole("region", { name: "Loaded portfolio balances" });
  expect(within(total).getByText("Borrowed, including interest").nextElementSibling).toHaveTextContent("0 USDG");
  expect(screen.getByRole("link", { name: "Manage P2P loan" })).toHaveAttribute(
    "href",
    `/borrow/p2p?market=${contract}&offer=1`,
  );
});

test("older loans append without duplicates and never remove the current page", async () => {
  const older = deferred<P2PPosition>();
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValueOnce(p2pData({ nextCursor: 40n })).mockReturnValueOnce(
    older.promise,
  );
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  await screen.findByRole("heading", { name: /SLV P2P lending #1/ });
  fireEvent.click(screen.getByRole("button", { name: "Load older SLV loans" }));
  expect(screen.getByRole("heading", { name: /SLV P2P lending #1/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "Loading older loans…" })).toBeDisabled();
  await act(async () => older.resolve(p2pData({ offers: [loan(), loan({ id: 2n, status: "expired" })] })));
  expect(screen.getAllByRole("heading", { name: /SLV P2P lending #1/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "P2P history" }));
  expect(screen.getByRole("link", { name: "View loan" })).toHaveAttribute("href", `/borrow/p2p?market=${contract}&offer=2`);
  expect(read).toHaveBeenLastCalledWith(account, 40n);
});

test("failed refresh retains explicitly stale rows instead of converting them to zero", async () => {
  const read = vi.fn<PoolMarket["read"]>().mockResolvedValueOnce(poolData()).mockRejectedValueOnce(
    new Error("RPC unavailable"),
  );
  render(<UnifiedPortfolio {...props(sources([pool(read)], []))} />);
  await screen.findByRole("heading", { name: "AAPL Earn" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh positions" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Refresh positions" }));
  await screen.findByText(/AAPL market unavailable/);
  expect(screen.getByRole("heading", { name: "AAPL Earn" })).toBeVisible();
  expect(screen.getAllByText(/Previous read · Could not refresh/)).toHaveLength(2);
  expect(screen.getByText("25 USDG")).toBeVisible();
  expect(screen.queryByText("No pooled positions")).not.toBeInTheDocument();
});

test("only completed empty reads produce the no-positions state", async () => {
  const empty = vi.fn<PoolMarket["read"]>().mockResolvedValue(
    poolData({ shares: 0n, collateral: 0n, debt: 0n, lendingAssets: 0n, maxWithdraw: 0n }),
  );
  render(
    <UnifiedPortfolio {...props(sources([pool(empty)], [p2p(vi.fn().mockResolvedValue(p2pData({ offers: [] })))]))} />,
  );
  expect(await screen.findByRole("heading", { name: "No pooled positions" })).toBeVisible();
  expect(await screen.findByRole("heading", { name: "No P2P loans or offers here" })).toBeVisible();
  expect(screen.queryByText(/Partial totals/)).not.toBeInTheDocument();
});

test("a result carrying a different account is rejected without exposing its balance", async () => {
  const read = vi.fn<PoolMarket["read"]>().mockResolvedValue(poolData({ account: other, lendingAssets: 987_000_000n }));
  render(<UnifiedPortfolio {...props(sources([pool(read)], []))} />);
  expect(await screen.findByText(/The wallet changed while loading/)).toBeVisible();
  expect(screen.queryByText("987 USDG")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "AAPL Earn" })).not.toBeInTheDocument();
});

test("an invalid older-loan cursor preserves current records and offers a retry", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValueOnce(p2pData({ nextCursor: 40n }))
    .mockResolvedValueOnce(p2pData({ offers: [], nextCursor: 40n }));
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  await screen.findByRole("heading", { name: /SLV P2P lending #1/ });
  fireEvent.click(screen.getByRole("button", { name: "Load older SLV loans" }));
  expect(await screen.findByText("Older loans could not be loaded. Try again.")).toBeVisible();
  expect(screen.getByRole("heading", { name: /SLV P2P lending #1/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "Load older SLV loans" })).toBeEnabled();
});

test("an incomplete active index retains known obligations and warns that totals are partial", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValueOnce(p2pData({ activeLoansComplete: true }))
    .mockResolvedValueOnce(p2pData({ offers: [], activeLoansComplete: false }));
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  await screen.findByRole("heading", { name: /SLV P2P lending #1/ });
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh positions" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Refresh positions" }));
  await screen.findByRole("link", { name: "Open a loan by its market and ID" });
  expect(screen.getByRole("heading", { name: /SLV P2P lending #1/ })).toBeVisible();
  expect(screen.getByText(/Partial totals from loaded positions/)).toBeVisible();
});

test("fresh settlement replaces a retained active loan even while the index is unavailable", async () => {
  const read = vi.fn<P2PMarket["read"]>().mockResolvedValueOnce(p2pData({ activeLoansComplete: true }))
    .mockResolvedValueOnce(p2pData({ offers: [loan({ status: "repaid" })], activeLoansComplete: false }));
  render(<UnifiedPortfolio {...props(sources([], [p2p(read)]))} />);
  await screen.findByRole("heading", { name: /SLV P2P lending #1/ });
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh positions" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Refresh positions" }));
  await screen.findByRole("link", { name: "Open a loan by its market and ID" });
  expect(screen.queryByRole("heading", { name: /SLV P2P lending #1/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "P2P history" }));
  expect(screen.getByRole("link", { name: "View loan" })).toHaveAttribute("href", `/borrow/p2p?market=${contract}&offer=1`);
});
