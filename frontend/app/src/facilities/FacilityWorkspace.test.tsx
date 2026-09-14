// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FacilityWorkspace, type FacilityWorkspaceProps } from "./FacilityWorkspace";
import { drawAmounts, quoteDigest, ZERO_ADDRESS, ZERO_HASH, type SignedQuote } from "./quotes.mjs";
import type { DrawReview, FacilityClient } from "./client";
import type { FacilityMarket } from "./ui-model";
import type { FacilityProgress } from "./wallet-transactions";

const lender = "0x1111111111111111111111111111111111111111", borrower = "0x2222222222222222222222222222222222222222";
const market: FacilityMarket = {
  chainId: 31337, address: "0x3333333333333333333333333333333333333333", lender,
  loanToken: "0x4444444444444444444444444444444444444444", collateralToken: "0x5555555555555555555555555555555555555555",
  feeRecipient: "0x6666666666666666666666666666666666666666", feeBps: "1000", vaultImplementation: "0x7777777777777777777777777777777777777777",
  runtimeHash: ZERO_HASH, vaultImplementationHash: ZERO_HASH, collateralSymbol: "MEME", collateralDecimals: 18, loanDecimals: 6, startBlock: "0",
};
let envelope: SignedQuote;
let props: FacilityWorkspaceProps;
let reviewDraw: ReturnType<typeof vi.fn>, draw: ReturnType<typeof vi.fn>, fundingState: ReturnType<typeof vi.fn>;
const now = () => BigInt(Math.floor(Date.now() / 1000));
const funding = () => ({ idleCash: 500_000000n, cash: 500_000000n, activePrincipal: 200_000000n, unresolvedDefaultPrincipal: 0n,
  epoch: 1n, quoteSigner: ZERO_ADDRESS, paused: false, timestamp: now(), limits: { maxExposure: 1000_000000n, minDraw: 1_000000n, maxDraw: 300_000000n,
    minDuration: 86400n, maxDuration: 30n * 86400n, maxQuoteLifetime: 3600n, minCollateralPerPrincipalWad: 10n ** 30n, minInterestBps: 100n } });
function row(value: SignedQuote) { return { id: quoteDigest(value), envelope: value, availability: { status: "available" as const, reason: null, borrowerEligible: true, capacity: 300_000000n, minDraw: 1_000000n, maxDraw: 300_000000n } }; }
function click(name: string | RegExp) { const button = screen.getByRole("button", { name }); button.focus(); fireEvent.click(button); }
async function reviewLoan() {
  fireEvent.change(screen.getByLabelText("You receive · USDG"), { target: { value: "100" } });
  click("Review loan");
  await screen.findByRole("heading", { name: "Review your loan" });
}
beforeEach(() => {
  localStorage.clear();
  envelope = { schemaVersion: 1, chainId: 31337, facility: market.address, signature: "0x", quote: { epoch: "1", nonce: "1", borrower: ZERO_ADDRESS,
    capacity: "300000000", minDraw: "1000000", collateralForCapacity: "600000000000000000000", interestForCapacity: "15000000",
    duration: "604800", validAfter: String(now()), expiresAt: String(now() + 600n) } };
  reviewDraw = vi.fn(async (value: SignedQuote, principal: bigint): Promise<DrawReview> => ({ envelope: value, account: borrower, digest: quoteDigest(value),
    ...drawAmounts(value, principal, 1000n), minDraw: 1_000000n, maxDraw: 300_000000n, availableCapital: 300_000000n, checkedAt: Date.now(),
    blockNumber: 1n, blockHash: ZERO_HASH, feeBps: 1000n, collateralBalance: 1000n * 10n ** 18n, allowance: 0n, nativeBalance: 1n }));
  draw = vi.fn().mockResolvedValue(undefined); fundingState = vi.fn().mockImplementation(async () => funding());
  props = { market, account: borrower, provider: { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() }, wrongChain: false, loading: false, error: null, refresh: vi.fn(), connect: vi.fn(),
    directory: { checkedAt: Date.now(), capacity: 300_000000n, quotes: [row(envelope)] },
    client: { reviewDraw, draw, fundingState, transactions: { reconcile: vi.fn() } } as unknown as FacilityClient };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("lenders see their actual funding balance, not borrower-filtered availability", async () => {
  render(<FacilityWorkspace {...props} account={lender} initialTab="lend" directory={{ checkedAt: Date.now(), capacity: 0n, quotes: [] }} />);
  expect(screen.getByRole("heading", { name: "Lend against MEME" })).toBeInTheDocument();
  expect(screen.getByText("Your lender account")).toBeInTheDocument();
  expect(screen.queryByText(/USDG available across these terms/)).not.toBeInTheDocument();
  await screen.findByText("Idle USDG");
  expect(within(screen.getByText("Idle USDG").parentElement!).getByText("500")).toBeInTheDocument();
});

test("review shows exact repayment, clears checking feedback and requires consent before a single draw", async () => {
  render(<FacilityWorkspace {...props} />);
  await reviewLoan();
  expect(screen.queryByText("Checking your wallet and current loan state…")).not.toBeInTheDocument();
  expect(within(screen.getByText("Total repayment · USDG").parentElement!).getByText("105")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Approve collateral and borrow 100 USDG" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  click("Approve collateral and borrow 100 USDG");
  await screen.findByText(/Loan confirmed\. Your USDG/);
  expect(draw).toHaveBeenCalledTimes(1);
  expect(draw.mock.calls[0]![1]).toMatchObject({ principal: 100_000000n, repayment: 105_000000n, digest: quoteDigest(envelope) });
  expect(screen.queryByRole("button", { name: /Approve collateral and borrow/ })).not.toBeInTheDocument();
});

test("wallet progress and a rejected draw stay beside the loan action; a fresh review is required", async () => {
  let reject!: (error: Error) => void;
  draw.mockImplementation((_provider, _review, progress: FacilityProgress) => {
    progress({ status: "signature", message: "Confirm collateral approval in MetaMask." });
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  render(<FacilityWorkspace {...props} />); await reviewLoan();
  fireEvent.click(screen.getByRole("checkbox")); click("Approve collateral and borrow 100 USDG");
  const message = await screen.findByText("Confirm collateral approval in MetaMask.");
  expect(message.closest("form")).toHaveClass("facility-loan-form");
  expect(screen.getByRole("button", { name: "Review loan" })).toBeDisabled();
  await act(async () => { reject(new Error("User rejected the wallet request.")); });
  const alert = screen.getByRole("alert");
  expect(alert.closest("form")).toHaveClass("facility-loan-form");
  expect(alert).toHaveTextContent("User rejected the wallet request.");
  expect(screen.getByRole("button", { name: "Review loan" })).toBeEnabled();
  expect(draw).toHaveBeenCalledTimes(1);
});

test("replacing the selected offer invalidates its review and consent", async () => {
  const view = render(<FacilityWorkspace {...props} />); await reviewLoan();
  fireEvent.click(screen.getByRole("checkbox"));
  const replacement = { ...envelope, quote: { ...envelope.quote, nonce: "2", duration: "1209600", interestForCapacity: "24000000" } };
  view.rerender(<FacilityWorkspace {...props} directory={{ ...props.directory!, quotes: [row(replacement)] }} />);
  expect(screen.queryByRole("heading", { name: "Review your loan" })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(draw).not.toHaveBeenCalled();
  click("Review loan"); await screen.findByRole("heading", { name: "Review your loan" });
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(reviewDraw.mock.calls[1]![0]).toEqual(replacement);
});

test("switching accounts clears the review without executing it", async () => {
  const view = render(<FacilityWorkspace {...props} />); await reviewLoan();
  view.rerender(<FacilityWorkspace {...props} account={lender} />);
  expect(screen.queryByRole("heading", { name: "Review your loan" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("You receive · USDG")).toHaveValue("");
  expect(draw).not.toHaveBeenCalled();
});

test("an expired review cannot be revived by refreshing the directory", async () => {
  vi.useFakeTimers();
  const view = render(<FacilityWorkspace {...props} />);
  fireEvent.change(screen.getByLabelText("You receive · USDG"), { target: { value: "100" } });
  await act(async () => { click("Review loan"); });
  expect(screen.getByRole("heading", { name: "Review your loan" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => { vi.advanceTimersByTime(31000); });
  view.rerender(<FacilityWorkspace {...props} directory={{ ...props.directory!, checkedAt: Date.now() }} />);
  expect(screen.queryByRole("heading", { name: "Review your loan" })).not.toBeInTheDocument();
  expect(draw).not.toHaveBeenCalled();
});

test("unavailable quotes never appear as an empty market", () => {
  const view = render(<FacilityWorkspace {...props} error="RPC verification unavailable" />);
  expect(screen.getByRole("heading", { name: "Availability needs a fresh check" })).toBeInTheDocument();
  expect(screen.queryByText("No funded terms available")).not.toBeInTheDocument();
  view.rerender(<FacilityWorkspace {...props} directory={{ checkedAt: Date.now(), capacity: 0n, quotes: [] }} />);
  expect(screen.getByRole("heading", { name: "No funded terms available" })).toBeInTheDocument();
});

test("a failed lender refresh marks retained balances as old", async () => {
  render(<FacilityWorkspace {...props} account={lender} initialTab="lend" />);
  await screen.findByRole("heading", { name: "Your lending balance" });
  fundingState.mockRejectedValue(new Error("RPC offline"));
  click("Refresh");
  expect(await screen.findByRole("alert")).toHaveTextContent("figures below are from the previous check");
});

test("partial loan scanning does not claim the wallet has no loans", async () => {
  props.client.loanPage = vi.fn().mockImplementation(async (_account, cursor) => ({ rows: [], checked: 10, nextCursor: cursor === undefined ? 10n : null }));
  render(<FacilityWorkspace {...props} initialTab="loans" />);
  await screen.findByText("No loans for your wallet in these recent results. Check older loans below.");
  expect(screen.queryByText("You have no loans in this lending balance.")).not.toBeInTheDocument();
  click("Check older loans");
  await waitFor(() => expect(props.client.loanPage).toHaveBeenCalledWith(borrower, 10n));
  await screen.findByText("You have no loans in this lending balance.");
});

test("index catch-up remains visibly incomplete and updates pagination when older loans appear", async () => {
  props.client.loanPage = vi.fn().mockResolvedValue({ rows: [], checked: 0, nextCursor: null, indexComplete: false, historyEpoch: 0 });
  render(<FacilityWorkspace {...props} initialTab="loans" />);
  await screen.findByText(/Loan history is still syncing/);
  expect(screen.queryByText("You have no loans in this lending balance.")).not.toBeInTheDocument();
  vi.mocked(props.client.loanPage).mockResolvedValue({ rows: [], checked: 0, nextCursor: 21n, indexComplete: true, historyEpoch: 0 });
  click("Refresh");
  await screen.findByRole("button", { name: "Check older loans" });
  expect(screen.queryByText(/Loan history is still syncing/)).not.toBeInTheDocument();
});

test("a changed history epoch discards loan rows from an orphaned chain", async () => {
  props.client.loanPage = vi.fn().mockResolvedValue({ rows: [{ id: 1n, borrower, principal: 1_000000n, interest: 100000n, dueAt: now() + 86400n, status: 1 }], checked: 1, nextCursor: null, indexComplete: true, historyEpoch: 0 });
  render(<FacilityWorkspace {...props} initialTab="loans" />);
  await screen.findByRole("button", { name: /Loan #1/ });
  vi.mocked(props.client.loanPage).mockResolvedValue({ rows: [], checked: 0, nextCursor: null, indexComplete: true, historyEpoch: 1 });
  click("Refresh");
  await waitFor(() => expect(screen.queryByRole("button", { name: /Loan #1/ })).not.toBeInTheDocument());
  expect(screen.getByText("You have no loans in this lending balance.")).toBeInTheDocument();
});

test("failed publication retains the signed authorization and retries without another wallet signature", async () => {
  props.client.reviewQuote = vi.fn().mockResolvedValue({ envelope, account: lender, feeBps: 1000n, paused: false });
  props.client.signQuote = vi.fn().mockResolvedValue(envelope);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: "Publication unavailable" }), { status: 503 }))
    .mockResolvedValue(new Response(JSON.stringify({ id: quoteDigest(envelope) })));
  vi.stubGlobal("fetch", fetcher);
  render(<FacilityWorkspace {...props} account={lender} initialTab="lend" />);
  await screen.findByRole("heading", { name: "Your lending balance" });
  for (const [label, value] of [["Total quote capacity · USDG", "300"], ["Collateral for full capacity · MEME", "600"], ["Interest for full capacity · USDG", "15"]]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  click("Review lending terms");
  await screen.findByRole("heading", { name: "Review authorization" });
  fireEvent.click(screen.getByLabelText(/I authorize lending my deposited USDG/));
  click("Sign and publish terms");
  expect(await screen.findByRole("alert")).toHaveTextContent("Publication unavailable");
  expect(JSON.parse(localStorage.getItem(`turret:facility:signed:31337:${market.address}:${lender}`)!)).toEqual(envelope);
  expect(screen.getByText(/A valid signature authorizes loans even if publication failed/)).toBeInTheDocument();
  click("Retry publishing this signature");
  await screen.findByText("Signed quote published.");
  expect(props.client.signQuote).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]![1].body).toBe(JSON.stringify(envelope));
});

test("extension consent is bound to the displayed proposal and expires when that proposal changes", async () => {
  const dueAt = now() + 604800n;
  props.client.loanPage = vi.fn().mockResolvedValue({ rows: [{ id: 1n, borrower, principal: 100_000000n, interest: 5_000000n, dueAt, status: 1 }], checked: 1, nextCursor: null });
  props.client.loan = vi.fn().mockResolvedValue({ id: 1n, borrower, vault: market.vaultImplementation, principal: 100_000000n, collateralAmount: 200n * 10n ** 18n,
    interest: 5_000000n, dueAt, status: 1, lenderCredit: 0n, feeCredit: 0n, collateralCredit: 0n, defaultAcknowledged: false });
  props.client.loanCredits = vi.fn().mockResolvedValue({ repayment: 0n, fee: 0n, collateral: 0n });
  const proposal = [lender, 1n, dueAt + 86400n, dueAt + 172800n, now() + 3600n] as const;
  props.client.extension = vi.fn().mockResolvedValue(proposal);
  props.client.acceptExtension = vi.fn().mockResolvedValue(undefined);
  render(<FacilityWorkspace {...props} initialTab="loans" />);
  await screen.findByRole("button", { name: /Loan #1/ }); click(/Loan #1/);
  const checkbox = await screen.findByLabelText("Accept this exact later deadline with unchanged interest.");
  fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Accept extension" })).toBeEnabled();
  const changed = [lender, 2n, proposal[2], dueAt + 259200n, proposal[4]] as const;
  vi.mocked(props.client.extension).mockResolvedValue(changed);
  click("Refresh");
  await waitFor(() => expect(checkbox).not.toBeChecked());
  expect(screen.getByRole("button", { name: "Accept extension" })).toBeDisabled();
  fireEvent.click(checkbox); click("Accept extension");
  await screen.findByText("New repayment deadline confirmed.");
  expect(props.client.acceptExtension).toHaveBeenCalledWith(props.provider, 1n, ...changed.slice(1), expect.any(Function));
});

test("changing wallets clears the previous account's loan rows immediately", async () => {
  const loanPage = vi.fn(async (account: string) => ({ rows: account === borrower ? [{ id: 1n, borrower, principal: 100_000000n, interest: 5_000000n, dueAt: now() + 600n, status: 1 }] : [], checked: 1, nextCursor: null, indexComplete: true, historyEpoch: 0 }));
  props.client = { ...props.client, loanPage } as unknown as FacilityClient;
  const view = render(<FacilityWorkspace {...props} initialTab="loans" />);
  await screen.findByText("Loan #1"); view.rerender(<FacilityWorkspace {...props} account="0x8888888888888888888888888888888888888888" initialTab="loans" />);
  expect(screen.queryByText("Loan #1")).not.toBeInTheDocument(); await screen.findByText("You have no loans in this lending balance.");
});

test("an unavailable deep-linked quote is never silently replaced with another lender authorization", async () => {
  window.history.replaceState(null, "", "/?quote=0xmissing");
  try { render(<FacilityWorkspace {...props} />); expect(screen.getByRole("heading", { name: "This offer is no longer available" })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Review loan" })).not.toBeInTheDocument(); click("Choose other terms"); expect(screen.getByRole("button", { name: "Review loan" })).toBeInTheDocument(); }
  finally { window.history.replaceState(null, "", "/"); }
});
