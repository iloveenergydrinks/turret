// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Address, EIP1193Provider } from "viem";
import type { Deployment, Loan, P2PClient } from "../../p2p/client";
import { V3CreditRepayment, V3Extension, V3LoanCredit, type V3Action } from "./V3LoanActions";
import { finalDeadline, loanState } from "./loanPresentation";
import { parseUtcInput, planCreditRepayment } from "./v3Terms";
import { loadedP2PCredits } from "../../portfolio/model";
const borrower: Address = "0x1111111111111111111111111111111111111111";
const lender: Address = "0x2222222222222222222222222222222222222222";
const market: Deployment = { chainId: 31337, chainName: "Local", address: "0x3333333333333333333333333333333333333333", loanToken: "0x4444444444444444444444444444444444444444", collateralToken: "0x5555555555555555555555555555555555555555", loanDecimals: 6, collateralDecimals: 18, loanSymbol: "USDG", collateralSymbol: "AAPL", rpcUrl: "/rpc", runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1", version: 3 };
const now = Date.parse("2026-09-08T12:00:00Z") / 1000;
const empty = { beneficiary: borrower, nominal: 0n, available: 0n };
const loan: Loan = { id: 10n, lender, borrower, isPublic: true, createdAt: now - 200_000, dueAt: now - 90_000, repaymentDeadline: now + 10_000, principal: 100_000_000n, interest: 5_000_000n, collateral: 10n ** 18n, durationDays: 1, expiresAt: now - 190_000, status: "active", vault: "0x6666666666666666666666666666666666666666", loanCredits: { USDG: empty, COLLATERAL: empty } };
const creditLoan = (id: bigint, nominal: bigint, available = nominal, beneficiary = borrower): Loan => ({ ...loan, id, status: "cancelled", loanCredits: { USDG: { beneficiary, nominal, available }, COLLATERAL: empty } });
afterEach(cleanup);
function actions() {
  const methods = { withdrawCredit: vi.fn(), withdrawAvailableCredit: vi.fn(), repayWithCredits: vi.fn(), proposeExtension: vi.fn(), acceptExtension: vi.fn(), cancelExtension: vi.fn() };
  const provider = { request: vi.fn(), on: vi.fn(), removeListener: vi.fn() } as EIP1193Provider;
  const stage = vi.fn();
  const run = vi.fn((action: V3Action) => { void action(methods as unknown as P2PClient, provider, stage); });
  return { methods, provider, stage, run };
}

test("UTC input rejects normalized dates and is independent of local timezone", () => {
  expect(parseUtcInput("2026-09-08T12:30")).toBe(Date.parse("2026-09-08T12:30:00Z") / 1000);
  for (const value of ["2026-02-30T12:00", "2026-09-08T25:00", "2026-09-08", "2026-09-08T12:30Z", ""]) expect(() => parseUtcInput(value)).toThrow();
});
test("an agreed extension changes default eligibility and leaves the original due date intact", () => {
  expect(finalDeadline(loan)).toBe(now + 10_000);
  expect(loanState(loan, now)).toBe("Extended · repayment due");
  expect(loanState(loan, now + 10_001)).toBe("Default · collateral claimable");
  expect(finalDeadline({ dueAt: now })).toBe(now + 86_400);
});
test("credit repayment uses actual own balances, ascending distinct IDs and exact full debt", () => {
  const plan = planCreditRepayment([creditLoan(9n, 80n, 20n), creditLoan(3n, 40n), creditLoan(3n, 40n), creditLoan(4n, 1000n, 1000n, lender), creditLoan(10n, 1000n)], borrower, 10n, 100n);
  expect(plan).toEqual({ sourceIds: [3n, 9n], sourceAmounts: [40n, 20n], walletAmount: 40n, creditAmount: 60n });
});
test("credit repayment respects the 16-source limit and preserves the remaining obligation", () => {
  const plan = planCreditRepayment(Array.from({ length: 20 }, (_, i) => creditLoan(BigInt(i + 1), 1n)), borrower, 100n, 19n);
  expect(plan.sourceIds).toHaveLength(16); expect(plan.walletAmount).toBe(3n);
  expect(plan.sourceAmounts.reduce((sum, value) => sum + value, plan.walletAmount)).toBe(19n);
});
test("Portfolio distinguishes available credit from complete token loss", () => {
  const result = loadedP2PCredits({ id: "v3", kind: "p2p", symbol: "AAPL", name: "Apple", legacy: false, deployment: market, read: vi.fn() }, { kind: "p2p", account: borrower, now, blockNumber: 1n, nextCursor: null, offers: [creditLoan(1n, 100n, 0n), creditLoan(2n, 20n, 10n), creditLoan(3n, 99n, 99n, lender)], credits: { USDG: 999n, COLLATERAL: 0n } });
  expect(result).toEqual({ available: { USDG: 10n, COLLATERAL: 0n }, shortfall: { USDG: 110n, COLLATERAL: 0n }, unavailable: false });
});
test("a shortfall permits partial recovery and requires separate explicit writeoff consent", () => {
  const { methods, run, provider, stage } = actions();
  const props = { market, loan: creditLoan(1n, 100_000_000n, 60_000_000n), account: borrower, disabled: false, run, token: "USDG" as const, recipient: borrower };
  const view = render(<V3LoanCredit {...props} />);
  expect(screen.getByText("Token shortfall")).toBeVisible();
  expect(screen.getByRole("button", { name: "Withdraw available and write off rest" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw available, keep unpaid credit" }));
  expect(methods.withdrawCredit).toHaveBeenCalledWith(provider, 1n, "USDG", 60_000_000n, borrower, stage);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Withdraw available and write off rest" }));
  expect(methods.withdrawAvailableCredit).toHaveBeenCalledWith(provider, 1n, "USDG", 60_000_000n, borrower, stage);
  view.rerender(<V3LoanCredit {...props} recipient={lender} />);
  expect(screen.getByRole("button", { name: "Withdraw available and write off rest" })).toBeDisabled();
});
test("changing the available amount invalidates writeoff consent", () => {
  const { run } = actions();
  const props = { market, loan: creditLoan(1n, 100n, 60n), account: borrower, disabled: false, run, token: "USDG" as const, recipient: borrower };
  const view = render(<V3LoanCredit {...props} />);
  fireEvent.click(screen.getByRole("checkbox")); view.rerender(<V3LoanCredit {...props} loan={creditLoan(1n, 100n, 40n)} />);
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Withdraw available and write off rest" })).toBeDisabled();
});
test("withdrawal cannot target the manager or vault or spend another beneficiary's credit", () => {
  const { run } = actions();
  const props = { market, loan: creditLoan(1n, 100n), account: borrower, disabled: false, run, token: "USDG" as const, recipient: market.address };
  const view = render(<V3LoanCredit {...props} />);
  expect(screen.getByRole("button", { name: "Withdraw USDG" })).toBeDisabled();
  view.rerender(<V3LoanCredit {...props} recipient={loan.vault!} />);
  expect(screen.getByRole("button", { name: "Withdraw USDG" })).toBeDisabled();
  view.rerender(<V3LoanCredit {...props} account={lender} />);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
test("full repayment with credits reviews exact sources and wallet remainder", () => {
  const { methods, run, provider, stage } = actions();
  render(<V3CreditRepayment market={market} loan={loan} account={borrower} disabled={false} run={run} loans={[creditLoan(1n, 70_000_000n)]} walletBalance={35_000_000n} />);
  const button = screen.getByRole("button", { name: "Repay with credits" });
  expect(button).toBeVisible(); expect(button.closest("details")).toBeNull();
  expect(button).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { hidden: true })); fireEvent.click(button);
  expect(methods.repayWithCredits).toHaveBeenCalledWith(provider, 10n, [1n], [70_000_000n], 35_000_000n, stage);
});
test("extension acceptance pins the terms and invalidates consent after proposal changes", () => {
  const { methods, run, provider, stage } = actions();
  const proposal = { proposer: lender, nonce: 1n, oldDeadline: loan.repaymentDeadline!, newDeadline: now + 200_000, expiresAt: now + 5000 };
  const props = { market, loan: { ...loan, extensionProposal: proposal }, account: borrower, disabled: false, run, now };
  const view = render(<V3Extension {...props} />);
  const button = screen.getByRole("button", { name: "Accept deadline extension" });
  expect(button).toBeVisible(); expect(button.closest("details")).toBeNull();
  expect(button).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { hidden: true })); fireEvent.click(button);
  expect(methods.acceptExtension).toHaveBeenCalledWith(provider, loan.id, proposal, stage);
  view.rerender(<V3Extension {...props} loan={{ ...loan, extensionProposal: { ...proposal, nonce: 2n, newDeadline: now + 300_000 } }} />);
  expect(screen.getByRole("button", { name: "Accept deadline extension" })).toBeDisabled();
});
test("the proposer can cancel but cannot accept their own extension", () => {
  const { methods, run, provider, stage } = actions();
  render(<V3Extension market={market} loan={{ ...loan, extensionProposal: { proposer: borrower, nonce: 2n, oldDeadline: loan.repaymentDeadline!, newDeadline: now + 200_000, expiresAt: now + 5000 } }} account={borrower} disabled={false} run={run} now={now} />);
  expect(screen.queryByRole("button", { name: "Accept deadline extension" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel extension proposal" }));
  expect(methods.cancelExtension).toHaveBeenCalledWith(provider, loan.id, 2n, stage);
});
test("an overdue unclaimed loan can propose exact UTC extension dates", () => {
  const { methods, run, provider, stage } = actions();
  render(<V3Extension market={market} loan={{ ...loan, repaymentDeadline: now - 1 }} account={borrower} disabled={false} run={run} now={now} />);
  fireEvent.change(screen.getByLabelText("New final deadline · UTC"), { target: { value: "2026-09-10T12:00" } });
  fireEvent.change(screen.getByLabelText("Proposal expires · UTC"), { target: { value: "2026-09-09T12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review extension" })); expect(methods.proposeExtension).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm extension proposal" }));
  expect(methods.proposeExtension).toHaveBeenCalledWith(provider, loan.id, parseUtcInput("2026-09-10T12:00"), parseUtcInput("2026-09-09T12:00"), stage);
});

test("an unreadable token credit is shown as unavailable while the other token remains withdrawable", () => {
  const { run } = actions();
  render(<V3LoanCredit market={market} loan={{ ...loan, loanCredits: { USDG: { ...empty, unavailable: true }, COLLATERAL: empty } }} account={borrower} disabled={false} run={run} token="USDG" recipient={borrower} />);
  expect(screen.getByRole("status")).toHaveTextContent("credit balance unavailable");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByText("0 USDG available")).not.toBeInTheDocument();
});

test("an unreadable wallet balance still permits repayment fully covered by verified credits", () => {
  const { methods, run, provider, stage } = actions();
  const props = { market, loan, account: borrower, disabled: false, run, loans: [creditLoan(1n, 105_000_000n)], walletBalance: 0n, walletBalanceUnavailable: true };
  const view = render(<V3CreditRepayment {...props} />);
  fireEvent.click(screen.getByRole("checkbox", { hidden: true }));
  fireEvent.click(screen.getByRole("button", { name: "Repay with credits" }));
  expect(methods.repayWithCredits).toHaveBeenCalledWith(provider, loan.id, [1n], [105_000_000n], 0n, stage);
  view.rerender(<V3CreditRepayment {...props} loans={[creditLoan(1n, 100_000_000n)]} />);
  fireEvent.click(screen.getByRole("checkbox", { hidden: true }));
  expect(screen.getByRole("button", { name: "Repay with credits" })).toBeDisabled();
});
