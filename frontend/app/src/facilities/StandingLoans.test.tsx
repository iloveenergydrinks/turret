// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StandingLoans } from "./StandingLoans";
import type { FactoryConfig } from "./factory.mjs";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./standing-model", async original => ({ ...await original<object>(), loadStandingAccount: mocks.load }));
const account = "0x1111111111111111111111111111111111111111", other = "0x2222222222222222222222222222222222222222";
const config = { chainId: 31337 } as FactoryConfig;
const base = { entries: [], complete: true, indexedThrough: "100", blockNumber: "100", historyEpoch: 0, nextCursor: null };
beforeEach(() => { vi.clearAllMocks(); }); afterEach(cleanup);
test("partial history is never presented as a wallet with no loans", async () => {
  mocks.load.mockResolvedValue({ ...base, complete: false, indexedThrough: "50" }); render(<StandingLoans config={config} account={account} />);
  expect(await screen.findByRole("button", { name: "Continue checking history" })).toBeInTheDocument(); expect(screen.queryByText("No standing loans or lending balances found for this wallet.")).not.toBeInTheDocument();
});
test("a failed index remains visibly unavailable and refresh restarts the first page", async () => {
  mocks.load.mockRejectedValueOnce(new Error("Loan history changed")).mockResolvedValue(base); render(<StandingLoans config={config} account={account} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("history changed"); fireEvent.click(screen.getByRole("button", { name: "Refresh loans" }));
  expect(await screen.findByText("No standing loans or lending balances found for this wallet.")).toBeInTheDocument(); expect(mocks.load).toHaveBeenLastCalledWith(config, account, undefined, undefined);
});
test("borrower positions lead to repayment even after an offer has expired", async () => {
  mocks.load.mockResolvedValue({ ...base, entries: [{ chainId: 31337, address: other, lender: other, collateralToken: other, collateralSymbol: "PONS" }] });
  render(<StandingLoans config={config} account={account} />);
  expect(await screen.findByRole("heading", { name: "Borrowed against PONS" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Loans and repayments" })).toHaveAttribute("href", `/borrow/p2p?facility=${other}&intent=loans`);
});
