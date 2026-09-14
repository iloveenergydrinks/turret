// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Deployment, Loan, OfferPage, Snapshot } from "../../p2p/client";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  browse: vi.fn(),
  read: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  reconcile: vi.fn(),
  create: vi.fn(),
  accept: vi.fn(),
  getLoan: vi.fn(),
  withdraw: vi.fn(),
  repay: vi.fn(),
  listeners: new Map<string, () => void>(),
  sessionListeners: new Set<() => void>(),
  session: { account: null as `0x${string}` | null, chainId: null as number | null, provider: null as any },
  walletConnect: vi.fn(),
}));
vi.mock("../../wallet/useWalletSession", async () => {
  const { useSyncExternalStore } = await import("react");
  return { WalletSessionProvider: ({ children }: { children: React.ReactNode }) => children, useWalletSession: () => {
    const session = useSyncExternalStore(
      (listener) => { mocks.sessionListeners.add(listener); return () => { mocks.sessionListeners.delete(listener); }; },
      () => mocks.session,
    );
    return { ...session, connecting: false, error: null, connect: mocks.walletConnect, disconnect: vi.fn() };
  } };
});
vi.mock("../../comps/AppLayout/AccountButton", async () => {
  const { useWalletSession } = await import("../../wallet/useWalletSession");
  return { AccountButton: () => { const session = useWalletSession(); return <button onClick={() => void session.connect()}>{session.account ? "Open wallet menu" : "Connect wallet"}</button>; } };
});
vi.mock("../../profiles/WalletAvatar", () => ({
  WalletAvatar: ({ address }: { address: string }) => <img alt="" data-wallet={address} />,
}));
vi.mock("../../p2p/client", () => ({
  loadP2PRegistry: mocks.load,
  P2PClient: class {
    config: Deployment;
    account: string | null = null;
    constructor(config: Deployment) {
      this.config = config;
    }
    connect = async (provider: unknown) => {
      this.account = await mocks.connect(provider);
      return this.account;
    };
    disconnect = () => {
      this.account = null;
      mocks.disconnect(this.config);
    };
    browse = (cursor?: bigint) => mocks.browse(this.config, cursor);
    snapshot = (cursor?: bigint) => mocks.read(this.config, cursor);
    reconcilePending = mocks.reconcile;
    createOffer = (provider: unknown, terms: unknown, stage: unknown) =>
      mocks.create(this.config, provider, terms, stage);
    accept = (provider: unknown, id: bigint, stage: unknown) => mocks.accept(this.config, provider, id, stage);
    getLoan = (id: bigint) => mocks.getLoan(this.config, id);
    withdraw = (provider: unknown, token: string, amount: bigint, recipient: string, stage: unknown) =>
      mocks.withdraw(this.config, provider, token, amount, recipient, stage);
    repay = (provider: unknown, id: bigint, stage: unknown) => mocks.repay(this.config, provider, id, stage);
  },
}));
vi.mock("../../p2p/requests", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../p2p/requests")>(),
  loadBorrowerRequests: vi.fn().mockResolvedValue({ requests: [], nextCursor: null }),
}));
import { ZERO_ADDRESS } from "./loanPresentation";
import { P2PLoansScreen } from "./P2PLoansScreen";
const LENDER = "0x1111111111111111111111111111111111111111";
const BORROWER = "0x2222222222222222222222222222222222222222";
const now = 1_783_680_000;
const slv: Deployment = {
  chainId: 31337,
  chainName: "Local E2E",
  rpcUrl: "/api/p2p-rpc",
  address: "0x3333333333333333333333333333333333333333",
  loanToken: "0x4444444444444444444444444444444444444444",
  collateralToken: "0x5555555555555555555555555555555555555555",
  loanSymbol: "USDG",
  collateralSymbol: "SLV",
  collateralName: "Silver",
  loanDecimals: 6,
  collateralDecimals: 18,
  runtimeHash: `0x${"a".repeat(64)}`,
  startBlock: "1",
  version: 2,
};
const cashcat: Deployment = {
  ...slv,
  address: "0x6666666666666666666666666666666666666666",
  collateralToken: "0x7777777777777777777777777777777777777777",
  collateralSymbol: "CASHCAT",
  collateralName: "Cashcat",
  collateralDecimals: 8,
};
const pilot: Deployment = { ...slv, address: "0x8888888888888888888888888888888888888888", version: 1, legacy: true };
const baseLoan: Loan = {
  id: 1n,
  lender: LENDER,
  borrower: ZERO_ADDRESS,
  isPublic: true,
  createdAt: now - 100,
  principal: 500_000_000n,
  collateral: 5n * 10n ** 18n,
  interest: 50_000_000n,
  durationDays: 45,
  expiresAt: now + 86_400,
  dueAt: 0,
  status: "open",
};
const baseOwn: Snapshot = {
  account: LENDER,
  now,
  blockNumber: 10n,
  approvedLender: true,
  paused: false,
  nativeBalance: 10n ** 18n,
  balances: { USDG: 10_000_000_000n, COLLATERAL: 50n * 10n ** 18n },
  credits: { USDG: 0n, COLLATERAL: 0n },
  offers: [],
  maxPrincipal: null,
  maxCommitted: null,
  committed: 0n,
  nextCursor: null,
};
let ownByMarket: Map<string, Snapshot>;
let publicByMarket: Map<string, OfferPage>;
const page = (offers: Loan[] = []): OfferPage => ({ offers, now, blockNumber: 10n, paused: false, nextCursor: null });
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/p2p");
  ownByMarket = new Map([slv, cashcat, pilot].map((config) => [config.address, { ...baseOwn }]));
  publicByMarket = new Map([[slv.address, page([baseLoan])], [cashcat.address, page([])]]);
  mocks.load.mockReset().mockResolvedValue({
    markets: [slv, cashcat, pilot],
    unavailableAssets: [{
      symbol: "PONS",
      name: "Pons",
      address: "0x9999999999999999999999999999999999999999",
      reason: "Token transfers are currently paused.",
    }],
  });
  mocks.browse.mockReset().mockImplementation(async (config: Deployment) =>
    publicByMarket.get(config.address) ?? page()
  );
  mocks.read.mockReset().mockImplementation(async (config: Deployment) => ownByMarket.get(config.address));
  mocks.connect.mockReset().mockResolvedValue(LENDER);
  mocks.session = { account: null, chainId: null, provider: null };
  mocks.walletConnect.mockReset().mockImplementation(async () => {
    mocks.session = { account: await mocks.connect(), chainId: slv.chainId, provider: (window as any).ethereum };
    mocks.sessionListeners.forEach(listener => listener());
  });
  mocks.reconcile.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockImplementation(
    async (config: Deployment, _wallet: unknown, terms: Record<string, unknown>) => {
      const loan = {
        ...baseLoan,
        ...terms,
        id: 99n,
        createdAt: now,
        isPublic: terms.borrower === ZERO_ADDRESS,
      } as Loan;
      ownByMarket.set(config.address, { ...ownByMarket.get(config.address)!, offers: [loan] });
    },
  );
  mocks.accept.mockReset().mockResolvedValue(undefined);
  mocks.getLoan.mockReset().mockImplementation(async (config: Deployment, id: bigint) =>
    ownByMarket.get(config.address)?.offers.find((loan) => loan.id === id)
      ?? publicByMarket.get(config.address)?.offers.find((loan) => loan.id === id) ?? baseLoan
  );
  mocks.withdraw.mockReset().mockResolvedValue(undefined);
  mocks.repay.mockReset().mockResolvedValue(undefined);
  mocks.listeners.clear();
  Object.defineProperty(window, "ethereum", {
    configurable: true,
    value: {
      request: vi.fn(),
      on: (event: string, listener: () => void) => mocks.listeners.set(event, listener),
      removeListener: (event: string) => mocks.listeners.delete(event),
    },
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(cleanup);
async function loaded() {
  await screen.findByRole("heading", { name: "Loan marketplace" });
  await waitFor(() => expect(document.querySelector("#p2p-panel")).toHaveAttribute("aria-busy", "false"));
}
async function connect() {
  fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
}

// Comparison fixtures deliberately mix USDG and collateral token decimals.
const rows = () => screen.queryAllByRole("article");
const rowNames = () => rows().map((row) => row.getAttribute("aria-label"));
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test("searches public offers by collateral symbol, asset name and lender without connecting", async () => {
  publicByMarket.set(cashcat.address, page([{ ...baseLoan, id: 7n, lender: BORROWER, collateral: 123_456_789n }]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  change("Search loans", " silver ");
  expect(rowNames()).toEqual(["SLV offer 1"]);
  change("Search loans", "cAsHcAt");
  expect(rowNames()).toEqual(["CASHCAT offer 7"]);
  change("Search loans", BORROWER.toUpperCase());
  expect(rowNames()).toEqual(["CASHCAT offer 7"]);
  change("Search loans", "unknown collateral");
  expect(rows()).toHaveLength(0);
  expect(screen.getByText("No loans match these filters")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(rows()).toHaveLength(2);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
});

test("combines exact USDG minimum, collateral and duration filters across token decimals", async () => {
  publicByMarket.set(slv.address, page([
    { ...baseLoan, id: 1n, principal: 1_000_000n, durationDays: 14 },
    { ...baseLoan, id: 2n, principal: 1_000_001n, durationDays: 30 },
  ]));
  publicByMarket.set(cashcat.address, page([
    { ...baseLoan, id: 3n, principal: 1_000_001n, collateral: 123_456_789n, durationDays: 14 },
  ]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  change("Minimum loan · USDG", "1.000001");
  expect(rows()).toHaveLength(2);
  change("Maximum days", "14");
  expect(rowNames()).toEqual(["CASHCAT offer 3"]);
  expect(rows()[0]).toHaveTextContent("1.23456789 CASHCAT");
  change("Collateral", "SLV");
  expect(rows()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(rows()).toHaveLength(3);
  expect(screen.getByLabelText("Minimum loan · USDG")).toHaveValue("");
  expect(screen.getByLabelText("Maximum days")).toHaveValue("");
  expect(screen.getByLabelText("Collateral")).toHaveValue("");
});

test("rejects invalid filter amounts without displaying misleading results", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  change("Minimum loan · USDG", "1.0000001");
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid minimum USDG amount.");
  expect(rows()).toHaveLength(0);
  change("Minimum loan · USDG", "");
  change("Maximum days", "1.5");
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a positive whole number for maximum days.");
  expect(rows()).toHaveLength(0);
});

test("paginates 12 offers at a time and resets page when search, filters or sort changes", async () => {
  publicByMarket.set(slv.address, page(Array.from({ length: 26 }, (_, index) => ({
    ...baseLoan, id: BigInt(index + 1), createdAt: now - index, principal: BigInt(index + 1) * 1_000_000n,
  }))));
  render(<P2PLoansScreen standalone />);
  await loaded();
  expect(rows()).toHaveLength(12);
  expect(rowNames()[0]).toBe("SLV offer 1");
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(rows()).toHaveLength(12);
  expect(rowNames()[0]).toBe("SLV offer 13");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(rows()).toHaveLength(2);
  expect(rowNames()).toEqual(["SLV offer 25", "SLV offer 26"]);
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  change("Search loans", "Silver");
  expect(rowNames()[0]).toBe("SLV offer 1");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  change("Minimum loan · USDG", "25");
  expect(rowNames()).toEqual(["SLV offer 25", "SLV offer 26"]);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(rowNames()[0]).toBe("SLV offer 1");
});

test.each(["#p2p-credits", "#p2p-wallet"])("opens Withdrawals directly for %s without hiding legacy credits", async (hash) => {
  window.history.replaceState(null, "", `/p2p${hash}`);
  ownByMarket.set(pilot.address, { ...baseOwn, credits: { USDG: 25_000_000n, COLLATERAL: 0n } });
  render(<P2PLoansScreen standalone />);
  await screen.findByRole("heading", { name: "Available to withdraw" });
  expect(screen.getByRole("tab", { name: "Withdrawals" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("heading", { name: "Loan marketplace" })).not.toBeInTheDocument();
  expect(mocks.connect).not.toHaveBeenCalled();
  await connect();
  expect(await screen.findByRole("button", { name: "Withdraw USDG · pilot" })).toBeEnabled();
  expect(screen.getByText("25 USDG")).toBeVisible();
  expect(screen.getByLabelText("Withdrawal recipient")).toHaveValue(LENDER);
  expect(mocks.withdraw).not.toHaveBeenCalled();
});

test("marketplace gives its space to offers while wallet balances and credits remain accessible in Withdrawals", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  expect(screen.queryByRole("heading", { name: "Wallet balances" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Available to withdraw" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Withdrawals" }));
  expect(screen.getByRole("button", { name: "Connect wallet to view withdrawals" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Available to withdraw" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(screen.getByRole("heading", { name: "Loan marketplace" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Wallet balances" })).not.toBeInTheDocument();
});

test("comparison rows retain precise collateral and repayment terms in the selected loan review", async () => {
  publicByMarket.set(cashcat.address, page([{
    ...baseLoan, id: 7n, principal: 1_234_567n, interest: 234_567n, collateral: 123_456_789n, durationDays: 31,
  }]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  const row = screen.getByRole("article", { name: "CASHCAT offer 7" });
  fireEvent.click(within(row).getByRole("button", { name: "Review loan" }));
  expect(window.location.search).toContain(`market=${cashcat.address}&offer=7`);
  const review = screen.getByRole("article", { name: "CASHCAT offer 7" });
  expect(review).toHaveTextContent("1.234567 USDG");
  expect(review).toHaveTextContent("1.23456789 CASHCAT");
  expect(review).toHaveTextContent("1.469134 USDG");
  expect(review).toHaveTextContent("31 days later");
  expect(screen.getByRole("button", { name: "Connect to accept" })).toBeEnabled();
  expect(mocks.accept).not.toHaveBeenCalled();
});

test("all eight sort choices order actual amounts, whole-loan interest rates, duration and expiry", async () => {
  publicByMarket.set(slv.address, page([
    { ...baseLoan, id: 1n, principal: 100_000_000n, interest: 10_000_000n, durationDays: 30,
      createdAt: now - 20, expiresAt: now + 3_000 },
    { ...baseLoan, id: 3n, principal: 50_000_000n, interest: 20_000_000n, durationDays: 7,
      createdAt: now - 10, expiresAt: now + 2_000 },
  ]));
  publicByMarket.set(cashcat.address, page([
    { ...baseLoan, id: 2n, principal: 200_000_000n, interest: 1_000_000n, durationDays: 60,
      createdAt: now - 30, expiresAt: now + 1_000 },
  ]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  const A = "SLV offer 1", B = "CASHCAT offer 2", C = "SLV offer 3";
  const expected: Record<string, string[]> = {
    newest: [C, A, B], "amount-desc": [B, A, C], amount: [C, A, B],
    rate: [B, A, C], "rate-desc": [C, A, B], duration: [C, A, B],
    "duration-desc": [B, A, C], expiry: [B, C, A],
  };
  expect(screen.getByLabelText("Sort by")).toHaveValue("newest");
  expect(within(screen.getByLabelText("Sort by")).getAllByRole("option")).toHaveLength(8);
  for (const [value, order] of Object.entries(expected)) {
    change("Sort by", value);
    expect(rowNames()).toEqual(order);
  }
});

test("returning from loan review preserves comparison filters and leaves the risk explanation collapsed", async () => {
  publicByMarket.set(cashcat.address, page([{ ...baseLoan, id: 7n, collateral: 123_456_789n }]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  change("Search loans", "cashcat");
  change("Minimum loan · USDG", "400");
  change("Sort by", "duration-desc");
  fireEvent.click(screen.getByRole("button", { name: "Review loan" }));
  expect(window.location.search).toContain(`market=${cashcat.address}&offer=7`);
  fireEvent.click(screen.getByRole("button", { name: "Back to marketplace" }));
  expect(screen.getByLabelText("Search loans")).toHaveValue("cashcat");
  expect(screen.getByLabelText("Minimum loan · USDG")).toHaveValue("400");
  expect(screen.getByLabelText("Sort by")).toHaveValue("duration-desc");
  expect(rowNames()).toEqual(["CASHCAT offer 7"]);
  const risk = screen.getByText("How P2P loans work and collateral risk").closest("details");
  expect(risk).not.toHaveAttribute("open");
  expect(within(risk!).getByText(/Miss the deadline/)).not.toBeVisible();
  fireEvent.click(screen.getByText("How P2P loans work and collateral risk"));
  expect(within(risk!).getByText(/Miss the deadline/)).toBeVisible();
});

test("wallet deep link opens balances even when Withdrawals is already active and balances were closed", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Withdrawals" }));
  const summary = await screen.findByText("Wallet balances and connection");
  const details = summary.closest("details")!;
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  fireEvent.click(summary);
  expect(details).not.toHaveAttribute("open");
  window.history.replaceState(null, "", "/p2p#p2p-wallet");
  fireEvent(window, new HashChangeEvent("hashchange"));
  await waitFor(() => expect(details).toHaveAttribute("open"));
  expect(screen.getByRole("heading", { name: "Wallet balances" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Withdrawals" })).toHaveAttribute("aria-selected", "true");
});
