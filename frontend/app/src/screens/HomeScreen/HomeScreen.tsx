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
          {selected ? "Viewing" : "Inspect"}
        </button>
      </td>
    </tr>
  );
}

function PositionMechanism({ market }: { market: PreviewMarket }) {
  return (
    <figure className="rusd-position-preview">
      <div className="rusd-position-head">
        <div>
          <strong>{market.symbol}-backed credit</strong>
        </div>
        <span className="rusd-position-mode">How it works</span>
      </div>

      <div
        aria-label={`${market.symbol} Stock Tokens are locked in an isolated vault, which lends existing USDG liquidity`}
        className="rusd-position-path"
        role="img"
      >
        <div className="rusd-position-node">
          <span>Collateral</span>
          <strong>{market.symbol}</strong>
          <small>Stock Token</small>
        </div>
        <span aria-hidden="true" className="rusd-position-route">
          <svg fill="none" viewBox="0 0 44 14">
            <path d="M2 7h37M34 2l5 5-5 5" />
          </svg>
        </span>
        <div className="rusd-position-node rusd-position-vault">
          <span>Locked in</span>
          <strong>Isolated vault</strong>
          <small>One stock market</small>
        </div>
        <span aria-hidden="true" className="rusd-position-route">
          <svg fill="none" viewBox="0 0 44 14">
            <path d="M2 7h37M34 2l5 5-5 5" />
          </svg>
        </span>
        <div className="rusd-position-node">
          <span>You receive</span>
          <strong>USDG</strong>
          <small>Existing liquidity</small>
        </div>
      </div>

      <div className="rusd-position-risk">
        <div className="rusd-position-risk-heading">
          <span>Maximum opening LTV</span>
          <strong>{market.maxLtv}</strong>
        </div>
        <span aria-hidden="true" className="rusd-position-risk-track">
          <span />
        </span>
        <div className="rusd-position-risk-scale">
          <span>More collateral</span>
          <span>Opening limit</span>
        </div>
      </div>

      <figcaption>
        Your Stock Token stays locked while the debt is open. Repay the USDG to withdraw it.
      </figcaption>

      <div className="rusd-position-safeguards">
        <span>Existing USDG only</span>
        <span>Two price feeds</span>
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
          <h1>Borrow against Wall Street.</h1>
          <p className="rusd-hero-copy">
            Turn your Stock Tokens into dollar liquidity without selling your market exposure.
          </p>
          <div className="rusd-hero-proof">
            <span>10 isolated markets</span>
            <span>One Stock Token per vault</span>
          </div>
        </div>
        <PositionMechanism market={selectedMarket} />
      </section>

      <section className="rusd-explainer" id="how-it-works">
        <div className="rusd-explainer-heading">
          <h2>How it works</h2>
          <p>One stock, one loan. No selling.</p>
        </div>
        <ol aria-label="How borrowing works" className="rusd-borrow-flow">
          <li>
            <strong>Choose a stock</strong>
            <p>Pick the Stock Token you already hold.</p>
          </li>
          <li>
            <strong>Lock the token</strong>
            <p>It stays in its own vault while your loan is open.</p>
          </li>
          <li>
            <strong>Receive USDG</strong>
            <p>Borrow existing USDG supplied to Dockyard.</p>
          </li>
          <li>
            <strong>Repay and unlock</strong>
            <p>Return the USDG to withdraw your Stock Token.</p>
          </li>
        </ol>
        <p className="rusd-explainer-risk">
          If the Stock Token falls too far, it can be sold to repay the loan.
        </p>
      </section>

      <section className="rusd-market-panel">
        <div className="rusd-market-heading">
          <div>
            <h2 className="rusd-market-title">Markets</h2>
            <p>Compare isolated borrowing parameters.</p>
          </div>
          {READ_ONLY_DEPLOYMENT && <span className="rusd-market-selected">Viewing {selectedMarket.symbol}</span>}
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
