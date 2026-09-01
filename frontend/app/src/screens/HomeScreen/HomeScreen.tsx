"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { getBranches, getCollToken } from "@/src/liquity-utils";
import Link from "next/link";
import { useState } from "react";

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
          {selected ? "Selected" : "View"}
        </button>
      </td>
    </tr>
  );
}

function PositionMechanism({ market }: { market: PreviewMarket }) {
  return (
    <figure className="rusd-position-preview">
      <div className="rusd-position-head">
        <strong>{market.symbol} backs your USDG loan.</strong>
      </div>

      <div
        aria-label={`Deposit a ${market.symbol} Stock Token as collateral and borrow USDG against it`}
        className="rusd-position-path"
        role="img"
      >
        <div className="rusd-position-node">
          <span>Deposit</span>
          <strong>{market.symbol}</strong>
          <small>Stock Token</small>
        </div>
        <span aria-hidden="true" className="rusd-position-route">
          <svg fill="none" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="19" />
            <path d="M12.5 20h14M21 14.5l5.5 5.5-5.5 5.5" />
          </svg>
        </span>
        <div className="rusd-position-node">
          <span>Borrow</span>
          <strong>USDG</strong>
          <small>From Dockyard</small>
        </div>
      </div>

      <div className="rusd-position-risk">
        <div className="rusd-position-risk-heading">
          <span>Max LTV</span>
          <strong>{market.maxLtv}</strong>
        </div>
        <span aria-hidden="true" className="rusd-position-risk-track">
          <span />
        </span>
        <div className="rusd-position-risk-scale">
          <span>Safer</span>
          <span>Borrowing limit</span>
        </div>
      </div>

      <figcaption>
        Repay the USDG to get your {market.symbol} Stock Token back.
      </figcaption>

      <div className="rusd-position-safeguards">
        <span>One token per loan</span>
        <span>Two price checks</span>
      </div>
    </figure>
  );
}

export function HomeScreen() {
  const branches = READ_ONLY_DEPLOYMENT ? [] : getBranches();
  const [selectedMarket, setSelectedMarket] = useState<PreviewMarket>(MVP_MARKETS[0]);

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <div className="rusd-hero-message">
          <h1>Borrow USDG against Stock Tokens.</h1>
          <p className="rusd-hero-copy">
            Deposit AAPL, NVDA, TSLA, or another supported Stock Token as collateral. Borrow USDG without selling it, so
            its value can still rise or fall while your loan is open.
          </p>
          <div className="rusd-hero-proof">
            <span>10 Stock Tokens</span>
            <span>Robinhood Chain</span>
          </div>
        </div>
        <PositionMechanism market={selectedMarket} />
      </section>

      <section className="rusd-explainer" id="how-it-works">
        <div className="rusd-explainer-heading">
          <h2>How it works</h2>
          <p>Stock Token in. USDG out.</p>
        </div>
        <ol aria-label="How borrowing works" className="rusd-borrow-flow">
          <li>
            <strong>Deposit a Stock Token</strong>
            <p>Use one supported token as collateral.</p>
          </li>
          <li>
            <strong>Borrow USDG</strong>
            <p>USDG goes to your wallet. Your token stays locked.</p>
          </li>
          <li>
            <strong>Repay and withdraw</strong>
            <p>Return the USDG and get your Stock Token back.</p>
          </li>
        </ol>
      </section>

      <section className="rusd-market-panel">
        <div className="rusd-market-heading">
          <div>
            <h2 className="rusd-market-title">Choose your Stock Token</h2>
            <p>See the maximum LTV for each token.</p>
          </div>
          {READ_ONLY_DEPLOYMENT && <span className="rusd-market-selected">Selected {selectedMarket.symbol}</span>}
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
          <strong>Your Stock Token backs the loan.</strong>
          <p>
            If its price falls too much, it can be sold to repay the USDG. Borrowing may pause when the market is closed
            or price data is unavailable.
          </p>
        </div>
        {READ_ONLY_DEPLOYMENT
          ? <span className="rusd-preview-status">Preview · contracts pending</span>
          : <Link className="rusd-text-link" href="/borrow">How borrowing works</Link>}
      </aside>
    </div>
  );
}
