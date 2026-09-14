// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LenderSetup, StandingDirectory } from "./StandingPage";
import { ZERO_HASH } from "./quotes.mjs";
import type { FactoryConfig } from "./factory.mjs";
import type { Deployment } from "../p2p/client";
const mocks = vi.hoisted(() => ({ session: {} as any, existing: vi.fn(), qualify: vi.fn(), execute: vi.fn(), reconcile: vi.fn(), register: vi.fn(), page: vi.fn(), quotes: vi.fn() }));
vi.mock("../wallet/useWalletSession", () => ({ useWalletSession: () => mocks.session }));
vi.mock("../comps/AppLayout/AccountButton", () => ({ AccountButton: () => null }));
vi.mock("../borrow/BorrowPageHeader", () => ({ BorrowPageHeader: () => null }));
vi.mock("../p2p/P2PAppLayout", () => ({ P2PAppLayout: ({ children }: any) => children }));
vi.mock("./standing-model", async original => ({ ...await original<object>(), makeStandingClient: () => ({ existing: mocks.existing, qualify: mocks.qualify, transactions: { execute: mocks.execute, reconcile: mocks.reconcile } }), registerStandingFacility: mocks.register, loadStandingPage: mocks.page }));
vi.mock("./ui-model", async original => ({ ...await original<object>(), loadFacilityQuotes: mocks.quotes }));
const a = (n: number) => `0x${String(n).padStart(40, "0")}` as const;
const market: Deployment = { chainId: 31337, chainName: "Test", rpcUrl: "http://localhost/api/rpc", address: a(8), collateralToken: a(4), collateralSymbol: "PONS", collateralName: "Pons", collateralDecimals: 18, loanToken: a(3), loanSymbol: "USDG", loanDecimals: 6, version: 3, runtimeHash: ZERO_HASH, startBlock: "1" };
const config = { chainId: 31337, factory: a(9), collateral: [{ address: a(4), symbol: "PONS", name: "Pons", decimals: 18 }] } as FactoryConfig;
const entry = { ...market, address: a(1), lender: a(2), feeRecipient: a(2), feeBps: "0", vaultImplementation: a(6), vaultImplementationHash: ZERO_HASH, factory: a(9) };
function choose() { fireEvent.click(screen.getByRole("button", { name: /Lend against/ })); fireEvent.click(screen.getByRole("option", { name: /PONS/ })); }
function fill() {
  choose();
  for (const [label, value] of [["Lending budget · USDG", "1000"], ["Minimum per loan · USDG", "10"], ["Maximum per loan · USDG", "100"], ["Collateral for the maximum loan · PONS", "200"], ["Fixed interest on the maximum loan · USDG", "5"]]) fireEvent.change(screen.getByLabelText(label!), { target: { value } });
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  mocks.session = { account: a(2), chainId: 31337, provider: { request: vi.fn() }, connect: vi.fn(), error: null };
  mocks.existing.mockResolvedValue(null); mocks.qualify.mockResolvedValue(undefined); mocks.execute.mockResolvedValue("0xhash"); mocks.register.mockResolvedValue(entry); mocks.page.mockResolvedValue({ entries: [], nextCursor: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
test("a lender can resume an existing balance without filling new limits or creating another contract", async () => {
  mocks.existing.mockResolvedValue(a(1)); render(<LenderSetup config={config} markets={[market]} />); choose();
  fireEvent.click(screen.getByRole("button", { name: "Review or resume setup" }));
  expect(await screen.findByRole("link", { name: "Continue to funding and terms" })).toHaveAttribute("href", expect.stringContaining(a(1)));
  expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.register).toHaveBeenCalledWith(config, a(1));
});
test("setup shows exact limits, requires acknowledgment, and creates without depositing tokens", async () => {
  mocks.existing.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(a(1));
  render(<LenderSetup config={config} markets={[market]} />); fill(); fireEvent.click(screen.getByRole("button", { name: "Review or resume setup" }));
  expect(await screen.findByRole("heading", { name: "Review your lending limits" })).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Create balance in wallet" }); expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox")); expect(confirm).toBeEnabled(); fireEvent.click(confirm);
  await screen.findByRole("link", { name: "Continue to funding and terms" });
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  const call = mocks.execute.mock.calls[0]![2]; expect(call.functionName).toBe("createFacility"); expect(call.args[1].maxExposure).toBe(1000_000000n);
  expect(mocks.execute.mock.calls[0]![4].approval).toBeUndefined();
  expect(JSON.parse(sessionStorage.getItem(`turret:standing:draft:31337:${a(1)}:${a(2)}`)!)).toMatchObject({ collateral: "2000", interest: "50" });
});
test("wallet transport not ready produces actionable feedback rather than a permanently disabled confirmation", async () => {
  mocks.session.provider = null; render(<LenderSetup config={config} markets={[market]} />); choose();
  const review = screen.getByRole("button", { name: "Review or resume setup" }); expect(review).toBeEnabled(); fireEvent.click(review);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connect your wallet"); expect(mocks.execute).not.toHaveBeenCalled();
});
test("publication failure is retryable without another deployment", async () => {
  mocks.existing.mockResolvedValue(a(1)); mocks.register.mockRejectedValueOnce(new Error("Publication unavailable")).mockResolvedValue(entry);
  render(<LenderSetup config={config} markets={[market]} />); choose(); fireEvent.click(screen.getByRole("button", { name: "Review or resume setup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Publication unavailable"); fireEvent.click(screen.getByRole("button", { name: "Review or resume setup" }));
  await screen.findByRole("link", { name: "Continue to funding and terms" }); expect(mocks.execute).not.toHaveBeenCalled();
});
test("switching account discards the setup review", async () => {
  const view = render(<LenderSetup config={config} markets={[market]} />); fill(); fireEvent.click(screen.getByRole("button", { name: "Review or resume setup" }));
  await screen.findByRole("heading", { name: "Review your lending limits" }); mocks.session = { ...mocks.session, account: a(7) }; view.rerender(<LenderSetup config={config} markets={[market]} />);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Create balance in wallet" })).not.toBeInTheDocument()); expect(mocks.execute).not.toHaveBeenCalled();
});
test("a failed directory does not appear as an empty marketplace", async () => {
  mocks.page.mockRejectedValue(new Error("Standing offers could not be loaded")); render(<StandingDirectory config={config} markets={[market]} account={null} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded"); expect(screen.queryByText("No published offers in this selection")).not.toBeInTheDocument();
});
test("a known lender with unavailable funding does not show a borrow action", async () => {
  mocks.page.mockResolvedValue({ entries: [entry], nextCursor: null }); mocks.quotes.mockRejectedValue(new Error("Funded availability could not be checked"));
  render(<StandingDirectory config={config} markets={[market]} account={null} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Funded availability could not be checked"); expect(screen.queryByRole("link", { name: "Review this offer" })).not.toBeInTheDocument();
});
