"use client";

import type { BranchId, CollateralSymbol } from "@/src/types";

import { getBranches, getCollToken } from "@/src/liquity-utils";
import Link from "next/link";

function FlowArrow() {
  return (
    <svg aria-hidden="true" className="rusd-flow-arrow" fill="none" viewBox="0 0 48 16">
      <path
        d="M2 8h40M36 3l6 5-6 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="8" cy="8" fill="currentColor" r="2" />
    </svg>
  );
}

function StockTokenIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <rect height="21" rx="4" stroke="currentColor" strokeWidth="1.7" width="25" x="4.5" y="6.5" />
      <rect height="21" opacity="0.45" rx="4" stroke="currentColor" strokeWidth="1.5" width="25" x="7.5" y="9.5" />
      <path
        d="m9 22 4-4 3 2 5-7 4 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path d="M9 12h6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function VaultIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <path
        d="M18 3.5 30 10v16L18 32.5 6 26V10L18 3.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle cx="18" cy="18" r="7" stroke="currentColor" strokeDasharray="3 2.2" strokeWidth="1.8" />
      <path d="M18 13.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z" fill="currentColor" opacity="0.16" />
      <circle cx="18" cy="18" fill="currentColor" r="2" />
      <path
        d="M18 4v4M30 10l-3.5 2M30 26l-3.5-2M18 32v-4M6 26l3.5-2M6 10l3.5 2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function RusdIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 36 36">
      <circle cx="18" cy="18" fill="currentColor" opacity="0.12" r="14" />
      <circle cx="18" cy="18" r="14" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 25V16c0-4 2.7-6.5 6.3-6.5s6.3 2.5 6.3 6.5v2.5c0 2.5 1.6 4 4.1 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="2.8"
      />
      <circle cx="16.3" cy="16" fill="currentColor" r="1.8" />
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
