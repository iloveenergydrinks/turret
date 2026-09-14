import { useEffect, useRef, useState } from "react";
import type { Deployment } from "../../p2p/client";
import { displayDate, formatAmount, parseAmount } from "./loanPresentation";

// The backend validates each configured market and its available pricing sources.
export const hasWeekendPrices = (market: Deployment) => market.chainId === 4663 && market.version === 3 && !market.legacy;
type Prices = {
  market: string; collateralAmount: string; referenceSession: "open" | "closed" | "unknown";
  reference: { status: string; priceRaw?: string; updatedAt?: number; stale?: boolean; decimals?: number };
  sale: { status: string; reason?: string; amountOut?: string; quotedAt?: number; expiresAt?: number; decimals?: number };
};
function rounded(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(Math.max(0, decimals - 2));
  return formatAmount(raw / scale, Math.min(decimals, 2));
}

export function CollateralMarketPrice({ market, amount }: { market: Deployment; amount: string }) {
  const [result, setResult] = useState<{ key: string; prices: Prices } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(result); latest.current = result;
  let raw = "";
  try { const value = parseAmount(amount, market.collateralDecimals); if (value > 0n && value <= 1000n * 10n ** BigInt(market.collateralDecimals)) raw = value.toString(); } catch { /* Show an input hint. */ }
  const enabled = hasWeekendPrices(market), key = `${market.address.toLowerCase()}:${raw}`;
  useEffect(() => {
    if (!enabled || !raw) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      let delay = 5000;
      setRefreshing(true);
      try {
        const response = await fetch(`/api/p2p/market-prices?market=${market.address}&amount=${raw}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: "no-store",
        });
        if (!response.ok) throw new Error("Unavailable");
        const prices: Prices = await response.json();
        if (prices.market.toLowerCase() !== market.address.toLowerCase() || prices.collateralAmount !== raw
          || !prices.reference || !prices.sale) throw new Error("Invalid market data");
        const seconds = Math.floor(Date.now() / 1000);
        if (prices.sale.status === "available" && Number.isSafeInteger(prices.sale.expiresAt) && prices.sale.expiresAt! > seconds) {
          // Cached server quotes may have only seconds left. Schedule from their actual expiry.
          delay = Math.max(1000, Math.min(25_000, prices.sale.expiresAt! * 1000 - Date.now() - 5000));
        } else {
          const previous = latest.current?.key === key ? latest.current.prices.sale : null;
          if (previous?.status === "available" && previous.expiresAt! > seconds) prices.sale = previous;
        }
        if (!controller.signal.aborted) { setResult({ key, prices }); setError(null); }
      } catch {
        // A failed refresh does not invalidate a quote that is still within its original lifetime.
        if (!controller.signal.aborted) setError(key);
      } finally {
        if (!controller.signal.aborted) {
          setRefreshing(false);
          timer = setTimeout(() => { void load(); }, delay);
        }
      }
    };
    setError(null);
    setRefreshing(false);
    timer = setTimeout(() => { void load(); }, 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [enabled, key, market.address, raw, revision]);
  useEffect(() => { if (!enabled) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [enabled]);
  if (!enabled) return null;
  const prices = result?.key === key ? result.prices : null;
  const ref = prices?.reference, sale = prices?.sale;
  const pending = !prices && error !== key;
  const refValid = ref?.status === "available" && ref.decimals === 8 && /^[1-9][0-9]{0,77}$/.test(ref.priceRaw ?? "") && Number.isSafeInteger(ref.updatedAt);
  const saleValid = sale?.status === "available" && sale.decimals === 6 && /^[1-9][0-9]{0,77}$/.test(sale.amountOut ?? "")
    && Number.isSafeInteger(sale.expiresAt) && sale.expiresAt! > Math.floor(clock / 1000);
  return <section className="p2p-market-price" aria-label={`${market.collateralSymbol} collateral pricing`}>
    <header className="p2p-market-price-heading"><h3>Collateral value · {market.collateralSymbol}</h3>{raw && <button type="button" className="p2p-price-refresh" onClick={() => setRevision(value => value + 1)}>Refresh collateral pricing</button>}</header>
    {!raw ? <p className="p2p-help">Enter more than 0 and up to 1,000 {market.collateralSymbol} to check an estimated sale value.</p> : <>
      <dl>
        <div><dt>Reference value · {formatAmount(BigInt(raw), market.collateralDecimals)} {market.collateralSymbol}</dt><dd>{refValid ? `${rounded(BigInt(ref!.priceRaw!) * BigInt(raw) / 10n ** BigInt(market.collateralDecimals), 8)} USD` : pending ? "Checking reference…" : "Reference unavailable"}</dd>
          <small>{refValid ? `Chainlink · updated ${displayDate(ref!.updatedAt!)}${ref!.stale || Math.floor(clock / 1000) - ref!.updatedAt! > 86400 ? " · older than the feed heartbeat" : ""}` : pending ? "Fetching the latest published reference." : "The reference feed could not be verified."}</small></div>
        <div><dt>Estimated sale proceeds</dt><dd>{saleValid ? `${rounded(BigInt(sale!.amountOut!), 6)} USDG` : pending ? "Checking sale quote…" : refreshing ? "Refreshing sale quote…" : "Sale quote unavailable"}</dd>
          <small>{saleValid ? `Kyber · quoted ${displayDate(sale!.quotedAt!)} · excludes gas` : pending ? "Fetching an estimated sale value." : refreshing ? "Updating the sale estimate. Loan terms are unchanged."
            : sale?.reason === "invalid_quote" ? "The quote provider returned an unusable estimate. Retrying automatically; P2P borrowing remains available."
            : sale?.reason === "busy" ? "The quote provider is busy. Retrying automatically; P2P borrowing remains available."
            : "A current sale estimate is temporarily unavailable. Retrying automatically; P2P borrowing remains available."}</small></div>
      </dl>
      <p className="p2p-help">{prices?.referenceSession === "closed" ? "Underlying market closed. The reference is the last published value; the token can trade at a different price." : prices?.referenceSession === "open" ? "Reference session open. The timestamp shows when the feed last published a price." : pending ? "Checking reference market status…" : "Reference market status unavailable."}</p>
      <details className="p2p-price-disclosure"><summary>Pricing sources and risks</summary><p className="p2p-help">A quote is an estimate, not a guaranteed sale or a recommended loan amount. USD and USDG are different units. Lenders choose the terms; P2P loans have no price-triggered liquidation.</p></details>
    </>}
  </section>;
}

export function WeekendMarkets({ markets, onBorrow, onBrowse }: { markets: Deployment[]; onBorrow: (market: Deployment) => void; onBrowse: (market: Deployment) => void }) {
  const eligible = markets.filter(hasWeekendPrices);
  const [address, setAddress] = useState(""), [amount, setAmount] = useState("1");
  const market = eligible.find(row => row.address === address) ?? eligible[0];
  if (!market) return null;
  return <section className="p2p-weekend-markets" aria-label="P2P collateral explorer">
    <div><h2>Choose collateral for your P2P loan</h2>
      <p>Agree fixed terms with a lender and receive USDG when you accept their funded offer. Market closure alone does not block P2P borrowing.</p></div>
    <div className="p2p-weekend-inputs"><label>Collateral token<select value={market.address} onChange={event => setAddress(event.target.value)}>{eligible.map(row => <option key={row.address} value={row.address}>{row.collateralSymbol}</option>)}</select></label>
      <label>Amount to check<input aria-label="Collateral amount to check" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label></div>
    <CollateralMarketPrice market={market} amount={amount} />
    <div className="p2p-request-actions"><button type="button" className="p2p-button" onClick={() => onBorrow(market)}>Request {market.collateralSymbol} loan</button>
      <button type="button" className="p2p-button p2p-secondary" onClick={() => onBrowse(market)}>Browse {market.collateralSymbol} offers</button></div>
    <p className="p2p-help">A request is unfunded. Borrowing requires a willing lender, enough collateral, and successful token transfers.</p>
  </section>;
}
