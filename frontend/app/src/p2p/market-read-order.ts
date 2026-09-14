import type { Deployment } from "./client";
import { memecoinMarkets } from "../borrow/memecoin-offers";

/** Read the market the visitor opened first; keep every other market discoverable. */
export function prioritizeMarketReads<T extends { config: Deployment }>(
  markets: T[], target: { market?: string | null; symbol?: string; memecoins?: boolean },
): T[] {
  const memes = new Set(memecoinMarkets(markets.map(item => item.config)).map(m => m.address.toLowerCase()));
  const rank = ({ config }: T) => config.address.toLowerCase() === target.market?.toLowerCase() ? 0
    : target.symbol && config.collateralSymbol === target.symbol ? 1
    : target.memecoins && memes.has(config.address.toLowerCase()) ? 2 : 3;
  return [...markets].sort((a, b) => rank(a) - rank(b));
}
