import { expect, test } from "vitest";
import registry from "../../public/p2p-markets.json";
import type { Deployment } from "./client";
import { prioritizeMarketReads } from "./market-read-order";

const markets = (registry.markets as Deployment[]).filter(m => m.version === 3).map(config => ({ config }));
test("memecoin discovery loads its markets first without dropping stock loans", () => {
  const before = [...markets];
  const sorted = prioritizeMarketReads(markets, { memecoins: true });
  expect(sorted.slice(0, 2).map(m => m.config.collateralSymbol)).toEqual(["CASHCAT", "PONS"]);
  expect(new Set(sorted)).toEqual(new Set(markets));
  expect(markets).toEqual(before);
});
test("an exact market has priority even over a conflicting category or symbol", () => {
  const stock = markets.find(m => m.config.collateralSymbol === "NVDA")!;
  expect(prioritizeMarketReads(markets, { market: stock.config.address.toUpperCase(), symbol: "PONS", memecoins: true })[0]).toBe(stock);
});
test("unfiltered visits preserve stable registry order", () => {
  expect(prioritizeMarketReads(markets, {})).toEqual(markets);
});
