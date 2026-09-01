"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { getBranches, getCollToken } from "@/src/liquity-utils";
import Link from "next/link";
import { useMemo, useState } from "react";

const MVP_MARKETS = [
  { symbol: "AAPL", name: "Apple", maxLtv: "57.1%" },
  { symbol: "MSFT", name: "Microsoft", maxLtv: "57.1%" },
  { symbol: "GOOGL", name: "Alphabet", maxLtv: "55.6%" },
  { symbol: "AMZN", name: "Amazon", maxLtv: "54.1%" },
  { symbol: "META", name: "Meta Platforms", maxLtv: "52.6%" },
  { symbol: "NVDA", name: "Nvidia", maxLtv: "50%" },
  { symbol: "AMD", name: "Advanced Micro Devices", maxLtv: "50%" },
  { symbol: "ORCL", name: "Oracle", maxLtv: "50%" },
  { symbol: "MU", name: "Micron", maxLtv: "44.4%" },
  { symbol: "TSLA", name: "Tesla", maxLtv: "40%" },
] as const;

type PreviewMarket = (typeof MVP_MARKETS)[number];

const MARKET_NAMES: Record<string, string> = Object.fromEntries(
  MVP_MARKETS.map(({ name, symbol }) => [symbol, name]),
);

function MarketIdentity({ name, symbol }: { name: string; symbol: string }) {
  return (
    <div className="rusd-market-name">
      <span className="rusd-ticker">{symbol}</span>
      <span className="rusd-market-meta">
        <span className="rusd-market-company">{name}</span>
        <span className="rusd-market-type">Isolated market</span>
      </span>
    </div>
  );
}

function MarketRow({ symbol, branchId }: { symbol: CollateralSymbol; branchId: BranchId }) {
  const collateral = getCollToken(branchId);
  const maxLtv = collateral?.collateralRatio
    ? `${(100 / collateral.collateralRatio).toFixed(1).replace(".0", "")}%`
    : "—";

  return (
    <tr>
      <td>
        <MarketIdentity name={MARKET_NAMES[symbol] ?? String(symbol)} symbol={symbol} />
      </td>
      <td className="rusd-ltv">{maxLtv}</td>
      <td>
        <Link className="rusd-action" href={`/borrow/${symbol.toLowerCase()}`}>Borrow</Link>
      </td>
    </tr>
  );
}

function PreviewMarketRow({
  market,
  selected,
  onSelect,
}: {
  market: PreviewMarket;
  selected: boolean;
  onSelect: (market: PreviewMarket) => void;
}) {
  return (
    <tr data-selected={selected || undefined}>
      <td>
        <MarketIdentity name={market.name} symbol={market.symbol} />
      </td>
      <td className="rusd-ltv">{market.maxLtv}</td>
      <td>
        <button
          aria-pressed={selected}
          className="rusd-action rusd-preview-action"
          onClick={() => onSelect(market)}
          type="button"
        >
          {selected ? "Selected" : "Preview"}
        </button>
      </td>
    </tr>
  );
}

function PositionPreview({ market }: { market: PreviewMarket }) {
  const [collateralAmount, setCollateralAmount] = useState("10");
  const [borrowAmount, setBorrowAmount] = useState("1000");
  const maxLtv = Number.parseFloat(market.maxLtv);
  const exampleLtv = useMemo(() => {
    const borrow = Number.parseFloat(borrowAmount) || 0;
    return Math.min(maxLtv, Math.max(0, maxLtv * (borrow / 2000)));
  }, [borrowAmount, maxLtv]);

  return (
    <form className="rusd-position-preview" onSubmit={(event) => event.preventDefault()}>
      <div className="rusd-position-head">
        <div>
          <span className="rusd-position-label">Position preview</span>
          <strong>{market.symbol} / USDG</strong>
        </div>
        <span className="rusd-position-mode">Illustrative</span>
      </div>

      <div className="rusd-position-exchange">
        <label className="rusd-position-field" htmlFor="dockyard-collateral-amount">
          <span>You deposit</span>
          <span className="rusd-position-input">
            <input
              aria-label={`${market.symbol} collateral amount`}
              id="dockyard-collateral-amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setCollateralAmount(event.target.value)}
              type="number"
              value={collateralAmount}
            />
            <strong>{market.symbol}</strong>
          </span>
        </label>

        <span aria-hidden="true" className="rusd-position-flow">
          <svg fill="none" viewBox="0 0 16 18">
            <path d="M8 2.5v12M3.5 10 8 14.5l4.5-4.5" />
          </svg>
        </span>

        <label className="rusd-position-field rusd-position-field-output" htmlFor="dockyard-borrow-amount">
          <span>You borrow</span>
          <span className="rusd-position-input">
            <input
              aria-label="USDG borrow amount"
              id="dockyard-borrow-amount"
              inputMode="decimal"
              min="0"
              onChange={(event) => setBorrowAmount(event.target.value)}
              type="number"
              value={borrowAmount}
            />
            <strong>USDG</strong>
          </span>
        </label>
      </div>

      <div className="rusd-position-risk">
        <div>
          <span>Example LTV</span>
          <strong>{exampleLtv.toFixed(1)}%</strong>
        </div>
        <span className="rusd-position-risk-track">
          <span style={{ width: `${Math.min(100, (exampleLtv / maxLtv) * 100)}%` }} />
        </span>
        <div className="rusd-position-risk-scale">
          <span>Lower risk</span>
          <span>Max {market.maxLtv}</span>
        </div>
      </div>

      <div className="rusd-position-safeguards">
        <span>Isolated vault</span>
        <span>Dual-oracle safeguards</span>
      </div>

      <button className="rusd-position-cta" disabled type="submit">Borrow USDG</button>
    </form>
  );
}

export function HomeScreen() {
  const branches = READ_ONLY_DEPLOYMENT ? [] : getBranches();
  const [selectedMarket, setSelectedMarket] = useState<PreviewMarket>(MVP_MARKETS[0]);

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <div className="rusd-hero-message">
          <h1>Borrow against Wall Street.</h1>
          <p className="rusd-hero-copy">
            Turn your Stock Tokens into dollar liquidity without selling your market exposure.
          </p>
          <div className="rusd-hero-proof">
            <span>10 isolated markets</span>
            <span>One Stock Token per vault</span>
          </div>
        </div>
        <PositionPreview market={selectedMarket} />
      </section>

      <ol aria-label="How borrowing works" className="rusd-borrow-flow">
        <li>
          <span>Choose</span>
          <strong>a stock market</strong>
        </li>
        <li>
          <span>Deposit</span>
          <strong>its Stock Token</strong>
        </li>
        <li>
          <span>Borrow</span>
          <strong>USDG liquidity</strong>
        </li>
      </ol>

      <section className="rusd-market-panel">
        <div className="rusd-market-heading">
          <div>
            <h2 className="rusd-market-title">Markets</h2>
            <p>Compare isolated borrowing parameters.</p>
          </div>
          {READ_ONLY_DEPLOYMENT && <span className="rusd-market-selected">Previewing {selectedMarket.symbol}</span>}
        </div>
        <table className="rusd-market-table">
          <caption className="sr-only">
            Choose your collateral from {READ_ONLY_DEPLOYMENT ? MVP_MARKETS.length : branches.length}{" "}
            isolated Stock Token markets
          </caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Max LTV</th>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {READ_ONLY_DEPLOYMENT
              ? MVP_MARKETS.map((market) => (
                <PreviewMarketRow
                  key={market.symbol}
                  market={market}
                  onSelect={setSelectedMarket}
                  selected={selectedMarket.symbol === market.symbol}
                />
              ))
              : branches.map(({ id, symbol }) => <MarketRow branchId={id} key={symbol} symbol={symbol} />)}
          </tbody>
        </table>
      </section>

      <aside className="rusd-info">
        <span aria-hidden="true" className="rusd-info-icon">i</span>
        <div>
          <strong>Your positions stay separate.</strong>
          <p>
            Each loan is backed by one Stock Token. If its value falls too far, your collateral may be sold to repay the
            loan. Some actions may pause when markets are closed or prices cannot be updated.
          </p>
        </div>
        {READ_ONLY_DEPLOYMENT
          ? <span className="rusd-preview-status">Preview · contracts pending</span>
          : <Link className="rusd-text-link" href="/borrow">How borrowing works</Link>}
      </aside>
    </div>
  );
}
