import type { IsolatedMarket } from "./isolated-market-config";
import { stockProofUrl } from "./stock-proof-url";

export type StockMarketAvailability =
  | { state: "checking" }
  | { state: "open" }
  | { state: "closed"; reopensAt: number }
  | { state: "unavailable"; reachedService?: boolean };

export async function fetchStockMarketAvailability(
  market: IsolatedMarket,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<StockMarketAvailability> {
  if (market.admission === "commissioning" || !market.stock?.riskMonitorUrl) {
    return { state: "unavailable" };
  }
  try {
    const response = await fetcher(
      stockProofUrl(market.stock.riskMonitorUrl, market.engine),
      {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) return { state: "open" };
    const text = await response.text();
    if (text.length <= 2_000) {
      const body = JSON.parse(text) as { code?: unknown; reopensAt?: unknown };
      const reopensAt = Number(body.reopensAt);
      const current = Math.floor(now() / 1_000);
      if (
        body.code === "market_closed"
        && Number.isSafeInteger(reopensAt)
        && reopensAt > current
        && reopensAt <= current + 8 * 86_400
      ) {
        return { state: "closed", reopensAt };
      }
    }
    return { state: "unavailable", reachedService: true };
  } catch {
    return { state: "unavailable" };
  }
}

export function marketCountdown(reopensAt: number, nowMs: number): string {
  const remaining = Math.max(0, reopensAt - Math.floor(nowMs / 1_000));
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days}d ${clock}` : clock;
}
