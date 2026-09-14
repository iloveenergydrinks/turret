// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CollateralMarketPrice, WeekendMarkets } from "./CollateralMarketPrice";
import type { Deployment } from "../../p2p/client";
const market = { version: 3, chainId: 4663, address: "0x9C1eC6c0C5Ff43307EaA58408ff9674A5D4d7D09", collateralSymbol: "SPY", collateralDecimals: 18 } as unknown as Deployment;
const now = Date.parse("2026-09-12T15:00:00Z");
const prices = { market: market.address, collateralAmount: "1000000000000000000", referenceSession: "closed",
  reference: { status: "available", priceRaw: "70000000000", updatedAt: now / 1000 - 100000, stale: true, decimals: 8 },
  sale: { status: "available", amountOut: "690000000", quotedAt: now / 1000, expiresAt: now / 1000 + 30, decimals: 6 } };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => prices })); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(600); });
describe("Weekend collateral pricing", () => {
  it("shows historical USD reference separately from current USDG sale estimate", async () => {
    render(<CollateralMarketPrice market={market} amount="1" />); await settle();
    expect(screen.getByText("700 USD")).toBeTruthy(); expect(screen.getByText("690 USDG")).toBeTruthy();
    expect(screen.getByText(/Underlying market closed/)).toBeTruthy(); expect(screen.getByText(/not a guaranteed sale/)).toBeTruthy();
  });
  it("removes an expired quote even if the refresh is stalled", async () => {
    render(<CollateralMarketPrice market={market} amount="1" />); await settle();
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(screen.queryByText("690 USDG")).toBeNull(); expect(screen.getByText("Refreshing sale quote…")).toBeTruthy();
  });
  it("never displays a previous amount's quote after input changes", async () => {
    const view = render(<CollateralMarketPrice market={market} amount="1" />); await settle();
    view.rerender(<CollateralMarketPrice market={market} amount="2" />);
    expect(screen.queryByText("690 USDG")).toBeNull(); await settle();
    expect(screen.getByText("Sale quote unavailable")).toBeTruthy();
  });
  it("keeps requesting a loan available when price providers fail", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Outage")); const onBorrow = vi.fn();
    render(<WeekendMarkets markets={[market]} onBorrow={onBorrow} onBrowse={() => {}} />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Request SPY loan" })); expect(onBorrow).toHaveBeenCalledWith(market);
    expect(screen.getByText("Sale quote unavailable")).toBeTruthy();
  });
  it("does not request prices for unregistered or legacy markets", async () => {
    render(<CollateralMarketPrice market={{ ...market, version: 2 }} amount="1" />); await settle(); expect(fetch).not.toHaveBeenCalled();
  });
});

it("offers current stock and token collateral and excludes retired markets", async () => {
 const aapl: Deployment = { ...market, address: ("0x" + "1".repeat(40)) as `0x${string}`, collateralSymbol: "AAPL" };
 const cashcat: Deployment = { ...market, address: ("0x" + "2".repeat(40)) as `0x${string}`, collateralSymbol: "CASHCAT" };
 const onBorrow = vi.fn(), onBrowse = vi.fn();
 render(<WeekendMarkets markets={[aapl, cashcat, market, {...aapl, address: ("0x" + "3".repeat(40)) as `0x${string}`, collateralSymbol: "Retired", legacy: true}]} onBorrow={onBorrow} onBrowse={onBrowse} />);
 const selector = screen.getByRole("combobox", {name:"Collateral token"});
 expect(screen.getAllByRole("option").map(option=>option.textContent)).toEqual(["AAPL","CASHCAT","SPY"]);
 fireEvent.click(screen.getByRole("button", {name:"Request AAPL loan"}));expect(onBorrow).toHaveBeenCalledWith(aapl);
 fireEvent.change(selector,{target:{value:cashcat.address}});
 fireEvent.click(screen.getByRole("button", {name:"Browse CASHCAT offers"}));expect(onBrowse).toHaveBeenCalledWith(cashcat);
 await settle();expect(fetch).toHaveBeenCalledWith(expect.stringContaining(cashcat.address),expect.anything());
});

it("shows checking rather than unavailable before a price response", async () => {
 vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
 render(<CollateralMarketPrice market={market} amount="1" />); await settle();
 expect(screen.getByText("Checking reference…")).toBeTruthy();
 expect(screen.getByText("Checking sale quote…")).toBeTruthy();
 expect(screen.queryByText("Reference unavailable")).toBeNull();
 expect(screen.queryByText("The reference feed could not be verified.")).toBeNull();
});

it("refreshes a nearly expired cached quote before it disappears", async () => {
 vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...prices, sale: { ...prices.sale, expiresAt: now / 1000 + 8 } }) } as Response);
 render(<CollateralMarketPrice market={market} amount="1" />); await settle();
 await act(async () => { await vi.advanceTimersByTimeAsync(6500); });
 expect(fetch).toHaveBeenCalledTimes(2);
 expect(screen.getByText("690 USDG")).toBeTruthy();
});
it("retries a temporary quote failure without clearing an unexpired estimate", async () => {
 render(<CollateralMarketPrice market={market} amount="1" />); await settle();
 vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ...prices, sale: { status: "unavailable", reason: "invalid_quote" } }) } as Response);
 fireEvent.click(screen.getByRole("button", { name: "Refresh collateral pricing" })); await settle();
 expect(screen.getByText("690 USDG")).toBeTruthy();
 await act(async () => { await vi.advanceTimersByTimeAsync(5500); });
 expect(fetch).toHaveBeenCalledTimes(3);
});
