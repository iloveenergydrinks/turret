// @vitest-environment jsdom
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { loadPublicMarket, savePublicMarket } from "./public-market-cache";
import type { Deployment, OfferPage } from "./client";
const market = { chainId: 4663, rpcUrl: "/api/rpc", address: "0x" + "1".repeat(40), runtimeHash: "0x" + "a".repeat(64),
 loanToken: "0x" + "2".repeat(40), collateralToken: "0x" + "3".repeat(40), loanDecimals: 6, collateralDecimals: 18, version: 3 } as Deployment;
const page: OfferPage = { now: 1000, blockNumber: 10n, paused: false, nextCursor: null, offers: [{
 id: 1n, isPublic: true, status: "open", lender: "0x1111111111111111111111111111111111111111", borrower: "0x0000000000000000000000000000000000000000",
 createdAt: 990, principal: 50n, collateral: 100n, interest: 1n, durationDays: 30, expiresAt: 1010, dueAt: 0 }] };
beforeEach(() => { window.sessionStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(2000000); });
afterEach(() => vi.useRealTimers());
test("restores exact public amounts without persisting private offers", () => {
 savePublicMarket(market, { ...page, offers: [...page.offers, { ...page.offers[0]!, id: 2n, isPublic: false }] });
 expect(loadPublicMarket(market)).toEqual(page);
});
test("invalidates on deployment identity changes and rejects corrupt storage", () => {
 savePublicMarket(market, page);
 expect(loadPublicMarket({ ...market, runtimeHash: "0x" + "b".repeat(64) as `0x${string}` })).toBeNull();
 const key = window.sessionStorage.key(0)!; window.sessionStorage.setItem(key, "bad");
 expect(loadPublicMarket(market)).toBeNull();
});
test("removes expired offers and discards old snapshots", () => {
 savePublicMarket(market, page); vi.advanceTimersByTime(11000);
 expect(loadPublicMarket(market)?.offers).toEqual([]);
 vi.advanceTimersByTime(120000); expect(loadPublicMarket(market)).toBeNull();
});
test("storage failure does not block fresh data", () => {
 const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
 expect(() => savePublicMarket(market, page)).not.toThrow(); spy.mockRestore();
});
