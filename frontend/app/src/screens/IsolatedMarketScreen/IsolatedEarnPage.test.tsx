// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  markets: [] as { symbol: string; engine: string }[],
  readOnly: false,
  query: "",
}));
vi.mock("@/src/isolated-market-config", () => ({
  get ISOLATED_MARKETS() {
    return state.markets;
  },
}));
vi.mock("@/src/deployment-config", () => ({
  get READ_ONLY_DEPLOYMENT() {
    return state.readOnly;
  },
  getEarnPoolStaticParams: () => [],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.query),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("./IsolatedMarketScreen", () => ({
  IsolatedMarketRoute: ({ engine }: { engine: string }) => <p>Requested engine: {engine || "invalid"}</p>,
}));
import LegacyEarnLayout from "@/src/app/(protocol)/earn/[pool]/layout";
import EarnLayout from "@/src/app/(protocol)/earn/layout";
vi.mock("../../lending/rewards/PoolRewardsSummary", () => ({ PoolRewardsSummary: () => <span>TURRET rewards summary</span> }));
vi.mock("./PoolLenderRate", () => ({ PoolLenderRate: () => <span>USDG lending APR</span> }));
import { IsolatedEarnPage } from "./IsolatedEarnPage";
beforeEach(() => {
  state.markets = [];
  state.readOnly = false;
  state.query = "";
});
afterEach(cleanup);
test("empty Earn explains unavailable deposits and deferred tokens without wallet controls", () => {
  render(
    <EarnLayout>
      <IsolatedEarnPage />
    </EarnLayout>,
  );
  expect(
    screen.getByRole("heading", {
      name: "Isolated lending is not open yet",
    }),
  ).toBeVisible();
  expect(screen.getByText("CASHCAT")).toBeVisible();
  expect(screen.getByText("PONS")).toBeVisible();
  expect(screen.getByText("Coming soon")).toBeVisible();
  expect(
    screen.queryByText(/Borrowing and lending are not available/),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/Do not send USDG directly/)).toBeVisible();
  expect(screen.getByText(/not a guaranteed APY/)).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
test("configured stock pool has its own engine link, never a legacy Earn URL", () => {
  state.markets = [{ symbol: "AAPL", engine: "0x1234" }];
  render(<IsolatedEarnPage />);
  expect(
    screen.getByRole("heading", {
      name: "Earn interest by funding isolated loans.",
    }),
  ).toBeVisible();
  expect(screen.getByText(/You are the lender here/)).toBeVisible();
  expect(screen.getByText("AAPL lending pool")).toBeVisible();
  expect(screen.getByText(/loans secured only by AAPL/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Open pool" })).toHaveAttribute(
    "href",
    "/earn?engine=0x1234",
  );
  expect(screen.queryByText(/no pools accepting/)).not.toBeInTheDocument();
});
test("configured generic asset is not duplicated in the deferred list", () => {
  state.markets = [{ symbol: "CASHCAT", engine: "0x1234" }];
  render(<IsolatedEarnPage />);
  const deferred = screen.getByRole("list", { name: "Upcoming token markets" });
  expect(within(deferred).queryByText("CASHCAT")).not.toBeInTheDocument();
  expect(within(deferred).getByText("PONS")).toBeVisible();
  expect(screen.getByText("CASHCAT lending pool")).toBeVisible();
});
test("read-only deployment hides configured pool links", () => {
  state.markets = [{ symbol: "AAPL", engine: "0x1234" }];
  state.readOnly = true;
  render(<IsolatedEarnPage />);
  expect(
    screen.queryByRole("link", { name: /AAPL lending/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/not open yet/)).toBeVisible();
});
test("duplicate engine parameters do not silently choose a market", () => {
  state.query = "engine=0x1234&engine=0x5678";
  render(<IsolatedEarnPage />);
  expect(screen.getByText("Requested engine: invalid")).toBeVisible();
});
test("all legacy Earn layouts redirect, even with no isolated pools", () => {
  expect(() => LegacyEarnLayout()).toThrow("redirect:/earn");
});
