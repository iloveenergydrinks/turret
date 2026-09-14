// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Address, EIP1193Provider } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Deployment } from "../../p2p/client";
import type { Negotiation, NegotiationSession } from "../../p2p/negotiations";
const mocks = vi.hoisted(() => ({ read: vi.fn(), sign: vi.fn() }));
vi.mock(
  "../../p2p/negotiations",
  async (original) => ({
    ...await original<typeof import("../../p2p/negotiations")>(),
    readNegotiations: mocks.read,
    signNegotiation: mocks.sign,
  }),
);
import { Negotiations } from "./Negotiations";
import { NegotiationEditor } from "./NegotiationTerms";
const borrower = "0x1111111111111111111111111111111111111111" as Address,
  lender = "0x2222222222222222222222222222222222222222" as Address;
const market: Deployment = {
  address: "0x3333333333333333333333333333333333333333",
  chainName: "Local test", rpcUrl: "/api/rpc",
  loanToken: "0x4444444444444444444444444444444444444444",
  collateralToken: "0x5555555555555555555555555555555555555555",
  runtimeHash: `0x${"a".repeat(64)}`, startBlock: "1",
  version: 3,
  chainId: 31337,
  collateralSymbol: "AAPL",
  loanDecimals: 6,
  collateralDecimals: 18,
  loanSymbol: "USDG",
};
const provider = {} as EIP1193Provider;
let row: Negotiation;
const terms = () => ({
  principal: "1000000000",
  collateral: "10000000000000000000",
  interest: "10000000",
  durationDays: 14,
  expiresAt: Math.floor(Date.now() / 1000) + 86400,
});
let session: NegotiationSession;
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  row = {
    id: "11111111-1111-4111-8111-111111111111",
    market: market.address,
    chainId: 31337,
    offerId: "1",
    sourceDigest: "a".repeat(64),
    original: terms(),
    lender,
    borrower,
    revision: 1,
    state: "open",
    createdAt: Date.now() / 1000,
    updatedAt: Date.now() / 1000,
    latest: {
      id: "22222222-2222-4222-8222-222222222222",
      author: lender,
      terms: { ...terms(), interest: "5000000" },
      responseBy: Math.floor(Date.now() / 1000) + 3600,
      createdAt: Date.now() / 1000,
    },
  };
  session = {
    origin: window.location.origin,
    account: borrower,
    token: "a".repeat(64),
    until: Math.floor(Date.now() / 1000) + 3600,
  };
  mocks.sign.mockResolvedValue(session);
  mocks.read.mockImplementation(async (_s, query) =>
    query?.id ? { thread: row, events: [], nextCursor: null } : { threads: [row], nextCursor: null }
  );
});
afterEach(cleanup);
const view = (account = borrower) => (
  <Negotiations markets={[market]} account={account} provider={provider} onConnect={vi.fn()} onOpen={vi.fn()} />
);
async function unlock() {
  fireEvent.click(screen.getByRole("button", { name: "Unlock conversations" }));
  await screen.findByRole("button", { name: /AAPL offer #1/ });
  await waitFor(() => expect(screen.getByRole("button", { name: /AAPL offer #1/ })).toBeEnabled());
}
async function open() {
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: /AAPL offer #1/ }));
  await screen.findByRole("button", { name: "Agree to these terms" });
}
test("shows exact original and proposed terms, then signs the displayed proposal and parties", async () => {
  render(view());
  await open();
  expect(screen.getByRole("table")).toHaveTextContent("1005 USDG");
  mocks.sign.mockImplementation(async (_p, _a, _m, action) => {
    expect(action.context.proposalTerms).toEqual(row.latest.terms);
    expect(action.context.borrower).toBe(borrower);
    return { thread: { ...row, state: "agreed", revision: 2 } };
  });
  fireEvent.click(screen.getByRole("button", { name: "Agree to these terms" }));
  await screen.findByText(/The lender must replace the original offer/);
  expect(screen.queryByRole("button", { name: "Fund agreed replacement" })).not.toBeInTheDocument();
});
test("wallet changes hide private history immediately and require a fresh session", async () => {
  const mounted = render(view());
  await open();
  mounted.rerender(view(lender));
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unlock conversations" })).toBeVisible();
});
test("unknown funding attempts offer receipt recovery instead of a second funding button", async () => {
  row = { ...row, state: "funding", attempt: "33333333-3333-4333-8333-333333333333" };
  session = { ...session, account: lender };
  mocks.sign.mockResolvedValue(session);
  render(view(lender));
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: /AAPL offer #1/ }));
  await screen.findByText(/A funding attempt was started/);
  expect(screen.queryByRole("button", { name: "Fund agreed replacement" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Verify confirmed transaction" })).toBeDisabled();
});
test("expired proposals cannot be agreed; public request board is not used to read private conversations", async () => {
  row.latest.responseBy = Math.floor(Date.now() / 1000) - 1;
  render(view());
  await unlock();
  fireEvent.click(screen.getByRole("button", { name: /AAPL offer #1/ }));
  await screen.findByRole("table");
  expect(screen.queryByRole("button", { name: "Agree to these terms" })).not.toBeInTheDocument();
  expect(mocks.read).toHaveBeenCalledWith(session, expect.objectContaining({ id: row.id }));
});
test("proposed terms require review and preserve exact token precision", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(
    <NegotiationEditor
      market={market}
      original={terms()}
      initial={terms()}
      sourceExpiry={terms().expiresAt}
      disabled={false}
      onSubmit={submit}
    />,
  );
  fireEvent.change(screen.getByLabelText("USDG to receive"), { target: { value: "1000.123456" } });
  fireEvent.change(screen.getByLabelText("Collateral · AAPL"), { target: { value: "10.000000000000000001" } });
  fireEvent.click(screen.getByRole("button", { name: "Review proposed terms" }));
  expect(submit).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign and send proposal" })));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ principal: "1000123456", collateral: "10000000000000000001" }),
    expect.any(Number),
  );
});
test("late unlock responses cannot reveal the previous wallet conversation", async () => {
  let resolve!: (s: NegotiationSession) => void;
  mocks.sign.mockReturnValue(
    new Promise<NegotiationSession>((r) => {
      resolve = r;
    }),
  );
  const mounted = render(view());
  fireEvent.click(screen.getByRole("button", { name: "Unlock conversations" }));
  mounted.rerender(view(lender));
  await act(async () => resolve(session));
  await waitFor(() => expect(screen.getByRole("button", { name: "Unlock conversations" })).toBeEnabled());
  expect(mocks.read).not.toHaveBeenCalled();
});
