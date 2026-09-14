// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
vi.mock("../../borrow/TurretModel", () => ({ TurretModel: () => null }));
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  incoming: vi.fn(),
  withdraw: vi.fn(),
  withdrawCredit: vi.fn(),
  repay: vi.fn(),
  repayWithCredits: vi.fn(),
  listeners: new Map<string, () => void>(),
  sessionListeners: new Set<() => void>(),
  session: { account: null as `0x${string}` | null, chainId: null as number | null, provider: null as any },
  walletConnect: vi.fn(),
  walletDisconnect: vi.fn(),
}));
vi.mock("../../wallet/useWalletSession", async () => {
  const { useSyncExternalStore } = await import("react");
  return { WalletSessionProvider: ({ children }: { children: React.ReactNode }) => children, useWalletSession: () => {
    const session = useSyncExternalStore(
      (listener) => { mocks.sessionListeners.add(listener); return () => { mocks.sessionListeners.delete(listener); }; },
      () => mocks.session,
    );
    return { ...session, connecting: false, error: null, connect: mocks.walletConnect, disconnect: mocks.walletDisconnect };
  } };
});
// Wallet dialog behavior is covered by AccountButton.test.tsx; keep this suite on the mocked session.
vi.mock("../../comps/AppLayout/AccountButton", async () => {
  const { useWalletSession } = await import("../../wallet/useWalletSession");
  return { AccountButton: () => {
    const session = useWalletSession();
    return <button onClick={() => void session.connect()}>{session.account ? "Open wallet menu" : "Connect wallet"}</button>;
  } };
});
function setSession(account: `0x${string}` | null, chainId: number | null = 31337, provider = (window as any).ethereum) {
  mocks.session = { account, chainId, provider: account ? provider : null };
  mocks.sessionListeners.forEach(listener => listener());
}
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
    createOffer = async (provider: unknown, terms: unknown, stage: unknown, beforeSend?: () => Promise<void>) => {
      await beforeSend?.(); return mocks.create(this.config, provider, terms, stage);
    };
    accept = (provider: unknown, id: bigint, stage: unknown) => mocks.accept(this.config, provider, id, stage);
    getIncomingOffers = (cursor?: bigint) => mocks.incoming(this.config, cursor);
    getLoan = (id: bigint) => mocks.getLoan(this.config, id);
    withdraw = (provider: unknown, token: string, amount: bigint, recipient: string, stage: unknown) =>
      mocks.withdraw(this.config, provider, token, amount, recipient, stage);
    withdrawCredit = (provider: unknown, id: bigint, token: string, amount: bigint, recipient: string, stage: unknown) =>
      mocks.withdrawCredit(this.config, provider, id, token, amount, recipient, stage);
    repay = (provider: unknown, id: bigint, stage: unknown) => mocks.repay(this.config, provider, id, stage);
    repayWithCredits = (provider: unknown, id: bigint, sourceIds: bigint[], sourceAmounts: bigint[], walletAmount: bigint, stage: unknown) =>
      mocks.repayWithCredits(this.config, provider, id, sourceIds, sourceAmounts, walletAmount, stage);
  },
}));
vi.mock("../../p2p/requests", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../p2p/requests")>(),
  loadBorrowerRequests: vi.fn().mockResolvedValue({ requests: [], nextCursor: null }),
  signRequestAction: vi.fn().mockResolvedValue({}),
  validateRequestFunding: vi.fn().mockResolvedValue({}),
  bindRequestOffer: vi.fn().mockResolvedValue({}),
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
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value: function() { this.setAttribute("open", ""); } }, close: { configurable: true, value: function() { this.removeAttribute("open"); } } });
  vi.clearAllMocks();
  window.localStorage.clear(); window.sessionStorage.clear();
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
  mocks.incoming.mockReset().mockResolvedValue({ offers: [], nextCursor: null });
  mocks.withdraw.mockReset().mockResolvedValue(undefined);
  mocks.withdrawCredit.mockReset().mockResolvedValue(undefined);
  mocks.repay.mockReset().mockResolvedValue(undefined);
  mocks.repayWithCredits.mockReset().mockResolvedValue(undefined);
  mocks.listeners.clear();
  mocks.session = { account: null, chainId: null, provider: null };
  mocks.walletConnect.mockReset().mockImplementation(async () => { setSession(await mocks.connect()); });
  mocks.walletDisconnect.mockReset().mockImplementation(() => setSession(null));
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
test("memecoin lender entry opens the funding flow for its exact market",async()=>{
  window.history.replaceState(null,"",`/borrow/p2p?market=${cashcat.address}&intent=lend`);
  render(<P2PLoansScreen />);
  expect(await screen.findByRole("heading",{name:"Lend USDG"})).toBeVisible();
  expect(screen.getByRole("button",{name:"Connect wallet to lend"})).toBeVisible();
});
test("memecoin request entry opens the request dialog without funding a loan",async()=>{
  Object.defineProperties(HTMLDialogElement.prototype,{
    showModal:{configurable:true,value:function(){this.setAttribute("open","");}},
    close:{configurable:true,value:function(){this.removeAttribute("open");}},
  });
  window.history.replaceState(null,"",`/borrow/p2p?market=${cashcat.address}&intent=request`);
  render(<P2PLoansScreen />);
  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.accept).not.toHaveBeenCalled();
});
async function loaded() {
  await screen.findByRole("heading", { name: "Loan marketplace" });
  await waitFor(() => expect(document.querySelector("#p2p-panel")).toHaveAttribute("aria-busy", "false"));
}
async function connect() {
  fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
}
async function fillCreate(privateOffer = false) {
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  if (privateOffer) fireEvent.change(screen.getByLabelText("Offer visibility"), { target: { value: "private" } });
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "1500.000001" } });
  fireEvent.change(screen.getByLabelText("Collateral required · SLV"), { target: { value: "5.000000000000000001" } });
  fireEvent.change(screen.getByLabelText("Total interest · USDG"), { target: { value: "500.000001" } });
  fireEvent.change(screen.getByLabelText("Loan duration · days"), { target: { value: "45" } });
  fireEvent.change(screen.getByLabelText("Offer expiry · local time"), { target: { value: "2026-07-13T12:00" } });
}
test("visual controls keep exact loan terms through review and funding", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await fillCreate();
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("Collateral required · SLV"), { target: { value: "2" } });
  fireEvent.change(screen.getByRole("slider", { name: "Adjust collateral" }), { target: { value: "150" } });
  expect(screen.getByLabelText("Collateral required · SLV")).toHaveValue("3");
  expect(screen.getByLabelText("Loan amount · USDG")).toHaveValue("100");
  fireEvent.click(screen.getByRole("button", { name: "%" }));
  fireEvent.change(screen.getByLabelText("Total interest · %"), { target: { value: "12.5" } });
  expect(within(screen.getByLabelText("Agreed loan per collateral token")).getByText("33.333333 USDG"))
    .toBeInTheDocument();
  expect(within(screen.getByLabelText("Repayment breakdown")).getByText("112.5 USDG")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(screen.getByRole("heading", { name: "Review your offer" })).toBeInTheDocument();
  expect(screen.getByText("112.5 USDG")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Fund offer" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]![2]).toMatchObject({
    principal: 100_000_000n,
    collateral: 3n * 10n ** 18n,
    interest: 12_500_000n,
    durationDays: 45,
  });
});

test("exact inputs stay unrestricted and changing principal or duration preserves the fixed fee", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  expect(screen.getByRole("slider", { name: "Adjust collateral" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "100" } });
  fireEvent.change(screen.getByLabelText("Total interest · USDG"), { target: { value: "150.000001" } });
  expect(screen.getByLabelText("Total interest · USDG")).toHaveValue("150.000001");
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "200" } });
  fireEvent.change(screen.getByLabelText("Loan duration · days"), { target: { value: "90" } });
  expect(screen.getByLabelText("Total interest · USDG")).toHaveValue("150.000001");
  expect(screen.getByText(/75.000000% for the full term|≈ 75% for the full term/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("Total interest · USDG"), { target: { value: "0" } });
  expect(screen.getByLabelText("Total interest · USDG")).toHaveValue("0");
  fireEvent.change(screen.getByLabelText("Collateral required · SLV"), { target: { value: "123.000000000000000001" } });
  expect(screen.getByLabelText("Collateral required · SLV")).toHaveValue("123.000000000000000001");
  fireEvent.change(screen.getByLabelText("Collateral required · SLV"), { target: { value: "4" } });
  fireEvent.change(screen.getByRole("slider", { name: "Adjust collateral" }), { target: { value: "25" } });
  expect(screen.getByLabelText("Collateral required · SLV")).toHaveValue("1");
});

test("percent edits recalculate exact interest and preserve the rate when principal changes", async () => {
  render(<P2PLoansScreen standalone />); await loaded(); await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "1.000001" } });
  fireEvent.click(screen.getByRole("button", { name: "%" }));
  fireEvent.change(screen.getByLabelText("Total interest · %"), { target: { value: "12.51" } });
  expect(within(screen.getByLabelText("Repayment breakdown")).getByText("0.1251 USDG")).toBeVisible();
  fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "2" } });
  expect(screen.getByLabelText("Total interest · %")).toHaveValue("12.51");
  expect(within(screen.getByLabelText("Repayment breakdown")).getByText("0.2502 USDG")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "USDG" }));
  expect(screen.getByLabelText("Total interest · USDG")).toHaveValue("0.2502");
});

test("loads public offers without asking for a wallet, excludes private listings and shows unavailable asset reasons", async () => {
  publicByMarket.set(slv.address, page([baseLoan, { ...baseLoan, id: 2n, isPublic: false, borrower: BORROWER }]));
  render(<P2PLoansScreen standalone />);
  await loaded();
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("How P2P loans work and collateral risk"));
  fireEvent.click(screen.getByText("Unavailable collateral"));
  expect(screen.getByText("Token transfers are currently paused.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review loan" }));
  expect(screen.getByRole("button", { name: "Connect to accept" })).toBeEnabled();
  expect(screen.getByText("45 days later")).toBeVisible();
});
test("funds a public offer with exact precision and custom terms beyond the pilot limits", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await fillCreate();
  expect(screen.queryByLabelText("Borrower wallet address")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(screen.getByRole("button", { name: "Fund offer" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  fireEvent.click(screen.getByRole("button", { name: "Fund offer" }));
  await screen.findByRole("heading", { name: "Your offer is published" });
  expect(mocks.create).toHaveBeenCalledWith(slv, expect.any(Object), {
    borrower: ZERO_ADDRESS,
    principal: 1_500_000_001n,
    collateral: 5_000_000_000_000_000_001n,
    interest: 500_000_001n,
    durationDays: 45,
    expiresAt: Math.floor(new Date("2026-07-13T12:00").getTime() / 1000),
  }, expect.any(Function));
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(`market=${slv.address}&offer=99`),
    )
  );
});
test("requires a valid private borrower and keeps the recipient explicit in the review", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await fillCreate(true);
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  const borrower = screen.getByLabelText("Borrower wallet address");
  await waitFor(() => expect(borrower).toHaveFocus());
  expect(borrower).toHaveAttribute("aria-invalid", "true");
  expect(borrower).toHaveAccessibleDescription(/borrower wallet address/);
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Borrower wallet address"), { target: { value: BORROWER } });
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(screen.getByText(`Private · Only ${BORROWER} can accept.`)).toBeVisible();
});
test("filters and sorts public offers across markets using creation time rather than colliding local IDs", async () => {
  publicByMarket.set(
    cashcat.address,
    page([{ ...baseLoan, principal: 700_000_000n, createdAt: now - 1, durationDays: 14 }]),
  );
  render(<P2PLoansScreen standalone />);
  await loaded();
  expect(screen.getAllByRole("article")[0]).toHaveAccessibleName("CASHCAT offer 1");
  fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "amount" } });
  expect(screen.getAllByRole("article")[0]).toHaveAccessibleName("SLV offer 1");
  fireEvent.change(screen.getByLabelText("Minimum loan · USDG"), { target: { value: "600" } });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Maximum days"), { target: { value: "10" } });
  expect(screen.getByText("No loans match these filters")).toBeVisible();
});
test("failed market reads retain an explicit stale state and prevent funding while keeping asset selection available", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  mocks.read.mockImplementation(async (config: Deployment) => {
    if (config.address === slv.address) {
      throw Object.assign(new Error("Raw RPC URL and request body"), { shortMessage: "RPC unavailable." });
    }
    return ownByMarket.get(config.address);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh offers and balances" }));
  expect(await screen.findByText(/Affected market actions stay disabled until refreshed/)).toHaveAttribute("role", "status");
  expect(screen.queryByText(/Raw RPC URL/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  expect(screen.getByRole("button", { name: "Review offer" })).toBeDisabled();
  expect(screen.getByLabelText("Collateral asset")).toBeEnabled();
  fireEvent.focus(screen.getByLabelText("Collateral asset"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Lend USDG" })).getByRole("option", { name: /CASHCAT/ }));
  expect(screen.getByRole("button", { name: "Review offer" })).toBeEnabled();
});
test("account changes clear personal balances and acknowledgments while public offers remain browsable", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await fillCreate();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  act(() => setSession(null));
  await screen.findByRole("button", { name: "Connect wallet" });
  expect(screen.queryByRole("button", { name: "Fund offer" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();
  expect(screen.getByText(/account or network changed/)).toBeVisible();
});
test("a lost public-offer race refreshes the loan and never reports acceptance success", async () => {
  mocks.connect.mockResolvedValue(BORROWER);
  ownByMarket = new Map([slv, cashcat, pilot].map((config) => [config.address, { ...baseOwn, account: BORROWER }]));
  mocks.accept.mockImplementation(async () => {
    // A marketplace page may lag behind the direct loan read; the latter must win.
    mocks.getLoan.mockResolvedValue({
      ...baseLoan,
      borrower: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "active",
      dueAt: now + 45 * 86_400,
    });
    throw new Error("This offer has already been accepted. No loan was opened for your wallet.");
  });
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("button", { name: "Review loan" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I must repay/ }));
  fireEvent.click(screen.getByRole("button", { name: "Accept loan" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent(/already been accepted/);
  expect(screen.queryByRole("button", { name: "Accept loan" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Loan accepted. Collateral/)).not.toBeInTheDocument();
});
test("preserves legacy loan identity and withdraws pilot credits through the original market", async () => {
  ownByMarket.set(slv.address, { ...baseOwn, offers: [baseLoan] });
  ownByMarket.set(pilot.address, {
    ...baseOwn,
    offers: [{ ...baseLoan, isPublic: false, borrower: BORROWER, status: "active", dueAt: now + 10 * 86_400 }],
    credits: { USDG: 25_000_000n, COLLATERAL: 0n },
  });
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  fireEvent.click(screen.getByRole("button", { name: "Lending" }));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "SLV offer 1" })).toHaveLength(2));
  const cards = screen.getAllByRole("article", { name: "SLV offer 1" });
  const legacy = cards.find((card) => within(card).queryByText(/Original SLV pilot/))!;
  fireEvent.click(within(legacy).getByRole("button", { name: "Review loan" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh offers and balances" }));
  await waitFor(() => expect(mocks.getLoan).toHaveBeenCalledWith(pilot, 1n));
  fireEvent.click(screen.getByRole("tab", { name: "Withdrawals" }));
  fireEvent.click(screen.getByRole("button", { name: "Withdraw USDG · pilot" }));
  await waitFor(() =>
    expect(mocks.withdraw).toHaveBeenCalledWith(
      pilot,
      expect.any(Object),
      "USDG",
      25_000_000n,
      LENDER,
      expect.any(Function),
    )
  );
  expect(mocks.getLoan).toHaveBeenCalledWith(pilot, 1n);
});
test("a private offer link can be inspected disconnected without adding it to the public feed", async () => {
  window.history.replaceState(null, "", `/p2p?market=${slv.address}&offer=42`);
  mocks.getLoan.mockResolvedValue({ ...baseLoan, id: 42n, isPublic: false, borrower: BORROWER });
  render(<P2PLoansScreen standalone />);
  await screen.findByRole("article", { name: "SLV offer 42" });
  expect(screen.getByText(/Only 0x2222…2222 can accept/)).toBeVisible();
  expect(mocks.connect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to marketplace" }));
  expect(screen.queryByRole("article", { name: "SLV offer 42" })).not.toBeInTheDocument();
});
test("missing registry fails clearly without synthetic markets or wallet requests", async () => {
  mocks.load.mockRejectedValue(new Error("No verified deployment is configured."));
  render(<P2PLoansScreen standalone />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/No verified deployment/);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(screen.queryByRole("heading", { name: "Loan marketplace" })).not.toBeInTheDocument();
});

test("rejects a duration beyond the supported calendar before funding review", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await fillCreate();
  fireEvent.change(screen.getByLabelText("Loan duration · days"), { target: { value: "100000000" } });
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  const duration = screen.getByLabelText("Loan duration · days");
  await waitFor(() => expect(duration).toHaveFocus());
  expect(duration).toHaveAttribute("aria-invalid", "true");
  expect(duration).toHaveAccessibleDescription(/supported calendar range/);
  expect(screen.queryByRole("button", { name: "Fund offer" })).not.toBeInTheDocument();
});
test("public pagination cannot clear a failed personal balance read", async () => {
  publicByMarket.set(slv.address, { ...page([baseLoan]), nextCursor: 5n });
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  mocks.read.mockImplementation(async (config: Deployment) => {
    if (config.address === slv.address) throw new Error("Wallet balances unavailable.");
    return ownByMarket.get(config.address);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh offers and balances" }));
  await screen.findByRole("button", { name: "Retry failed markets" });
  fireEvent.click(screen.getByRole("button", { name: "Load older funded offers" }));
  await waitFor(() => expect(mocks.browse).toHaveBeenCalledWith(slv, 5n));
  await waitFor(() => expect(screen.getByRole("button", { name: "Load older funded offers" })).toBeEnabled());
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  expect(screen.getByRole("button", { name: "Review offer" })).toBeDisabled();
});

function delayed<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("ready public markets are usable while another market loads without showing false emptiness", async () => {
  const slow = delayed<OfferPage>();
  mocks.browse.mockImplementation((config: Deployment) =>
    config.address === cashcat.address
      ? slow.promise
      : Promise.resolve(publicByMarket.get(config.address) ?? page())
  );
  render(<P2PLoansScreen standalone />);
  expect(await screen.findByRole("article", { name: "SLV offer 1" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  expect(screen.getByLabelText("Market loading status")).toHaveAttribute("data-p2p-loading", "true");
  fireEvent.change(screen.getByLabelText("Collateral"), { target: { value: "CASHCAT" } });
  expect(screen.getByRole("status", { name: "Loading public offers" })).toBeVisible();
  expect(screen.queryByText("No loans match these filters")).not.toBeInTheDocument();
  await act(async () => slow.resolve(page()));
  expect(screen.getByText("No loans match these filters")).toBeVisible();
});

test("a ready market can fund while an unrelated wallet read is pending", async () => {
  const slow = delayed<Snapshot>();
  mocks.read.mockImplementation((config: Deployment) =>
    config.address === cashcat.address
      ? slow.promise
      : Promise.resolve(ownByMarket.get(config.address))
  );
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Withdrawals" }));
  expect(await screen.findByRole("heading", {name: "Wallet balances"})).toBeVisible();
  await waitFor(() => expect(screen.getByText("10000")).toBeVisible());
  await fillCreate();
  expect(screen.getByRole("button", { name: "Review offer" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  fireEvent.click(screen.getByRole("button", { name: "Fund offer" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  await screen.findByText("Your offer is published");
  expect(mocks.read.mock.calls.filter(([config]) => config.address === cashcat.address)).toHaveLength(1);
  expect(screen.getByLabelText("Market loading status")).toHaveAttribute("data-p2p-loading", "true");
});

test("an unverified target cannot review or fund even when another wallet market is ready", async () => {
  const slow = delayed<Snapshot>();
  mocks.read.mockImplementation((config: Deployment) =>
    config.address === slv.address
      ? slow.promise
      : Promise.resolve(ownByMarket.get(config.address))
  );
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  expect(screen.getByRole("button", { name: "Review offer" })).toBeDisabled();
  expect(screen.getByLabelText("Collateral asset")).toBeEnabled();
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.focus(screen.getByLabelText("Collateral asset"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Lend USDG" })).getByRole("option", { name: /CASHCAT/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review offer" })).toBeEnabled());
  expect(mocks.create).not.toHaveBeenCalled();
});

test("late per-market reads from a disconnected wallet cannot restore its balances", async () => {
  const old = delayed<Snapshot>();
  mocks.read.mockImplementation((config: Deployment) =>
    config.address === cashcat.address
      ? old.promise
      : Promise.resolve(ownByMarket.get(config.address))
  );
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(cashcat, undefined));
  act(() => setSession(null));
  await screen.findByRole("button", { name: "Connect wallet" });
  mocks.connect.mockResolvedValue(BORROWER);
  mocks.read.mockImplementation(async () => ({
    ...baseOwn,
    account: BORROWER,
    balances: { USDG: 2_000_000n, COLLATERAL: 0n },
  }));
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Withdrawals" }));
  expect(await screen.findByRole("heading", {name: "Wallet balances"})).toBeVisible();
  await waitFor(() => expect(screen.getByText(BORROWER, { selector: "p.p2p-address" })).toBeVisible());
  await act(async () => old.resolve({ ...baseOwn, balances: { USDG: 987_654_321_000_000n, COLLATERAL: 1n } }));
  expect(screen.queryByText("987654321")).not.toBeInTheDocument();
  expect(screen.queryByText("10000")).not.toBeInTheDocument();
});

test("a market-only Portfolio withdrawal link selects its market and withdrawal section", async () => {
  window.history.replaceState(null, "", `/p2p?market=${cashcat.address}#p2p-credits`);
  render(<P2PLoansScreen standalone />);
  await screen.findByRole("heading", { name: "Available to withdraw" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Withdrawals" })).toHaveAttribute("aria-selected", "true");
  expect(document.getElementById("p2p-credits")).not.toBeNull();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  expect(screen.getByLabelText("Collateral asset")).toHaveValue(`${cashcat.collateralSymbol} · ${cashcat.collateralName ?? cashcat.collateralSymbol}`);
  expect(mocks.getLoan).not.toHaveBeenCalled();
});

test("retrying one failed market does not invalidate another in-flight market", async () => {
  const slow = delayed<OfferPage>();
  mocks.browse.mockImplementation((config: Deployment) =>
    config.address === cashcat.address ? slow.promise : Promise.reject(new Error("Temporary read failure"))
  );
  render(<P2PLoansScreen standalone />);
  fireEvent.click(await screen.findByText("Market error details"));
  const retry = screen.getByRole("button", { name: "Retry SLV market" });
  mocks.browse.mockImplementation((config: Deployment) =>
    config.address === cashcat.address ? slow.promise : Promise.resolve(page([baseLoan]))
  );
  fireEvent.click(retry);
  await screen.findByRole("article", { name: "SLV offer 1" });
  await act(async () => slow.resolve(page([{ ...baseLoan, id: 2n }])));
  expect(await screen.findByRole("article", { name: "CASHCAT offer 2" })).toBeVisible();
  expect(mocks.browse.mock.calls.filter(([config]) => config.address === cashcat.address)).toHaveLength(1);
});


test("uses the existing application wallet when arriving at P2P without another connection prompt", async () => {
  const connectorProvider = { request: vi.fn() };
  setSession(LENDER, slv.chainId, connectorProvider);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.walletConnect).not.toHaveBeenCalled();
  expect(connectorProvider.request).not.toHaveBeenCalled();
});

test("a failed saved transaction keeps wallet balances and other market actions available", async () => {
  mocks.reconcile.mockRejectedValueOnce(new Error("Previous transaction was cancelled in your wallet."));
  setSession(LENDER);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await screen.findByText("Previous transaction was cancelled in your wallet.");
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  await fillCreate();
  expect(screen.getByRole("button", { name: "Review offer" })).toBeEnabled();
});

test("waiting for a saved receipt does not delay loading the wallet's loans", async () => {
  const receipt = delayed<boolean>();
  mocks.reconcile.mockReturnValueOnce(receipt.promise);
  setSession(LENDER);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await fillCreate();
  expect(screen.getByRole("button", { name: "Review offer" })).toBeEnabled();
  await act(async () => receipt.resolve(false));
});

test("restoring an already connected wallet preserves a loan deep link while its initial read is pending", async () => {
  const connectorProvider = { request: vi.fn() };
  const pendingLoan = delayed<Loan>();
  window.history.replaceState(null, "", `/p2p?market=${slv.address}&offer=1`);
  setSession(LENDER, slv.chainId, connectorProvider);
  mocks.getLoan.mockImplementation(() => pendingLoan.promise);
  render(<P2PLoansScreen standalone />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await waitFor(() => expect(mocks.getLoan).toHaveBeenCalled());
  await act(async () => pendingLoan.resolve(baseLoan));
  expect(await screen.findByRole("button", { name: "Cancel offer" })).toBeEnabled();
  expect(screen.getByText("Wallets and token identity")).toBeVisible();
  expect(window.location.search).toBe(`?market=${slv.address}&offer=1`);
  expect(mocks.walletConnect).not.toHaveBeenCalled();
  expect(connectorProvider.request).not.toHaveBeenCalled();
});


test("account switches adopt the shared connector and clear the previous funding review", async () => {
  const connectorProvider = { request: vi.fn() };
  setSession(LENDER, slv.chainId, connectorProvider);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await fillCreate();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  mocks.read.mockImplementation(async () => ({ ...baseOwn, account: BORROWER }));
  act(() => setSession(BORROWER, slv.chainId, connectorProvider));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Fund offer" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
  await fillCreate();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(screen.getByRole("checkbox", { name: /I accept that my funds/ })).not.toBeChecked();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.walletConnect).not.toHaveBeenCalled();
});

test("network changes invalidate a review and only restore account reads on the market network", async () => {
  setSession(LENDER);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await fillCreate();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  mocks.read.mockClear();
  act(() => setSession(LENDER, 1));
  expect(await screen.findByText(/Switch to Local E2E in your wallet/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Fund offer" })).not.toBeInTheDocument();
  expect(mocks.read).not.toHaveBeenCalled();
  act(() => setSession(LENDER, slv.chainId));
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  expect(screen.queryByText(/Switch to Local E2E in your wallet/)).not.toBeInTheDocument();
  expect(mocks.create).not.toHaveBeenCalled();
});

test("funding uses the selected shared connector rather than the browser default wallet", async () => {
  const connectorProvider = { request: vi.fn() };
  setSession(LENDER, slv.chainId, connectorProvider);
  render(<P2PLoansScreen standalone />);
  await loaded();
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await fillCreate();
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
  fireEvent.click(screen.getByRole("button", { name: "Fund offer" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalled());
  expect(mocks.create.mock.calls[0]![1]).toBe(connectorProvider);
  expect((window as any).ethereum.request).not.toHaveBeenCalled();
});

test("V3 incoming private offers stay separate from owned loans and paginate their own inbox", async () => {
  const v3 = { ...slv, version: 3 as const };
  const incomingLoan: Loan = { ...baseLoan, id: 90n, lender: BORROWER, borrower: LENDER, isPublic: false };
  const ownedLoan: Loan = { ...baseLoan, id: 1n, borrower: LENDER, lender: BORROWER, status: "active" as const, dueAt: now + 1000, repaymentDeadline: now + 100_000 };
  mocks.load.mockResolvedValue({ markets: [v3], unavailableAssets: [] });
  ownByMarket.set(v3.address, { ...baseOwn, offers: [ownedLoan], incomingOffers: [incomingLoan], incomingNextCursor: 80n, incomingOffersComplete: false });
  mocks.incoming.mockResolvedValue({ offers: [{ ...incomingLoan, id: 70n }], nextCursor: null });
  render(<P2PLoansScreen standalone />); await loaded(); await connect();
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  expect(await screen.findByRole("article", { name: "SLV offer 1" })).toBeVisible();
  expect(screen.queryByRole("article", { name: "SLV offer 90" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Incoming" }));
  expect(screen.getByRole("article", { name: "SLV offer 90" })).toBeVisible();
  expect(screen.queryByRole("article", { name: "SLV offer 1" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Load more incoming offers" }));
  expect(await screen.findByRole("article", { name: "SLV offer 70" })).toBeVisible();
  expect(mocks.incoming).toHaveBeenCalledWith(v3, 80n);
  fireEvent.click(screen.getByRole("button", { name: "Borrowing" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();
});

test("a V3 inbox read failure leaves owned loans manageable", async () => {
  const v3 = { ...slv, version: 3 as const };
  mocks.load.mockResolvedValue({ markets: [v3], unavailableAssets: [] });
  ownByMarket.set(v3.address, { ...baseOwn, offers: [{ ...baseLoan, id: 1n }], incomingOffers: [], incomingNextCursor: 20n, incomingOffersComplete: false });
  mocks.incoming.mockRejectedValue(new Error("Inbox unavailable"));
  render(<P2PLoansScreen standalone />); await loaded(); await connect();
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  fireEvent.click(screen.getByRole("button", { name: "Incoming" }));
  fireEvent.click(screen.getByRole("button", { name: "Load more incoming offers" }));
  await screen.findByText(/Some incoming offers could not be loaded/);
  fireEvent.click(screen.getByRole("button", { name: "Lending" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Review loan" }));
  expect(screen.getByRole("button", { name: "Cancel offer" })).toBeEnabled();
});

test("empty offer review reports accessible errors beside each missing amount and focuses the first field", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  const principal = screen.getByLabelText("Loan amount · USDG");
  const collateral = screen.getByLabelText("Collateral required · SLV");
  const readsBeforeSubmit = mocks.read.mock.calls.length;
  const browseBeforeSubmit = mocks.browse.mock.calls.length;

  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));

  await waitFor(() => expect(principal).toHaveFocus());
  expect(principal).toHaveAttribute("aria-invalid", "true");
  expect(collateral).toHaveAttribute("aria-invalid", "true");
  expect(principal).toHaveAccessibleDescription(/loan amount/i);
  expect(collateral).toHaveAccessibleDescription(/collateral/i);
  expect(principal.getAttribute("aria-describedby")).not.toBe(collateral.getAttribute("aria-describedby"));
  expect(screen.getByRole("heading", { name: "Lend USDG" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Review your offer" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh contract data" })).not.toBeInTheDocument();
  expect(mocks.read).toHaveBeenCalledTimes(readsBeforeSubmit);
  expect(mocks.browse).toHaveBeenCalledTimes(browseBeforeSubmit);
  expect(mocks.create).not.toHaveBeenCalled();
});

test("correcting invalid amounts clears their errors without rounding the entered terms", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
  const principal = screen.getByLabelText("Loan amount · USDG");
  const collateral = screen.getByLabelText("Collateral required · SLV");
  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(principal).toHaveAttribute("aria-invalid", "true");
  expect(collateral).toHaveAttribute("aria-invalid", "true");

  fireEvent.change(principal, { target: { value: "1500.000001" } });
  expect(principal).not.toHaveAttribute("aria-invalid", "true");
  expect(collateral).toHaveAttribute("aria-invalid", "true");
  fireEvent.change(collateral, { target: { value: "5.000000000000000001" } });
  expect(collateral).not.toHaveAttribute("aria-invalid", "true");
  expect(principal).toHaveValue("1500.000001");
  expect(collateral).toHaveValue("5.000000000000000001");

  fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  expect(screen.getByRole("heading", { name: "Review your offer" })).toHaveFocus();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit terms" }));
  expect(screen.getByLabelText("Loan amount · USDG")).toHaveValue("1500.000001");
  expect(screen.getByLabelText("Collateral required · SLV")).toHaveValue("5.000000000000000001");
  expect(screen.getByLabelText("Loan amount · USDG")).not.toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Collateral required · SLV")).not.toHaveAttribute("aria-invalid", "true");
});

test("offer review moves focus after the review mounts and editing returns it to the submit button", async () => {
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const reviewAtScroll: Array<HTMLElement | null> = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(() => reviewAtScroll.push(document.getElementById("p2p-review-heading"))),
  });
  try {
    render(<P2PLoansScreen standalone />);
    await loaded();
    await connect();
    await fillCreate();
    const submit = screen.getByRole("button", { name: "Review offer" });
    expect(submit).toHaveAttribute("id", "p2p-review-submit");
    submit.focus();
    reviewAtScroll.length = 0;
    fireEvent.click(submit);

    const heading = screen.getByRole("heading", { name: "Review your offer" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("id", "p2p-review-heading");
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(reviewAtScroll).toContain(heading);
    fireEvent.click(screen.getByRole("checkbox", { name: /I accept that my funds/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit terms" }));

    const restoredSubmit = screen.getByRole("button", { name: "Review offer" });
    await waitFor(() => expect(restoredSubmit).toHaveFocus());
    expect(restoredSubmit).toHaveAttribute("id", "p2p-review-submit");
    fireEvent.click(restoredSubmit);
    expect(screen.getByRole("checkbox", { name: /I accept that my funds/ })).not.toBeChecked();
  } finally {
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

test("public loan details mount before scrolling and return focus to the originating offer", async () => {
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const detailAtScroll: Array<HTMLElement | null> = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(() => detailAtScroll.push(document.getElementById("p2p-detail-heading"))),
  });
  try {
    render(<P2PLoansScreen standalone />);
    await loaded();
    const originalOffer = screen.getByRole("article", { name: "SLV offer 1" });
    const reviewLoan = within(originalOffer).getByRole("button", { name: "Review loan" });
    reviewLoan.focus();
    detailAtScroll.length = 0;
    fireEvent.click(reviewLoan);

    const heading = document.getElementById("p2p-detail-heading");
    expect(heading).not.toBeNull();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(detailAtScroll).toContain(heading);
    expect(screen.getByRole("button", { name: "Connect to accept" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to marketplace" }));

    const restoredOffer = screen.getByRole("article", { name: "SLV offer 1" });
    expect(within(restoredOffer).getByRole("button", { name: "Review loan" })).toHaveFocus();
    expect(mocks.walletConnect).not.toHaveBeenCalled();
  } finally {
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

test("multiple market failures keep diagnostics collapsed and retry only failed markets while ready loans stay usable", async () => {
  ownByMarket.set(slv.address, {
    ...baseOwn,
    offers: [{ ...baseLoan, id: 7n, lender: BORROWER, borrower: LENDER, status: "active", dueAt: now + 86_400 }],
  });
  mocks.read.mockImplementation(async (config: Deployment) => {
    if (config.address === cashcat.address) throw new Error("CASHCAT balances unavailable.");
    if (config.address === pilot.address) throw new Error("Pilot balances unavailable.");
    return ownByMarket.get(config.address);
  });
  render(<P2PLoansScreen standalone />);
  await loaded();
  await connect();
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  await waitFor(() => expect(screen.getByLabelText("Market loading status")).toHaveAttribute("data-p2p-loading", "false"));

  expect(screen.getByText(/2 markets need a retry/)).toHaveAttribute("role", "status");
  expect(screen.getByLabelText("Market loading status")).toHaveTextContent("1 need a retry");
  const details = screen.getByText("Market error details").closest("details")!;
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(within(details).getByText(/CASHCAT balances unavailable/)).not.toBeVisible();
  expect(within(details).getByText(/Pilot balances unavailable/)).not.toBeVisible();
  expect(screen.getByRole("button", { name: "Retry failed markets" })).toBeEnabled();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();

  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  const readyLoan = screen.getByRole("article", { name: "SLV offer 7" });
  expect(readyLoan).toBeVisible();
  expect(within(readyLoan).getByRole("button", { name: "Review loan" })).toBeEnabled();
  mocks.read.mockClear().mockImplementation(async (config: Deployment) => ownByMarket.get(config.address));
  mocks.browse.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Retry failed markets" }));

  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry failed markets" })).not.toBeInTheDocument());
  expect(mocks.read.mock.calls.map(([config]) => config.address).sort()).toEqual([cashcat.address, pilot.address].sort());
  expect(mocks.browse.mock.calls.every(([config]) => config.address === cashcat.address)).toBe(true);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("article", { name: "SLV offer 7" })).toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();
});

const borrowingLoan: Loan = {
  ...baseLoan,
  id: 7n,
  lender: BORROWER,
  borrower: LENDER,
  status: "active",
  dueAt: now + 86_400,
  repaymentDeadline: now + 2 * 86_400,
  collateralAvailable: baseLoan.collateral,
};

async function openRepayment(config: Deployment = slv, loan: Loan = borrowingLoan) {
  const provider = { request: vi.fn() };
  mocks.load.mockResolvedValue({ markets: [config], unavailableAssets: [] });
  ownByMarket.set(config.address, { ...baseOwn, offers: [loan] });
  window.history.replaceState(null, "", `/p2p?market=${config.address}&offer=${loan.id}`);
  setSession(LENDER, config.chainId, provider);
  render(<P2PLoansScreen standalone />);
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(config, undefined));
  const flow = await screen.findByRole("region", { name: "Repay and receive collateral" });
  await waitFor(() => expect(within(flow).getByRole("button", { name: /^Repay \d/ })).toBeEnabled());
  return { flow, provider };
}

function settleRepayment(config: Deployment, credits = borrowingLoan.collateral, loan: Loan = borrowingLoan) {
  const repaid: Loan = {
    ...loan,
    status: "repaid",
    ...(config.version === 3 ? {
      loanCredits: {
        USDG: { beneficiary: BORROWER, nominal: loan.principal + loan.interest, available: loan.principal + loan.interest },
        COLLATERAL: { beneficiary: LENDER, nominal: loan.collateral, available: credits },
      },
    } : {}),
  };
  ownByMarket.set(config.address, {
    ...ownByMarket.get(config.address)!,
    blockNumber: 11n,
    offers: [repaid],
    credits: { USDG: 0n, COLLATERAL: credits },
  });
  return repaid;
}

test.each([pilot, slv])("V$version guides repayment into an inline withdrawal through the original market", async (config) => {
  mocks.repay.mockImplementation(async () => { settleRepayment(config, 15n * 10n ** 18n); });
  const { flow, provider } = await openRepayment(config);

  expect(flow).toHaveTextContent(/two transactions/i);
  expect(flow).toHaveTextContent("Repay USDG");
  expect(flow).toHaveTextContent("Receive SLV");
  expect(within(flow).queryByRole("button", { name: "Withdraw SLV" })).not.toBeInTheDocument();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));

  const withdraw = await within(flow).findByRole("button", { name: "Withdraw SLV" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(within(flow).queryByRole("button", { name: /^Repay / })).not.toBeInTheDocument();
  expect(mocks.repay).toHaveBeenCalledWith(config, provider, borrowingLoan.id, expect.any(Function));
  expect(mocks.withdraw).not.toHaveBeenCalled();

  fireEvent.click(withdraw);
  await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledWith(
    config, provider, "COLLATERAL", borrowingLoan.collateral, LENDER, expect.any(Function),
  ));
  expect(mocks.withdrawCredit).not.toHaveBeenCalled();
});

test("legacy repayment withdrawal is capped by currently available collateral credits", async () => {
  const available = 2n * 10n ** 18n;
  mocks.repay.mockImplementation(async () => { settleRepayment(slv, available); });
  const { flow, provider } = await openRepayment();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  const withdraw = await within(flow).findByRole("button", { name: "Withdraw SLV" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  fireEvent.click(withdraw);
  await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledWith(
    slv, provider, "COLLATERAL", available, LENDER, expect.any(Function),
  ));
});

test("repayment waits for confirmation before offering collateral withdrawal", async () => {
  let confirm!: () => void;
  mocks.repay.mockImplementation(async (_config, _provider, _id, stage) => {
    stage({ status: "pending", message: "Waiting for repayment confirmation" });
    await new Promise<void>(resolve => { confirm = resolve; });
    settleRepayment(cashcat);
    stage({ status: "confirmed", message: "Repayment confirmed" });
  });
  const { flow } = await openRepayment(cashcat);
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  await waitFor(() => expect(mocks.repay).toHaveBeenCalledTimes(1));

  expect(within(flow).queryByRole("button", { name: "Withdraw CASHCAT" })).not.toBeInTheDocument();
  expect(mocks.withdraw).not.toHaveBeenCalled();
  expect(flow).not.toHaveTextContent(/loan repaid/i);

  await act(async () => { confirm(); });
  await waitFor(() => expect(within(flow).getByRole("button", { name: "Withdraw CASHCAT" })).toBeEnabled());
  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(mocks.withdraw).not.toHaveBeenCalled();
});

test("a rejected repayment keeps the first step available and never offers collateral withdrawal", async () => {
  mocks.repay.mockRejectedValueOnce(new Error("User rejected the request."));
  const { flow } = await openRepayment();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));

  await screen.findByRole("alert");
  await waitFor(() => expect(within(flow).getByRole("button", { name: /^Repay / })).toBeEnabled());
  expect(within(flow).queryByRole("button", { name: "Withdraw SLV" })).not.toBeInTheDocument();
  expect(flow).not.toHaveTextContent(/loan repaid/i);
  expect(mocks.withdraw).not.toHaveBeenCalled();
});

test("confirmed repayment stays settled when the refreshed loan read is temporarily stale", async () => {
  mocks.repay.mockImplementation(async () => {
    settleRepayment(slv);
    mocks.getLoan.mockResolvedValue(borrowingLoan);
  });
  const { flow } = await openRepayment();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));

  const withdraw = await within(flow).findByRole("button", { name: "Withdraw SLV" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(within(flow).queryByRole("button", { name: /^Repay / })).not.toBeInTheDocument();
  expect(mocks.repay).toHaveBeenCalledTimes(1);
});

test("background refresh cannot restore repayment after a confirmed loan settles", async () => {
  mocks.repay.mockImplementation(async () => { settleRepayment(slv); });
  const { flow } = await openRepayment();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  await waitFor(() => expect(within(flow).getByRole("button", { name: "Withdraw SLV" })).toBeEnabled());

  // An RPC node may serve an older account snapshot after the receipt was verified.
  ownByMarket.set(slv.address, {
    ...ownByMarket.get(slv.address)!,
    offers: [borrowingLoan],
  });
  const readsBeforeFocus = mocks.read.mock.calls.length;
  fireEvent.focus(window);
  await waitFor(() => {
    expect(mocks.read.mock.calls.length).toBeGreaterThan(readsBeforeFocus);
    expect(screen.getByLabelText("Market loading status")).toHaveAttribute("data-p2p-loading", "false");
  });

  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(within(flow).getByRole("button", { name: "Withdraw SLV" })).toBeEnabled();
  expect(within(flow).queryByRole("button", { name: /^Repay / })).not.toBeInTheDocument();
  expect(mocks.repay).toHaveBeenCalledTimes(1);
});

test("a rejected withdrawal preserves the repaid loan and retries only receiving collateral", async () => {
  mocks.repay.mockImplementation(async () => { settleRepayment(cashcat); });
  mocks.withdraw.mockRejectedValueOnce(new Error("User rejected the request.")).mockResolvedValueOnce(undefined);
  const { flow, provider } = await openRepayment(cashcat);
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  const withdraw = await within(flow).findByRole("button", { name: "Withdraw CASHCAT" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  fireEvent.click(withdraw);

  await screen.findByRole("alert");
  await waitFor(() => expect(within(flow).getByRole("button", { name: "Withdraw CASHCAT" })).toBeEnabled());
  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(within(flow).queryByRole("button", { name: /^Repay / })).not.toBeInTheDocument();
  fireEvent.click(within(flow).getByRole("button", { name: "Withdraw CASHCAT" }));

  await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(2));
  expect(mocks.repay).toHaveBeenCalledTimes(1);
  for (const call of mocks.withdraw.mock.calls) {
    expect(call).toEqual([cashcat, provider, "COLLATERAL", borrowingLoan.collateral, LENDER, expect.any(Function)]);
  }
});

test("switching wallets during repayment cannot reveal or execute the first wallet's withdrawal", async () => {
  let confirm!: () => void;
  mocks.repay.mockImplementation(async () => {
    await new Promise<void>(resolve => { confirm = resolve; });
    settleRepayment(slv);
  });
  const { flow } = await openRepayment();
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  await waitFor(() => expect(mocks.repay).toHaveBeenCalledTimes(1));
  mocks.read.mockImplementation(async (config: Deployment) => ({ ...ownByMarket.get(config.address)!, account: BORROWER }));
  act(() => setSession(BORROWER));
  await act(async () => { confirm(); });

  await waitFor(() => expect(screen.queryByRole("region", { name: "Repay and receive collateral" })).not.toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Withdraw SLV" })).not.toBeInTheDocument();
  expect(mocks.withdraw).not.toHaveBeenCalled();
});

test("V3 repayment withdraws this loan's available collateral to the borrower without writing off a shortfall", async () => {
  const v3: Deployment = { ...cashcat, version: 3 };
  const available = 3n * 10n ** 18n;
  mocks.repay.mockImplementation(async () => { settleRepayment(v3, available); });
  const { flow, provider } = await openRepayment(v3);
  expect(flow).toHaveTextContent(/two transactions/i);
  fireEvent.click(within(flow).getByRole("button", { name: /^Repay / }));
  const withdraw = await within(flow).findByRole("button", { name: "Withdraw CASHCAT" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  fireEvent.click(withdraw);

  await waitFor(() => expect(mocks.withdrawCredit).toHaveBeenCalledWith(
    v3, provider, borrowingLoan.id, "COLLATERAL", available, LENDER, expect.any(Function),
  ));
  expect(mocks.withdraw).not.toHaveBeenCalled();
});

test("repaying V3 with USDG credits opens the same collateral receiving step", async () => {
  const v3: Deployment = { ...slv, version: 3 };
  const repaymentAmount = borrowingLoan.principal + borrowingLoan.interest;
  const sourceLoan: Loan = {
    ...baseLoan,
    id: 99n,
    status: "repaid",
    borrower: BORROWER,
    loanCredits: {
      USDG: { beneficiary: LENDER, nominal: repaymentAmount, available: repaymentAmount },
      COLLATERAL: { beneficiary: BORROWER, nominal: baseLoan.collateral, available: baseLoan.collateral },
    },
  };
  mocks.read.mockImplementation(async (config: Deployment) => {
    const own = ownByMarket.get(config.address)!;
    return { ...own, offers: [...own.offers, sourceLoan] };
  });
  mocks.repayWithCredits.mockImplementation(async () => { settleRepayment(v3); });
  const { flow, provider } = await openRepayment(v3);
  fireEvent.click(within(flow).getByText("Repay using your USDG credits"));
  fireEvent.click(within(flow).getByRole("checkbox", { name: /I approve these credits/ }));
  fireEvent.click(within(flow).getByRole("button", { name: "Repay with credits" }));

  const withdraw = await within(flow).findByRole("button", { name: "Withdraw SLV" });
  await waitFor(() => expect(withdraw).toBeEnabled());
  expect(flow).toHaveTextContent(/loan repaid/i);
  expect(mocks.repayWithCredits).toHaveBeenCalledWith(
    v3, provider, borrowingLoan.id, [sourceLoan.id], [repaymentAmount], 0n, expect.any(Function),
  );
  expect(mocks.repay).not.toHaveBeenCalled();
  fireEvent.click(withdraw);
  await waitFor(() => expect(mocks.withdrawCredit).toHaveBeenCalledWith(
    v3, provider, borrowingLoan.id, "COLLATERAL", borrowingLoan.collateral, LENDER, expect.any(Function),
  ));
});

test("returning to P2P keeps public offers visible while fresh reads are pending", async () => {
  const first = render(<P2PLoansScreen standalone />);
  await screen.findByRole("article", { name: "SLV offer 1" });
  first.unmount();
  mocks.browse.mockImplementation(() => new Promise(() => {}));
  render(<P2PLoansScreen standalone />);
  await loaded();
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeVisible();
  expect(screen.queryByRole("status", { name: "Loading public offers" })).not.toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Market loading status" })).toHaveTextContent("Updating");
});

test("marketplace defers retired wallet reads until loan history is opened", async () => {
  render(<P2PLoansScreen standalone />);
  await loaded(); await connect();
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(slv, undefined));
  expect(mocks.read).not.toHaveBeenCalledWith(pilot, undefined);
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith(pilot, undefined));
});

test("Request a loan opens a modal without switching away from funded offers", async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function() { this.setAttribute("open", ""); } },
    close: { configurable: true, value: function() { this.removeAttribute("open"); } },
  });
  publicByMarket.set(slv.address, page([]));
  render(<P2PLoansScreen standalone />);
  await screen.findByRole("heading", { name: "Be the first to post a loan" });
  const url=window.location.href;
  fireEvent.click(screen.getByRole("button", { name: "Borrow USDG" }));
  expect(screen.getByRole("dialog", { name: "Borrow USDG" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Marketplace" })).toHaveAttribute("aria-selected", "true");
  expect(window.location.href).toBe(url);
  fireEvent.click(screen.getByRole("button", { name: "Close loan request" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});


test("viewing a newly published request resets the funded filter so the request is visible", async () => {
  const { loadBorrowerRequests } = await import("../../p2p/requests");
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: function() { this.setAttribute("open", ""); } },
    close: { configurable: true, value: function() { this.removeAttribute("open"); } },
  });
  publicByMarket.set(slv.address, page([]));
  render(<P2PLoansScreen standalone />); await loaded(); await connect();
  fireEvent.change(screen.getByLabelText("Funding"), { target: { value: "funded" } });
  fireEvent.click(screen.getByRole("button", { name: "Borrow USDG" }));
  fireEvent.change(screen.getByLabelText("USDG to borrow"), { target: { value: "150" } });
  fireEvent.change(screen.getByLabelText("SLV collateral"), { target: { value: "6" } });
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  vi.mocked(loadBorrowerRequests).mockResolvedValue({ schemaVersion: 1, origin: location.origin, now: Date.now()/1000, nextCursor: null, requests: [{
    id:"new-request", sequence:1, revision:1, market:slv.address, chainId:slv.chainId, borrower:LENDER, status:"open", createdAt:Date.now()/1000,
    acceptedProposalId:null, proposals:[], terms:{principal:"150000000",collateral:"6000000000000000000",interest:"0",durationDays:30,expiresAt:Math.floor(Date.now()/1000)+86400},
  }] });
  fireEvent.click(screen.getByRole("button", { name: "Sign and publish request" }));
  await screen.findByRole("heading", { name: "Request published" });
  fireEvent.click(screen.getByRole("button", { name: "View marketplace" }));
  expect(await screen.findByRole("heading", { name: "SLV borrowing request" })).toBeVisible();
  expect(screen.getByLabelText("Funding")).toHaveValue("all");
  expect(screen.getByRole("tab", { name: "Marketplace" })).toHaveAttribute("aria-selected", "true");
});

async function readyImmediateProposal() {
  const api = await import("../../p2p/requests");
  const terms = {principal:"150000000",collateral:"6000000000000000000",interest:"20000000",durationDays:7,expiresAt:Math.floor(Date.now()/60000)*60+86400};
  const request: import("../../p2p/requests").BorrowerRequest = {id:"direct-request",sequence:1,revision:1,market:slv.address,chainId:slv.chainId,borrower:BORROWER,status:"open" as const,createdAt:Date.now()/1000,acceptedProposalId:null,proposals:[],terms};
  const saved: import("../../p2p/requests").BorrowerRequest = {...request,revision:2,proposals:[{id:"direct-proposal",lender:LENDER,terms,cancelled:false,fundedOffer:null,createdAt:Date.now()/1000}]};
  vi.mocked(api.loadBorrowerRequests).mockResolvedValue({schemaVersion:1,origin:location.origin,now:Date.now()/1000,requests:[request],nextCursor:null});
  vi.mocked(api.signRequestAction).mockResolvedValue(saved);
  vi.mocked(api.validateRequestFunding).mockReset().mockResolvedValue(saved);
  render(<P2PLoansScreen standalone />); await loaded(); await connect();
  await screen.findByRole("heading",{name:"SLV borrowing request"});
  const offerButton = screen.getByRole("button", {name: "Offer to lend"});
  expect(offerButton.closest("details")).toBeNull();
  offerButton.focus();
  fireEvent.click(offerButton);
  expect(screen.getByRole("dialog", {name: "Offer to lend · SLV"})).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox",{name:/Fund this proposal now/}));
  fireEvent.click(screen.getByRole("button",{name:"Review proposal"}));
  fireEvent.click(screen.getByRole("checkbox",{name:/I accept that my funds/}));
  return api;
}
test("lending proposal can be reviewed and dismissed without signing, restoring the action button", async () => {
  const api = await readyImmediateProposal();
  fireEvent(screen.getByRole("dialog", {name: "Offer to lend · SLV"}), new Event("cancel", {bubbles: true, cancelable: true}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name: "Offer to lend"})).toHaveFocus();
  expect(api.signRequestAction).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
test("a rejected proposal stays open with its error and permits retry", async () => {
  const api = await readyImmediateProposal();
  vi.mocked(api.signRequestAction).mockRejectedValueOnce(new Error("User rejected the request."));
  fireEvent.click(screen.getByRole("button", {name: "Propose and fund now"}));
  const dialog = screen.getByRole("dialog", {name: "Offer to lend · SLV"});
  await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/rejected/i));
  expect(within(dialog).getByRole("button", {name: "Propose and fund now"})).toBeEnabled();
  expect(mocks.create).not.toHaveBeenCalled();
});
test("proposal and funding run as one user flow with exact terms and automatic linking",async()=>{
  const api=await readyImmediateProposal();
  fireEvent.click(screen.getByRole("button",{name:"Propose and fund now"}));
  await waitFor(()=>expect(api.bindRequestOffer).toHaveBeenCalledOnce());
  expect(api.signRequestAction).toHaveBeenCalledOnce();expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.create.mock.calls[0]![2]).toMatchObject({borrower:BORROWER,principal:150000000n,collateral:6000000000000000000n,interest:20000000n,durationDays:7});
  expect(api.validateRequestFunding).toHaveBeenCalledTimes(2);
});
test("declined funding retains the saved proposal for retry without a second publication",async()=>{
  const api=await readyImmediateProposal();mocks.create.mockRejectedValueOnce(new Error("User rejected the request."));
  fireEvent.click(screen.getByRole("button",{name:"Propose and fund now"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Continue funding"})).toBeEnabled());
  expect(screen.getByRole("heading",{name:"Fund your proposal"})).toBeVisible();
  expect(within(screen.getByRole("dialog", {name:"Lend USDG"})).getByRole("alert")).toHaveTextContent(/rejected/i);
  fireEvent.click(screen.getByRole("button",{name:"Continue funding"}));
  await waitFor(()=>expect(api.bindRequestOffer).toHaveBeenCalledOnce());
  expect(api.signRequestAction).toHaveBeenCalledOnce();expect(mocks.create).toHaveBeenCalledTimes(2);
});
test("proposal cancelled during approval cannot proceed to the funding transaction",async()=>{
  const api=await readyImmediateProposal();vi.mocked(api.validateRequestFunding).mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error("Proposal cancelled"));
  fireEvent.click(screen.getByRole("button",{name:"Propose and fund now"}));
  await waitFor(()=>expect(api.validateRequestFunding).toHaveBeenCalledTimes(2));
  expect(mocks.create).not.toHaveBeenCalled();expect(api.bindRequestOffer).not.toHaveBeenCalled();
});


test("lending opens above the marketplace and Escape restores filters and trigger focus", async () => {
  render(<P2PLoansScreen standalone />); await loaded();
  fireEvent.change(screen.getByLabelText("Search loans"), {target: {value: "SLV"}});
  const trigger = screen.getByRole("button", {name: "Lend USDG"}); trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", {name: "Lend USDG"});
  expect(dialog).toBeVisible();
  expect(screen.getByRole("tab", {name:"Marketplace"})).toHaveAttribute("aria-selected", "true");
  expect(within(dialog).getByText(/You supply the USDG/)).toBeVisible();
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", {cancelable:true}));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Search loans")).toHaveValue("SLV");
  expect(trigger).toHaveFocus();
});

test("connecting from the lending dialog returns to the same lending form", async () => {
  render(<P2PLoansScreen standalone />); await loaded();
  fireEvent.click(screen.getByRole("button", {name:"Lend USDG"}));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", {name:"Connect wallet to lend"}));
  await waitFor(() => expect(within(screen.getByRole("dialog", {name:"Lend USDG"})).getByLabelText("Loan amount · USDG")).toBeVisible());
  expect(mocks.create).not.toHaveBeenCalled();
});
