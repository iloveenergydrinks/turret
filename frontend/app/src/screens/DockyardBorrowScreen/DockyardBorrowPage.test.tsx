// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ params: new URLSearchParams(), markets: [] as { symbol: string; engine: string }[] }));
vi.mock("wagmi", () => ({ useAccount: () => ({}), usePublicClient: () => undefined }));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/src/env", () => ({ CHAIN_BLOCK_EXPLORER: null }));
vi.mock("@/src/dockyard-config", async (original) => ({ ...await original<object>(), DOCKYARD_STANDALONE_DEPLOYMENT: true, getDockyardMarket: () => ({ symbol: "AAPL" }) }));
vi.mock("@/src/isolated-market-config", () => ({ get ISOLATED_MARKETS() { return mocks.markets; } }));
vi.mock("../IsolatedMarketScreen/IsolatedMarketScreen", () => ({ IsolatedMarketRoute: ({ engine }: { engine: string }) => mocks.markets.some(m => m.engine === engine)
  ? <p data-testid="current-market">{engine}</p> : <h1>Isolated market unavailable</h1> }));
vi.mock("@/src/deployment-config", () => ({ READ_ONLY_DEPLOYMENT: false }));
vi.mock("./DockyardBorrowScreen", () => ({ DockyardBorrowScreen: () => <div>Stock vault controls</div> }));
vi.mock("../P2PLoansScreen/P2PLoansScreen", () => ({ P2PLoansScreen: () => <div data-testid="p2p-marketplace">P2P stocks and memes marketplace</div> }));
import { DockyardBorrowPage } from "./DockyardBorrowPage";
afterEach(() => { cleanup(); mocks.markets = []; });
test("stock route retains stock controls", () => {
  mocks.params = new URLSearchParams("market=aapl");
  render(<DockyardBorrowPage />);
  expect(screen.getByText("Stock vault controls")).toBeVisible();
});
test("existing symbol links select the current pool rather than retired vault controls", () => {
  const engine = `0x${"1".repeat(40)}`;
  mocks.markets = [{ symbol: "AAPL", engine }];
  for (const query of ["market=aapl"]) {
    mocks.params = new URLSearchParams(query);
    const view = render(<DockyardBorrowPage />);
    expect(screen.getByTestId("current-market")).toHaveTextContent(engine);
    expect(screen.queryByText("Stock vault controls")).not.toBeInTheDocument();
    view.unmount();
  }
});
test("any explicit isolated engine prevents accidental stock-vault actions", () => {
  for (const query of ["engine=", "engine=bad&market=aapl", `engine=0x${"3".repeat(40)}`]) {
    mocks.params = new URLSearchParams(query);
    const view = render(<DockyardBorrowPage />);
    expect(screen.queryByText("Stock vault controls")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Isolated market unavailable" })).toBeVisible();
    view.unmount();
  }
});

test("the default Borrow route opens the P2P marketplace", () => {
  mocks.params = new URLSearchParams();
  render(<DockyardBorrowPage />);
  expect(screen.getByTestId("p2p-marketplace")).toBeVisible();
  expect(screen.queryByTestId("current-market")).not.toBeInTheDocument();
  expect(screen.queryByText("Stock vault controls")).not.toBeInTheDocument();
});
