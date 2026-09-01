"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { getBranches, getCollToken } from "@/src/liquity-utils";
import Link from "next/link";

function FlowArrow() {
  return (
    <svg aria-hidden="true" className="rusd-flow-arrow" fill="none" viewBox="0 0 48 16">
      <path
        d="M1 8h43M37 2l7 6-7 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function StockTokenIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <path d="m5 13 13-7 13 7H5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path
        d="M8 28h20M6 31h24M10 14v14M15 14v14M21 14v14M26 14v14"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function VaultIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <rect height="28" rx="3" stroke="currentColor" strokeWidth="1.8" width="28" x="4" y="4" />
      <rect height="22" rx="2" stroke="currentColor" strokeWidth="1.4" width="22" x="7" y="7" />
      <circle cx="18" cy="18" r="6" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" fill="currentColor" r="1.8" />
      <path
        d="M18 12v3M24 18h-3M18 24v-3M12 18h3M30 12h2M30 24h2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function RusdIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <path
        d="M5 29V16c0-5.6 3.7-9 9-9s9 3.4 9 9v4c0 3.6 2.3 6 6 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3.5"
      />
      <circle cx="14" cy="16" fill="currentColor" r="2.3" />
    </svg>
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

export function HomeScreen() {
  const branches = getBranches();

  return (
    <div className="rusd-home">
      <section className="rusd-hero">
        <h1>Borrow against Wall Street.</h1>
        <p className="rusd-hero-copy">
          Deposit a Stock Token. Borrow rUSD. Keep your market exposure.
        </p>
        <div aria-label="Stock Token to vault to rUSD" className="rusd-flow">
          <div className="rusd-flow-step">
            <span className="rusd-flow-icon">
              <StockTokenIcon />
            </span>
            Stock Token
          </div>
          <FlowArrow />
          <div className="rusd-flow-step">
            <span className="rusd-flow-icon">
              <VaultIcon />
            </span>
            Vault
          </div>
          <FlowArrow />
          <div className="rusd-flow-step">
            <span className="rusd-flow-icon">
              <RusdIcon />
            </span>
            rUSD
          </div>
        </div>
      </section>

      <section className="rusd-market-panel">
        <table className="rusd-market-table">
          <caption className="sr-only">
            Choose your collateral from {branches.length} isolated Stock Token markets
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
            {branches.map(({ id, symbol }) => <MarketRow branchId={id} key={symbol} symbol={symbol} />)}
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
        <Link className="rusd-text-link" href="/borrow">How borrowing works</Link>
      </aside>
    </div>
  );
}
