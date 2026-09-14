// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Deployment, Loan } from "../../p2p/client";
import { CollateralRecovery, collateralRecovery, collateralReviewKey } from "./CollateralRecovery";
const market = { version: 3, address: "0x123", collateralSymbol: "AAPL", collateralDecimals: 0 } as unknown as Deployment;
const loan = { id: 1n, status: "active", collateral: 10n, collateralAvailable: 6n, principal: 100n, interest: 5n } as Loan;
afterEach(cleanup);
test("shows the exact recoverable collateral and loss before repayment", () => {
  render(<CollateralRecovery market={market} loan={loan} />);
  expect(screen.getByText("6 AAPL")).toBeVisible(); expect(screen.getByText("4 AAPL")).toBeVisible();
  expect(screen.getByText("Collateral shortfall")).toBeVisible();
  expect(collateralReviewKey(market, loan)).not.toBe(collateralReviewKey(market, { ...loan, collateralAvailable: 5n }));
});
test("unavailable reads remain unknown and donations do not increase entitlement", () => {
  render(<CollateralRecovery market={market} loan={{ ...loan, collateralAvailable: undefined }} />);
  expect(screen.getByText("Balance unavailable")).toBeVisible();
  expect(collateralRecovery({ ...loan, collateralAvailable: 20n })).toEqual({ available: 10n, shortfall: 0n });
});
