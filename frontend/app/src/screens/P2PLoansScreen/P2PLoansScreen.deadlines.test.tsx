// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
vi.mock("../../borrow/TurretModel", () => ({ TurretModel: () => null }));
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Deployment, Loan, OfferPage, Snapshot } from "../../p2p/client";
import { GRACE, ZERO_ADDRESS } from "./loanPresentation";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), browse: vi.fn(), snapshot: vi.fn(), getLoan: vi.fn(),
  session: { account: null as `0x${string}` | null, provider: null as object | null },
}));
vi.mock("../../wallet/useWalletSession", () => ({
  WalletSessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useWalletSession: () => ({ ...mocks.session, chainId: 31337, connecting: false, connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("../../p2p/client", () => ({
  loadP2PRegistry: mocks.load,
  P2PClient: class {
    account = null;
    browse = mocks.browse;
    snapshot = mocks.snapshot;
    getLoan = mocks.getLoan;
    disconnect() {}
    async reconcilePending() {}
  },
}));
vi.mock("../../p2p/P2PAppLayout", () => ({ P2PAppLayout: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../../profiles/WalletAvatar", () => ({ WalletAvatar: () => null }));
vi.mock("../../comps/HowBorrowingWorks/HowBorrowingWorks", () => ({ HowP2PWorks: () => null, HowBorrowingWorks: () => null }));
vi.mock("../../p2p/requests", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../p2p/requests")>(),
  loadBorrowerRequests: vi.fn().mockResolvedValue({ requests: [], nextCursor: null }),
}));
import { P2PLoansScreen } from "./P2PLoansScreen";

const LENDER = "0x1111111111111111111111111111111111111111";
const BORROWER = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;
const market: Deployment = {
  chainId: 31337, chainName: "Local", rpcUrl: "/api/p2p-rpc", address: "0x3333333333333333333333333333333333333333",
  loanToken: "0x4444444444444444444444444444444444444444", collateralToken: "0x5555555555555555555555555555555555555555",
  loanSymbol: "USDG", collateralSymbol: "SLV", loanDecimals: 6, collateralDecimals: 18,
  runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1", version: 2,
};
const baseLoan: Loan = {
  id: 2n, lender: LENDER, borrower: ZERO_ADDRESS, isPublic: true, createdAt: NOW - 100,
  principal: 500_000_000n, collateral: 5n * 10n ** 18n, interest: 50_000_000n,
  durationDays: 30, expiresAt: NOW + 3600, dueAt: 0, status: "open",
};
let chainNow: number;
let loans: Loan[];
let firstPage: bigint[];
let ownLoans: Loan[];
let olderOwnLoans: Loan[];
let ownCursor: bigint | null;
let blockNumber: bigint;
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value: function() { this.setAttribute("open", ""); } }, close: { configurable: true, value: function() { this.removeAttribute("open"); } } });
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Clipboard unavailable")) } });
  window.history.replaceState(null, "", "/p2p");
  chainNow = NOW;
  blockNumber = 10n;
  loans = [{ ...baseLoan }];
  firstPage = [2n];
  ownLoans = [];
  olderOwnLoans = [];
  ownCursor = null;
  mocks.session = { account: null, provider: null };
  mocks.load.mockReset().mockResolvedValue({ markets: [market], unavailableAssets: [] });
  mocks.browse.mockReset().mockImplementation(async (cursor?: bigint) => ({
    offers: loans.filter(loan => loan.status === "open" && loan.expiresAt > chainNow && (cursor ? !firstPage.includes(loan.id) : firstPage.includes(loan.id))),
    now: chainNow, blockNumber, paused: false, nextCursor: cursor || loans.length === firstPage.length ? null : 2n,
  }));
  mocks.snapshot.mockReset().mockImplementation(async (cursor?: bigint) => ({
    account: mocks.session.account, now: chainNow, blockNumber, approvedLender: true, paused: false,
    nativeBalance: 10n ** 18n, balances: { USDG: 1_000_000_000n, COLLATERAL: 10n ** 18n * 10n },
    credits: { USDG: 0n, COLLATERAL: 0n }, offers: cursor ? olderOwnLoans : ownLoans, maxPrincipal: null, maxCommitted: null,
    committed: 0n, nextCursor: cursor ? null : ownCursor,
  } as Snapshot));
  mocks.getLoan.mockReset().mockImplementation(async (id: bigint) => loans.find(loan => loan.id === id)!);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function loaded() { await act(async () => { render(<P2PLoansScreen standalone />); }); }
async function advance(milliseconds: number) { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); }
function open(id = 2n) { window.history.replaceState(null, "", `/p2p?market=${market.address}&offer=${id}`); }
function connected() { mocks.session = { account: BORROWER, provider: {} }; }

test("removes expired public offers after a verified boundary refresh", async () => {
  loans[0]!.expiresAt = NOW + 10;
  await loaded();
  expect(screen.getByRole("button", { name: "Review loan" })).toBeInTheDocument();
  chainNow = NOW + 10;
  blockNumber++;
  await advance(10_000);
  expect(screen.queryByRole("button", { name: "Review loan" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Be the first to post a loan" })).toBeInTheDocument();
});

test("preserves acceptance acknowledgment, focus and user errors during background reads", async () => {
  connected();
  open();
  await loaded();
  const acknowledgment = screen.getByRole("checkbox", { name: /I must repay/ });
  fireEvent.click(acknowledgment);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy offer link" })));
  const problem = screen.getByText(/Could not copy the link/);
  acknowledgment.focus();
  blockNumber++;
  chainNow++;
  await advance(30_000);
  expect(screen.getByRole("checkbox", { name: /I must repay/ })).toBeChecked();
  expect(acknowledgment).toHaveFocus();
  expect(problem).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Accept loan" })).toBeEnabled();
});

test.each(["borrower", "lender"])("keeps the %s acknowledgment enabled while a pending refresh blocks submission", async (role) => {
  connected();
  if (role === "borrower") open();
  await loaded();
  if (role === "lender") {
    fireEvent.click(screen.getByRole("tab", { name: "Marketplace" }));
  fireEvent.click(screen.getByRole("button", { name: "Lend USDG" }));
    fireEvent.change(screen.getByLabelText("Loan amount · USDG"), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText("Collateral required · SLV"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Total interest · USDG"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Review offer" }));
  }
  const acknowledgment = screen.getByRole("checkbox", { name: role === "borrower" ? /I must repay/ : /I accept that my funds/ });
  const submit = screen.getByRole("button", { name: role === "borrower" ? "Accept loan" : "Fund offer" });
  fireEvent.click(acknowledgment);
  acknowledgment.focus();
  expect(submit).toBeEnabled();
  let finishBrowse!: (page: OfferPage) => void;
  mocks.browse.mockImplementationOnce(() => new Promise<OfferPage>(resolve => { finishBrowse = resolve; }));
  await advance(30_000);
  expect(acknowledgment).toBeEnabled();
  expect(acknowledgment).toBeChecked();
  expect(acknowledgment).toHaveFocus();
  expect(submit).toBeDisabled();
  await act(async () => finishBrowse({ offers: loans, now: chainNow, blockNumber, paused: false, nextCursor: null }));
  expect(acknowledgment).toBeEnabled();
  expect(acknowledgment).toBeChecked();
  expect(submit).toBeEnabled();
});

test("refreshes an offer opened while its background market read is in flight", async () => {
  connected();
  loans.push({ ...baseLoan, id: 3n });
  firstPage = [2n, 3n];
  await loaded();
  let finishBrowse!: (page: OfferPage) => void;
  mocks.browse.mockImplementationOnce(() => new Promise<OfferPage>(resolve => { finishBrowse = resolve; }));
  loans[1] = { ...loans[1]!, status: "active", borrower: "0x9999999999999999999999999999999999999999", dueAt: NOW + 1000 };
  chainNow += 30;
  blockNumber++;
  await advance(30_000);
  fireEvent.click(within(screen.getByRole("article", { name: "SLV offer 3" })).getByRole("button", { name: "Review loan" }));
  expect(screen.getByRole("button", { name: "Accept loan" })).toBeDisabled();
  await act(async () => finishBrowse({
    offers: [loans[0]!], now: chainNow, blockNumber, paused: false, nextCursor: null,
  }));
  expect(mocks.getLoan).toHaveBeenCalledWith(3n);
  expect(screen.getByText("Active loan")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Accept loan" })).not.toBeInTheDocument();
});

test("keeps a selected older offer gated when retry cannot verify the loan", async () => {
  const walletRequest = vi.fn();
  mocks.session = { account: BORROWER, provider: { request: walletRequest } };
  loans.push({ ...baseLoan, id: 1n, createdAt: NOW - 200 });
  open(1n);
  await loaded();
  fireEvent.click(screen.getByRole("checkbox", { name: /I must repay/ }));
  expect(screen.getByRole("button", { name: "Accept loan" })).toBeEnabled();
  mocks.getLoan.mockRejectedValue(new Error("Selected loan cannot be verified."));
  await advance(30_000);
  expect(screen.getByRole("button", { name: "Accept loan" })).toBeDisabled();
  const attempts = mocks.getLoan.mock.calls.length;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry failed markets" })));
  expect(mocks.getLoan).toHaveBeenCalledTimes(attempts + 1);
  expect(mocks.getLoan).toHaveBeenLastCalledWith(1n);
  expect(screen.getByText(/1 market needs a retry/)).toBeInTheDocument();
  expect(screen.getByText(/SLV: Selected loan cannot be verified/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Accept loan" })).toBeDisabled();
  expect(walletRequest).not.toHaveBeenCalled();
});

test("preserves loaded public pages and updates old offers without resetting pagination", async () => {
  loans.push({ ...baseLoan, id: 1n, createdAt: NOW - 200 });
  await loaded();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load older funded offers" })));
  expect(screen.getAllByRole("button", { name: "Review loan" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Load older funded offers" })).not.toBeInTheDocument();
  await advance(30_000);
  expect(screen.getAllByRole("button", { name: "Review loan" })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Load older funded offers" })).not.toBeInTheDocument();
  expect(mocks.getLoan).toHaveBeenCalledWith(1n);
  loans[1] = { ...loans[1]!, status: "active", borrower: BORROWER, dueAt: NOW + 1000 };
  await advance(30_000);
  expect(screen.getAllByRole("button", { name: "Review loan" })).toHaveLength(1);
});

test("keeps repayment available on a halted chain, then uses V3's verified final deadline", async () => {
  connected();
  loans[0] = { ...loans[0]!, borrower: BORROWER, status: "active", dueAt: NOW - GRACE - 100,
    repaymentDeadline: NOW + 10, collateralAvailable: loans[0]!.collateral, vault: "0x6666666666666666666666666666666666666666" };
  ownLoans = loans;
  mocks.load.mockResolvedValue({ markets: [{ ...market, version: 3 }], unavailableAssets: [] });
  open();
  await loaded();
  expect(screen.getByRole("button", { name: /^Repay 550 USDG$/ })).toBeEnabled();
  await advance(30_000);
  expect(screen.getByRole("button", { name: /^Repay 550 USDG$/ })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Settle collateral to lender" })).not.toBeInTheDocument();
  chainNow = NOW + 11;
  blockNumber++;
  await advance(30_000);
  expect(screen.queryByRole("button", { name: /^Repay 550 USDG$/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Settle collateral to lender" })).toBeEnabled();
});

test("retains older account history without polling every settled loan or reopening its cursor", async () => {
  connected();
  ownLoans = [{ ...baseLoan, borrower: BORROWER, status: "active", dueAt: NOW + 3600 }];
  olderOwnLoans = [{ ...baseLoan, id: 1n, borrower: BORROWER, status: "repaid" }];
  ownCursor = 2n;
  await loaded();
  fireEvent.click(screen.getByRole("tab", { name: "My loans" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load older loans" })));
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeInTheDocument();
  await advance(30_000);
  expect(screen.getByRole("article", { name: "SLV offer 1" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load older loans" })).not.toBeInTheDocument();
  expect(mocks.getLoan).not.toHaveBeenCalledWith(1n);
});
