"use client";

import type { BranchId } from "@/src/types";

import { Amount } from "@/src/comps/Amount/Amount";
import { SboldPositionSummary } from "@/src/comps/EarnPositionSummary/SboldPositionSummary";
import { YboldPositionSummary } from "@/src/comps/EarnPositionSummary/YboldPositionSummary";
import { READ_ONLY_DEPLOYMENT } from "@/src/deployment-config";
import { fmtnum } from "@/src/formatting";
import { getBranches, getCollToken, isEarnPositionActive, useEarnPool, useEarnPosition } from "@/src/liquity-utils";
import { isSboldEnabled, useSboldPosition } from "@/src/sbold";
import { useAccount } from "@/src/wagmi-utils";
import { isYboldEnabled } from "@/src/ybold";
import Link from "next/link";

const PREVIEW_POOLS = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "NVDA", name: "Nvidia" },
  { symbol: "AMD", name: "Advanced Micro Devices" },
  { symbol: "ORCL", name: "Oracle" },
  { symbol: "MU", name: "Micron" },
  { symbol: "TSLA", name: "Tesla" },
] as const;

function EarnIntroduction() {
  return (
    <section className="rusd-earn-hero">
      <div className="rusd-earn-message">
        <h1>Put your rUSD to work.</h1>
        <p>
          Deposit rUSD into a Stock Token market. You earn a share of borrower interest and may receive Stock Token
          collateral when loans are liquidated.
        </p>
        <a className="rusd-earn-learn" href="#market-pools">
          See available pools
          <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
            <path d="M8 3v10M4 9l4 4 4-4" />
          </svg>
        </a>
      </div>

      <div className="rusd-earn-mechanism">
        <div className="rusd-earn-mechanism-head">
          <strong>How returns reach you</strong>
          <span>Pool activity</span>
        </div>
        <div className="rusd-earn-source">
          <span>Your deposit</span>
          <strong>rUSD</strong>
        </div>
        <div aria-hidden="true" className="rusd-earn-route">
          <svg fill="none" viewBox="0 0 16 18">
            <path d="M8 2.5v12M3.5 10 8 14.5l4.5-4.5" />
          </svg>
        </div>
        <div className="rusd-earn-returns">
          <div>
            <span>Borrower interest</span>
            <strong>Paid in rUSD</strong>
          </div>
          <div>
            <span>Liquidation proceeds</span>
            <strong>Paid in Stock Tokens</strong>
          </div>
        </div>
        <p>Returns depend on borrowing and liquidation activity in the pool you choose.</p>
      </div>
    </section>
  );
}

function PoolsHeading({ count }: { count: number }) {
  return (
    <div className="rusd-earn-pools-heading">
      <div>
        <h2>Choose a market pool.</h2>
        <p>Each pool is tied to one Stock Token market, keeping deposits and rewards separate.</p>
      </div>
      <span>{count} isolated pools</span>
    </div>
  );
}

function PreviewPools() {
  return (
    <section className="rusd-earn-pools" id="market-pools">
      <PoolsHeading count={PREVIEW_POOLS.length} />
      <div className="rusd-earn-table" role="table" aria-label="Preview Stability Pools">
        <div className="rusd-earn-row rusd-earn-row-head" role="row">
          <span role="columnheader">Pool</span>
          <span role="columnheader">Current APR</span>
          <span role="columnheader">Pool deposits</span>
          <span role="columnheader">
            <span className="sr-only">Status</span>
          </span>
        </div>
        {PREVIEW_POOLS.map((pool) => (
          <div className="rusd-earn-row" role="row" key={pool.symbol}>
            <div className="rusd-earn-pool-name" role="cell">
              <span className="rusd-earn-ticker">{pool.symbol}</span>
              <span>
                <strong>{pool.name}</strong>
                <small>Stability Pool</small>
              </span>
            </div>
            <span className="rusd-earn-value" role="cell">—</span>
            <span className="rusd-earn-value rusd-earn-tvl" role="cell">—</span>
            <span className="rusd-earn-action rusd-earn-action-disabled" role="cell">Not live</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveEarnPool({ branchId }: { branchId: BranchId }) {
  const account = useAccount();
  const pool = useEarnPool(branchId);
  const position = useEarnPosition(branchId, account.address ?? null);
  const token = getCollToken(branchId);
  const active = isEarnPositionActive(position.data ?? null);
  const poolUnavailable = pool.isError || (pool.isSuccess && !pool.data);

  return (
    <div className="rusd-earn-row" role="row">
      <div className="rusd-earn-pool-name" role="cell">
        <span className="rusd-earn-ticker">{token.symbol}</span>
        <span>
          <strong>{token.name}</strong>
          <small>Stability Pool</small>
        </span>
      </div>
      <span className="rusd-earn-value" role="cell">
        <Amount fallback="—" format="1z" percentage value={pool.data?.apr} />
      </span>
      <span className="rusd-earn-value rusd-earn-tvl" role="cell">
        <Amount fallback="—" format="compact" prefix="$" value={pool.data?.totalDeposited} />
      </span>
      <div className="rusd-earn-action-cell" role="cell">
        {pool.isSuccess && pool.data
          ? (
            <Link className="rusd-earn-action" href={`/earn/${token.symbol.toLowerCase()}`}>
              {active ? `Manage ${fmtnum(position.data?.deposit)} rUSD` : "Deposit"}
            </Link>
          )
          : (
            <span className="rusd-earn-action rusd-earn-action-disabled">
              {poolUnavailable ? "Unavailable" : "Loading"}
            </span>
          )}
      </div>
    </div>
  );
}

function LivePools() {
  const branches = getBranches();

  return (
    <section className="rusd-earn-pools" id="market-pools">
      <PoolsHeading count={branches.length} />
      <div className="rusd-earn-table" role="table" aria-label="Stability Pools">
        <div className="rusd-earn-row rusd-earn-row-head" role="row">
          <span role="columnheader">Pool</span>
          <span role="columnheader">Current APR</span>
          <span role="columnheader">Pool deposits</span>
          <span role="columnheader">
            <span className="sr-only">Action</span>
          </span>
        </div>
        {branches.map((branch) => <LiveEarnPool branchId={branch.id} key={branch.id} />)}
      </div>
      <OptionalYieldPools />
    </section>
  );
}

function OptionalYieldPools() {
  if (!isSboldEnabled() && !isYboldEnabled()) {
    return null;
  }

  return (
    <div className="rusd-earn-legacy-pools">
      {isSboldEnabled() && <SboldPool />}
      {isYboldEnabled() && <YboldPositionSummary />}
    </div>
  );
}

function SboldPool() {
  const account = useAccount();
  const sboldPosition = useSboldPosition(account.address ?? null);
  return <SboldPositionSummary linkToScreen sboldPosition={sboldPosition.data ?? null} />;
}

export function EarnPoolsListScreen() {
  return (
    <div className="rusd-earn-screen">
      <EarnIntroduction />
      {READ_ONLY_DEPLOYMENT ? <PreviewPools /> : <LivePools />}
      <aside className="rusd-earn-note">
        <strong>Rewards follow pool activity.</strong>
        <p>
          Interest and Stock Token rewards vary over time. Deposited rUSD may be used to repay liquidated debt, with the
          corresponding collateral distributed to that pool.
        </p>
      </aside>
    </div>
  );
}
