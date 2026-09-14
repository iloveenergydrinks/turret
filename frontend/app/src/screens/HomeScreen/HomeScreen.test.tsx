// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const engine = `0x${"1".repeat(40)}`;
const secondEngine = `0x${"2".repeat(40)}`;
const marketFixtures = vi.hoisted(() => [
  { symbol: "AAPL", engine: `0x${"1".repeat(40)}`, admission: "commissioning", stock: { riskMonitorUrl: "https://aapl.example.test" } },
  { symbol: "MSFT", engine: `0x${"2".repeat(40)}`, admission: "commissioning", stock: { riskMonitorUrl: "https://msft.example.test" } },
]);
vi.mock(
  "@/src/isolated-market-config",
  () => ({
    ISOLATED_MARKETS: marketFixtures,
  }),
);
vi.mock("@/src/deployment-config", () => ({ READ_ONLY_DEPLOYMENT: false }));
vi.mock("@/src/dockyard-config", () => ({
  DOCKYARD_STANDALONE_DEPLOYMENT: true,
  getDockyardMarket: (symbol: string) => ({ symbol, address: symbol === "AAPL" ? `0x${"a".repeat(40)}` : `0x${"b".repeat(40)}` }),
}));
vi.mock("@/src/isolated-assets", () => ({
  ISOLATED_ASSETS: [
    { symbol: "CASHCAT" },
    { symbol: "PONS" },
  ],
  getIsolatedAsset: () => null,
}));
vi.mock("@/src/liquity-utils", () => ({ getBranches: () => [], getCollToken: () => undefined }));
vi.mock(
  "@/src/comps/HowBorrowingWorks/HowBorrowingWorks",
  () => ({ HowBorrowingWorks: () => <button>How borrowing works</button> }),
);
import { HomeScreen } from "./HomeScreen";
afterEach(cleanup);
afterEach(() => vi.useRealTimers());
afterEach(() => {
  marketFixtures.forEach((market) => { market.admission = "commissioning"; });
  vi.unstubAllGlobals();
});
test("AAPL recovery does not inherit a regular-hours market's closure countdown", async () => {
  marketFixtures.forEach((market) => { market.admission = "active"; });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => new Response(JSON.stringify(
    String(url).includes("aapl.example.test")
      ? { code: "temporarily_unavailable" }
      : { code: "market_closed", reopensAt: Math.floor(Date.now() / 1000) + 3600 },
  ), { status: 503 })));
  const { container } = render(<HomeScreen />);
  await waitFor(() => expect(container.querySelectorAll(".rusd-market-status[data-state=\"closed\"]")).toHaveLength(1));
  const rows = container.querySelectorAll(".rusd-market-table tbody tr");
  expect(rows[0]).not.toHaveTextContent("Closed");
  expect(rows[0]).not.toHaveTextContent("Opens in");
  expect(rows[1]).toHaveTextContent("Closed");
});
test("configured pools replace legacy borrowing links and unverified loan limits", () => {
  const { container } = render(<HomeScreen />);
  const marketLinks = screen.getAllByRole("link", { name: "View market" });
  expect(marketLinks).toHaveLength(2);
  expect(marketLinks[0]).toHaveAttribute("href", `/borrow?engine=${engine}`);
  expect(marketLinks[1]).toHaveAttribute("href", `/borrow?engine=${secondEngine}`);
  expect(screen.getAllByText("Not open yet")).toHaveLength(2);
  expect(container.querySelectorAll(".rusd-market-status[data-state=\"pending\"] .rusd-market-status-icon svg"))
    .toHaveLength(2);
  expect(screen.getByText("2 configured markets")).toBeVisible();
  expect(screen.queryByText("52.1%")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^Borrow$/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "How borrowing works" })).toBeVisible();
});
test("stock tickers expose the canonical contract for copy and explorer access", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<HomeScreen />);

  const ticker = screen.getByRole("button", { name: "Show AAPL Stock Token contract" });
  expect(ticker).toHaveAttribute("aria-expanded", "false");
  act(() => ticker.click());
  expect(ticker).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(`0x${"a".repeat(40)}`)).toBeVisible();
  expect(screen.getAllByRole("link", { name: "View on explorer" })[0]).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/address/0x${"a".repeat(40)}`,
  );

  act(() => screen.getAllByRole("button", { name: "Copy address" })[0]?.click());
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(`0x${"a".repeat(40)}`));
});
test("pool explanations describe ongoing interest and separate lending pools", () => {
  render(<HomeScreen />);
  expect(screen.getByText(/Debt accrues interest at the borrower APR/)).toBeInTheDocument();
  expect(screen.getByText(/Each market has separate funds and loss exposure/)).toBeInTheDocument();
  expect(screen.queryByText(/There is no ongoing interest/)).not.toBeInTheDocument();
  expect(screen.queryByText(/The markets share one USDG balance/)).not.toBeInTheDocument();
  expect(screen.queryByText(/one-time 0.5% fee/)).not.toBeInTheDocument();
});

test("rotates the stock in the lending mechanism", () => {
  vi.useFakeTimers();
  render(<HomeScreen />);
  expect(screen.getByRole("img", { name: /Deposit a AAPL Stock Token/ })).toBeVisible();
  act(() => vi.advanceTimersByTime(2800));
  expect(screen.getByRole("img", { name: /Deposit a MSFT Stock Token/ })).toBeVisible();
});
