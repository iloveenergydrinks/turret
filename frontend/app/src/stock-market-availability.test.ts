import { expect, test, vi } from "vitest";
import type { IsolatedMarket } from "./isolated-market-config";
import { fetchStockMarketAvailability, marketCountdown } from "./stock-market-availability";

const market = {
  admission: "active",
  engine: `0x${"1".repeat(40)}`,
  stock: { riskMonitorUrl: "https://risk.example.test" },
} as IsolatedMarket;

test("reports an open market from a live approval endpoint", async () => {
  const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
  await expect(fetchStockMarketAvailability(market, fetcher as typeof fetch)).resolves.toEqual({ state: "open" });
});

test("validates a market-close timestamp before showing a countdown", async () => {
  const now = () => 1_800_000_000_000;
  const fetcher = vi.fn(async () =>
    new Response(
      JSON.stringify({
        code: "market_closed",
        reopensAt: 1_800_003_661,
      }),
      { status: 503 },
    )
  );
  await expect(fetchStockMarketAvailability(market, fetcher as typeof fetch, now)).resolves.toEqual({
    state: "closed",
    reopensAt: 1_800_003_661,
  });
  expect(marketCountdown(1_800_003_661, now())).toBe("01:01:01");
});

test.each(["temporarily_unavailable", "session_qualifying"])("%s is unavailable without a fabricated reopening time", async (code) => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ code }), { status: 503 }));
  await expect(fetchStockMarketAvailability(market, fetcher as typeof fetch)).resolves.toEqual({
    state: "unavailable", reachedService: true,
  });
});
