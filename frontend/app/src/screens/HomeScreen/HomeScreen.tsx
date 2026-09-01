"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { getBranches, getCollToken } from "@/src/liquity-utils";
import Image from "next/image";
import Link from "next/link";

const MVP_MARKETS = [
  { symbol: "AAPL", maxLtv: "57.1%" },
  { symbol: "MSFT", maxLtv: "57.1%" },
  { symbol: "GOOGL", maxLtv: "55.6%" },
  { symbol: "AMZN", maxLtv: "54.1%" },
  { symbol: "META", maxLtv: "52.6%" },
  { symbol: "NVDA", maxLtv: "50%" },
  { symbol: "AMD", maxLtv: "50%" },
  { symbol: "ORCL", maxLtv: "50%" },
  { symbol: "MU", maxLtv: "44.4%" },
  { symbol: "TSLA", maxLtv: "40%" },
] as const;

function MarketRow({ symbol, branchId }: { symbol: CollateralSymbol; branchId: BranchId }) {
  const collateral = getCollToken(branchId);
  const maxLtv = collateral?.collateralRatio
    ? `${(100 / collateral.collateralRatio).toFixed(1).replace(".0", "")}%`
    : "—";

  return (
    <tr>
      <td>
        <div className="rusd-market-name">
          <span className="rusd-ticker">{symbol}</span>
          <span className="rusd-market-meta">
            <span className="rusd-market-symbol">{symbol}</span>
            <span className="rusd-market-type">Isolated Stock Token market</span>
          </span>
        </div>
      </td>
      <td className="rusd-ltv">{maxLtv}</td>
      <td>
        <Link className="rusd-action" href={`/borrow/${symbol.toLowerCase()}`}>
          Borrow
        </Link>
      </td>
    </tr>
  );
}

function PreviewMarketRow({ symbol, maxLtv }: { symbol: string; maxLtv: string }) {
  return (
    <tr>
      <td>
        <div className="rusd-market-name">
          <span className="rusd-ticker">{symbol}</span>
          <span className="rusd-market-meta">
            <span className="rusd-market-symbol">{symbol}</span>
            <span className="rusd-market-type">Isolated Stock Token market</span>
          </span>
        </div>
      </td>
      <td className="rusd-ltv">{maxLtv}</td>
      <td>
        <span aria-disabled="true" className="rusd-action rusd-action-disabled">Not live</span>
      </td>
    </tr>
  );
}

export function HomeScreen() {
  const branches = READ_ONLY_DEPLOYMENT ? [] : getBranches();

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <h1>Borrow against Wall Street.</h1>
        <p className="rusd-hero-copy">
          Deposit a Stock Token. Borrow rUSD. Keep your market exposure.
        </p>
        {READ_ONLY_DEPLOYMENT && (
          <div className="rusd-preview-notice" role="status">
            Product preview only. No contracts are live and no funds can be deposited.
          </div>
        )}
      </section>

      <section className="rusd-market-panel">
        <h2 className="rusd-market-title">Markets</h2>
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
              ? MVP_MARKETS.map((market) => <PreviewMarketRow key={market.symbol} {...market} />)
              : branches.map(({ id, symbol }) => <MarketRow branchId={id} key={symbol} symbol={symbol} />)}
          </tbody>
        </table>
      </section>

      <aside className="rusd-info">
        <span aria-hidden="true" className="rusd-info-icon">i</span>
        <div>
          <strong>Your risk stays isolated.</strong>
          <p>
            If a vault crosses its maximum LTV, it can be liquidated. Market closures and oracle pauses can temporarily
            limit risky actions.
          </p>
        </div>
        {READ_ONLY_DEPLOYMENT
          ? <span className="rusd-preview-status">Contracts pending</span>
          : <Link className="rusd-text-link" href="/borrow">How borrowing works</Link>}
      </aside>

      <section className="rusd-how" aria-labelledby="rusd-how-title">
        <div className="rusd-how-heading">
          <h2 id="rusd-how-title">How borrowing works.</h2>
          <p>Three moves. One Stock Token per position. No cross-collateral spillover.</p>
        </div>

        <div className="rusd-how-grid">
          <article className="rusd-how-card rusd-how-card-market">
            <div className="rusd-how-media">
              <Image
                alt="Teal architectural walkways forming a layered geometric field"
                fill
                sizes="(max-width: 760px) calc(100vw - 20px), 58vw"
                src="/how-it-works/choose-market-unsplash.jpg"
              />
            </div>
            <div className="rusd-how-copy">
              <h3>Choose a Stock Token.</h3>
              <p>Pick one supported market. Each has its own maximum LTV and risk settings.</p>
            </div>
          </article>

          <article className="rusd-how-card rusd-how-card-isolated">
            <div className="rusd-how-media">
              <Image
                alt="A dark doorway isolated within concrete walls"
                fill
                sizes="(max-width: 760px) calc(100vw - 20px), 42vw"
                src="/how-it-works/isolated-position-unsplash.jpg"
              />
            </div>
            <div className="rusd-how-copy">
              <h3>Open an isolated position.</h3>
              <p>Deposit one Stock Token. It backs only this rUSD loan, so other positions stay separate.</p>
            </div>
          </article>

          <article className="rusd-how-card rusd-how-card-borrow">
            <div className="rusd-how-media">
              <Image
                alt="White architectural planes opening onto a teal sky"
                fill
                sizes="(max-width: 760px) calc(100vw - 20px), 42vw"
                src="/how-it-works/borrow-rusd-unsplash.jpg"
              />
            </div>
            <div className="rusd-how-copy">
              <h3>Borrow rUSD.</h3>
              <p>Set the debt amount, receive rUSD, and keep your Stock Token as collateral.</p>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}
