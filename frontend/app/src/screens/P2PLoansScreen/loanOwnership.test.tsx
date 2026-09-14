// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { LoanOwnership, ZERO_ADDRESS } from "./loanPresentation";
import type { Offer } from "./loanPresentation";
const lender = "0x1111111111111111111111111111111111111111";
const borrower = "0x2222222222222222222222222222222222222222";
const offer: Offer = {
  market: { version: 3, chainId: 4663, chainName: "Robinhood", rpcUrl: "/api/rpc", address: lender,
    loanToken: lender, collateralToken: borrower, loanSymbol: "USDG", collateralSymbol: "MSFT",
    loanDecimals: 6, collateralDecimals: 18, runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1" },
  loan: { id: 1n, isPublic: true, createdAt: 1, lender, borrower: ZERO_ADDRESS, principal: 50_000_000n,
    collateral: 220000000000000000n, interest: 1_000_000n, durationDays: 30, expiresAt: 1000, dueAt: 0,
    status: "open", fundingAvailable: 50_000_000n },
};
afterEach(cleanup);
test("lenders see they supply money, not receive it", () => {
  render(<LoanOwnership offer={offer} account={lender.toUpperCase()} now={100} />);
  expect(screen.getByRole("heading")).toHaveTextContent("You are the lender");
  expect(screen.getByText(/You do not receive 50 USDG/)).toBeVisible();
  expect(screen.getByText(/No borrower has received this loan yet/)).toBeVisible();
  expect(screen.getByText(/The borrower pays 51 USDG/)).toBeVisible();
});
test("disconnected visitors are not assigned a role", () => {
  render(<LoanOwnership offer={offer} now={100} />);
  expect(screen.getByRole("heading")).toHaveTextContent("Who lends, who borrows?");
});
test("active borrowers see debt and custody", () => {
  render(<LoanOwnership offer={{ ...offer, loan: { ...offer.loan, borrower, status: "active", dueAt: 500, repaymentDeadline: 600 } }} account={borrower} now={100} />);
  expect(screen.getByRole("heading")).toHaveTextContent("You are the borrower");
  expect(screen.getByText(/The borrower received 50 USDG/)).toBeVisible();
  expect(screen.queryByText("When someone accepts")).not.toBeInTheDocument();
});
test("overdue loans no longer promise repayment", () => {
  render(<LoanOwnership offer={{ ...offer, loan: { ...offer.loan, borrower, status: "active", dueAt: 500, repaymentDeadline: 600 } }} account={lender} now={601} />);
  expect(screen.getByText(/Repayment is no longer available/)).toBeVisible();
});
test.each(["repaid", "claimed", "cancelled", "expired"] as const)("%s explains separate withdrawals", status => {
  render(<LoanOwnership offer={{ ...offer, loan: { ...offer.loan, status } }} account={lender} now={100} />);
  expect(screen.getByText(/Check withdrawal balances/)).toBeVisible();
  expect(screen.queryByText("When someone accepts")).not.toBeInTheDocument();
});
test.each([undefined, 1n])("missing or short funding does not claim full principal is held", fundingAvailable => {
  render(<LoanOwnership offer={{ ...offer, loan: { ...offer.loan, fundingAvailable } }} account={lender} now={100} />);
  expect(screen.queryByText(/50 USDG is held/)).not.toBeInTheDocument();
  expect(screen.getByText(fundingAvailable === undefined ? /could not be verified/ : /cannot be accepted/)).toBeVisible();
});
