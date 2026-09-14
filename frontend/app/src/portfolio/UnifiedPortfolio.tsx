"use client";
import { StandingPortfolio } from "../facilities/StandingLoans";
import { EmptyState } from "../comps/EmptyState/EmptyState";

import { loadedP2PCredits } from "./model";
import { useState } from "react";
import type { ReactNode } from "react";
import { formatUnits } from "viem";
import type { Address } from "viem";
import type { Loan } from "../p2p/client";
import { displayDate, finalDeadline, loanState, shortAddress } from "../screens/P2PLoansScreen/loanPresentation";
import { p2pLink, poolLink, sameAccount } from "./model";
import type {
  MarketLoad,
  P2PMarket,
  P2PPosition,
  PoolMarket,
  PoolPosition,
  PortfolioMarket,
  PortfolioSource,
} from "./model";
import { usePortfolio } from "./usePortfolio";
import "./portfolio.css";

type Filter = "all" | "borrowing" | "lending" | "history";
const filters: Array<[Filter, string]> = [
  ["all", "All positions"],
  ["borrowing", "Borrowing"],
  ["lending", "Lending"],
  ["history", "P2P history"],
];
const usd = (amount: bigint) => `${formatUnits(amount, 6)} USDG`;
const settled = (loan: Loan) => !["open", "active"].includes(loan.status);
const defaulted = (loan: Loan, now: number) => loan.status === "active" && now > finalDeadline(loan);
const poolActive = (data: PoolPosition) => data.shares > 0n || data.debt > 0n || data.collateral > 0n;
const marketLabel = (market: PortfolioMarket) =>
  `${market.symbol}${
    market.legacy
      ? ` legacy (${shortAddress(market.kind === "pool" ? market.engine : market.deployment.address)})`
      : ""
  }`;

export type UnifiedPortfolioProps = {
  account: Address | null;
  chainId: number | null;
  sources: readonly PortfolioSource[];
  connecting?: boolean;
  walletError?: string | null;
  onConnect(): void;
  onDisconnect?(): void;
  profile?: ReactNode;
  expectedChainId?: number;
};

export function UnifiedPortfolio(props: UnifiedPortfolioProps) {
  const [hasStanding, setHasStanding] = useState(true);
  const wrongChain = !!props.account && props.chainId !== (props.expectedChainId ?? 4663);
  return (
    <div className="turret-portfolio">
      <header className="portfolio-heading">
        <div>
          <h1>Your portfolio</h1>
          <p>See what you have lent, what you owe, and what you can withdraw. These positions are held in contracts; they are not your wallet’s spendable balance.</p>
        </div>
        {props.account && (
          <div className="portfolio-identity" key={props.account}>
            {props.profile}
            <span title={props.account}>{shortAddress(props.account)}</span>
          </div>
        )}
      </header>
      {props.walletError && <p className="portfolio-feedback portfolio-error" role="alert">{props.walletError}</p>}
      {!props.account
        ? (
          <section className="portfolio-panel" aria-labelledby="portfolio-connect">
            <EmptyState heading="h2" id="portfolio-connect" title="Your lending, all in one place" description="Connect your wallet to see your loans, pool deposits and available withdrawals." actions={
            <button className="portfolio-button" disabled={props.connecting} onClick={props.onConnect}>
              {props.connecting ? "Connecting…" : "Connect wallet"}
            </button>}>
            <nav aria-label="Explore Turret">
              <a href="/borrow">Borrow</a>
              <a href="/earn">Earn</a>
              <a href="/borrow/p2p">P2P marketplace</a>
            </nav>
            </EmptyState>
          </section>
        )
        : wrongChain
        ? (
          <section className="portfolio-panel portfolio-empty" role="status">
            <h2>Switch to Robinhood Chain</h2>
            <p>Choose Robinhood Chain in your wallet to load your positions.</p>
            {props.onDisconnect && (
              <button className="portfolio-text-button" onClick={props.onDisconnect}>Disconnect</button>
            )}
          </section>
        )
        : (
          <><PortfolioPositions
            key={`${props.account.toLowerCase()}:${props.chainId}`}
            account={props.account}
            sources={props.sources}
            standingSeparate={hasStanding}
          /><StandingPortfolio key={props.account} account={props.account} onAvailability={setHasStanding} /></>
        )}
    </div>
  );
}

function PortfolioPositions({ account, sources, standingSeparate }: { account: Address; sources: readonly PortfolioSource[]; standingSeparate: boolean }) {
  const portfolio = usePortfolio(account, sources);
  const [filter, setFilter] = useState<Filter>("all");
  const pending = portfolio.sources.some((source) => source.phase === "loading")
    || portfolio.markets.some((entry) => entry.phase === "loading" || entry.refreshing);
  const failed = portfolio.sources.some((source) => source.phase === "error")
    || portfolio.markets.some((entry) => entry.phase === "error");
  const ready = portfolio.markets.filter((entry) => entry.data);
  const incomplete = pending || failed
    || ready.some((entry) => entry.data?.kind === "p2p" && (entry.data.nextCursor !== null || entry.data.activeLoansComplete === false)
      || entry.data?.kind === "nft" && entry.data.nextCursor !== null);
  const fresh = ready.filter((entry) => entry.phase === "ready" && !entry.refreshing);
  const poolsRead = fresh.some((entry) => entry.data?.kind === "pool");
  const p2pRead = fresh.some((entry) => entry.data?.kind === "p2p" || entry.data?.kind === "nft");
  let lent = 0n, borrowed = 0n, credits = 0n;
  for (const entry of fresh) {
    if (entry.data?.kind === "pool") {
      lent += entry.data.lendingAssets;
      borrowed += entry.data.debt;
    } else if (entry.data?.kind === "nft") {
      for (const loan of entry.data.offers) {
        if (sameAccount(loan.lender, account)) credits += loan.usdgCredit;
        if (loan.status === 2 && sameAccount(loan.terms.borrower, account) && entry.data.now <= Number(loan.dueAt) + 86400) borrowed += loan.terms.principal + loan.terms.interest;
      }
    } else if (entry.data?.kind === "p2p") {
      if (entry.market.kind === "p2p") credits += loadedP2PCredits(entry.market, entry.data).available.USDG;
      for (const loan of entry.data.offers) {
        if (sameAccount(loan.borrower, account) && loan.status === "active" && !defaulted(loan, entry.data.now)) {
          borrowed += loan.principal + loan.interest;
        }
      }
    }
  }
  const poolEntries = portfolio.markets.filter((entry) => entry.market.kind === "pool");
  const p2pEntries = portfolio.markets.filter((entry) => entry.market.kind === "p2p");
  const nftEntries = portfolio.markets.filter(entry => entry.market.kind === "nft");
  const poolRows = poolEntries.flatMap((entry) =>
    entry.market.kind === "pool" && entry.data?.kind === "pool" && poolActive(entry.data)
      && (filter === "all" || (filter === "borrowing" && (entry.data.collateral > 0n || entry.data.debt > 0n))
        || (filter === "lending" && entry.data.shares > 0n))
      ? [{ entry, market: entry.market, data: entry.data }]
      : []
  );
  const p2pRows = p2pEntries.flatMap((entry) => {
    if (entry.market.kind !== "p2p" || entry.data?.kind !== "p2p") return [];
    const market = entry.market, data = entry.data;
    return data.offers.filter((loan) =>
      filter === "history" ? settled(loan) : !settled(loan)
        && (filter === "all" || sameAccount(filter === "lending" ? loan.lender : loan.borrower, account))
    )
      .map((loan) => ({ entry, market, data, loan }));
  }).sort((a, b) =>
    b.loan.createdAt - a.loan.createdAt || a.market.id.localeCompare(b.market.id)
    || (a.loan.id > b.loan.id ? -1 : a.loan.id < b.loan.id ? 1 : 0)
  );
  const creditRows = p2pEntries.flatMap((entry) => {
    if (entry.market.kind !== "p2p" || entry.data?.kind !== "p2p") return [];
    const credit = loadedP2PCredits(entry.market, entry.data);
    return credit.unavailable || Object.values(credit.available).some(value => value > 0n) || Object.values(credit.shortfall).some(value => value > 0n)
      ? [{ entry, market: entry.market, data: entry.data, credit }] : [];
  });
  const sourceReady = (id: PortfolioSource["id"]) =>
    portfolio.sources.some((source) => source.id === id && source.phase === "ready");
  const sectionComplete = (id: PortfolioSource["id"], entries: MarketLoad[]) =>
    sourceReady(id) && entries.every((entry) => entry.phase === "ready");
  const sectionLoading = (id: PortfolioSource["id"], entries: MarketLoad[]) =>
    portfolio.sources.some((source) => source.id === id && source.phase === "loading")
    || entries.some((entry) => entry.phase === "loading");

  return (
    <>
      <div className="portfolio-toolbar">
        <p role="status">
          {pending
            ? `Loading positions · ${ready.length} markets ready`
            : failed
            ? "Some markets need a retry"
            : "Positions loaded"}
        </p>
        <button className="portfolio-text-button" onClick={portfolio.refreshAll} disabled={pending}>
          Refresh positions
        </button>
      </div>
      <section className="portfolio-overview" aria-label="Loaded portfolio balances">
        <dl>
          <div>
            <dt>Pool lending value</dt>
            <dd>{poolsRead ? usd(lent) : "—"}</dd>
          </div>
          <div>
            <dt>Borrowed, including interest</dt>
            <dd>{fresh.length ? usd(borrowed) : "—"}</dd>
          </div>
          <div>
            <dt>P2P USDG ready to withdraw</dt>
            <dd>{p2pRead ? usd(credits) : "—"}</dd>
          </div>
        </dl>
        <p>
          {incomplete
            ? "Partial totals from loaded positions. Unavailable or refreshing markets and older P2P loans are not included."
            : "Pool lending value is an estimate, not cash available now. Borrowed amounts are what you owe. P2P collateral credits are shown separately below."}
        </p>
      </section>
      {standingSeparate && <p className="portfolio-help">These totals cover pools, individual P2P loans and NFT loans. Standing loans and their withdrawals are shown separately below.</p>}
      <nav className="portfolio-tabs" aria-label="Filter portfolio">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      {filter !== "history" && creditRows.length > 0 && (
        <section className="portfolio-panel" aria-labelledby="portfolio-credits">
          <div className="portfolio-section-title">
            <h2 id="portfolio-credits">Ready to withdraw</h2>
            <span>P2P credits</span>
          </div>
          <p className="portfolio-help">
            These funds are assigned to you but still held in the P2P contract or loan vault. Withdraw them to move them into your wallet. This does not happen automatically.
          </p>
          {creditRows.map(({ entry, market, data, credit }) => (
            <article className="portfolio-row portfolio-credit-row" key={market.id}>
              <div>
                <h3>
                  {market.symbol} market{market.legacy && <span className="portfolio-status">{market.deployment.version === 2 ? "Previous contract" : "Original pilot"}</span>}
                </h3>
                <p className="portfolio-credit-amount">
                  {credit.available.USDG > 0n && <span>{usd(credit.available.USDG)}</span>}
                  {credit.available.COLLATERAL > 0n && (
                    <span>
                      {formatUnits(credit.available.COLLATERAL, market.deployment.collateralDecimals)} {market.symbol}
                    </span>
                  )}
                </p>
                {market.deployment.version === 3 && <p className="portfolio-help">Available from loaded loan vaults.{credit.unavailable ? " Some credit balances are unavailable. Refresh this market; the totals shown exclude unreadable credits." : ""}{credit.shortfall.USDG > 0n ? ` USDG shortfall: ${usd(credit.shortfall.USDG)}.` : ""}{credit.shortfall.COLLATERAL > 0n ? ` Collateral shortfall: ${formatUnits(credit.shortfall.COLLATERAL, market.deployment.collateralDecimals)} ${market.symbol}.` : ""}{data.nextCursor !== null ? " Load older loans to find earlier credits." : ""}</p>}
                <Freshness
                  entry={entry}
                  retry={() =>
                    portfolio.refreshMarket(market.id)}
                />
              </div>
              <a className="portfolio-row-link" href={`${p2pLink(market)}#p2p-credits`}>Withdraw funds</a>
            </article>
          ))}
        </section>
      )}
      {filter !== "history" && (
        <section className="portfolio-panel" aria-labelledby="portfolio-pools">
          <div className="portfolio-section-title">
            <h2 id="portfolio-pools">Pooled Borrow & Earn</h2>
            <span>Market positions</span>
          </div>
          {poolRows.map(({ entry, market, data }) => (
            <PoolRows
              key={market.id}
              entry={entry}
              market={market}
              data={data}
              filter={filter}
              retry={() => portfolio.refreshMarket(market.id)}
            />
          ))}
          {!poolRows.length && (sectionComplete("pools", poolEntries)
            ? (
              <Empty
                title={filter === "borrowing"
                  ? "No pooled loans"
                  : filter === "lending"
                  ? "No Earn deposits"
                  : "No pooled positions"}
              >
                <p>Borrow USDG against supported tokens, or deposit USDG into a pool. Your positions will appear here.</p>
                <nav aria-label="Open pool positions">
                  <a href="/borrow">Borrow</a>
                  <a href="/earn">Earn</a>
                </nav>
              </Empty>
            )
            : sectionLoading("pools", poolEntries)
            ? <LoadingPlaceholder label="Loading pooled positions" />
            : (
              <Empty title="Pooled positions are unavailable">
                <p>Retry the affected markets below to load your positions.</p>
              </Empty>
            ))}
          <ReadStatus
            source={portfolio.sources.find((source) => source.id === "pools")}
            entries={poolEntries}
            retrySource={() => portfolio.retrySource("pools")}
            retry={portfolio.refreshMarket}
          />
        </section>
      )}
      <section className="portfolio-panel" aria-labelledby="portfolio-p2p">
        <div className="portfolio-section-title">
          <h2 id="portfolio-p2p">{filter === "history" ? "P2P loan history" : "P2P loans & offers"}</h2>
          <span>Direct wallet agreements</span>
        </div>
        {filter === "history" && (
          <p className="portfolio-help">
            Repaid, cancelled, expired and collateral-settled loans, including original pilot loans.
          </p>
        )}
        {p2pRows.map(({ entry, market, data, loan }) => (
          <LoanRow
            key={`${market.id}:${loan.id}`}
            entry={entry}
            market={market}
            data={data}
            loan={loan}
            account={account}
          />
        ))}
        {!p2pRows.length && (sectionComplete("p2p", p2pEntries)
          ? (
            <Empty title={filter === "history" ? "No completed P2P loans in these results" : "No P2P loans or offers here"}>
              <p>
                {p2pEntries.some((entry) => entry.data?.kind === "p2p" && entry.data.nextCursor !== null)
                  ? "Load older loans below to check the rest of your history."
                  : "Offers you fund and loans you accept with this wallet will appear here."}
              </p>
              {filter !== "history" && <a href="/borrow/p2p">Explore P2P offers</a>}
            </Empty>
          )
          : sectionLoading("p2p", p2pEntries)
          ? <LoadingPlaceholder label="Loading P2P positions" />
          : (
            <Empty title="P2P positions are unavailable">
              <p>Retry the affected markets below to load your positions.</p>
            </Empty>
          ))}
        <ReadStatus
          source={portfolio.sources.find((source) => source.id === "p2p")}
          entries={p2pEntries}
          retrySource={() => portfolio.retrySource("p2p")}
          retry={portfolio.refreshMarket}
        />
        {p2pEntries.some(entry => entry.data?.kind === "p2p" && entry.data.activeLoansComplete === false) && <p role="status" className="portfolio-help">
          Active-loan discovery is still updating for some markets. Known positions remain visible. <a href="/borrow/p2p#loans">Open a loan by its market and ID</a> if a payment is due.
        </p>}
        {p2pEntries.filter((entry) => entry.data?.kind === "p2p" && entry.data.nextCursor !== null).map((entry) => (
          <div className="portfolio-pagination" key={entry.market.id}>
            {entry.olderError && <p role="alert" className="portfolio-error">{entry.olderError}</p>}
            <button
              className="portfolio-text-button"
              disabled={entry.loadingOlder || entry.refreshing}
              onClick={() =>
                portfolio.loadOlder(entry.market.id)}
            >
              {entry.loadingOlder
                ? "Loading older loans…"
                : `Load older ${entry.market.symbol}${entry.market.legacy ? " pilot" : ""} loans`}
            </button>
          </div>
        ))}
      </section>
      {portfolio.sources.some(source => source.id === "nft") && <section className="portfolio-panel" aria-labelledby="portfolio-nfts">
        <div className="portfolio-section-title"><h2 id="portfolio-nfts">NFT loans & offers</h2><a href="/borrow/nfts">NFT marketplace</a></div>
        {nftEntries.map(entry => {
          if (entry.market.kind !== "nft" || entry.data?.kind !== "nft") return null;
          const market = entry.market, data = entry.data;
          const rows = data.offers.filter(loan => filter === "history" ? loan.status > 2
            : (loan.status <= 2 || loan.usdgCredit > 0n || sameAccount(loan.nftBeneficiary, account))
              && (filter === "all" || sameAccount(filter === "lending" ? loan.lender : loan.terms.borrower, account)));
          return <div key={market.id}>
            {rows.map(loan => <article className="portfolio-row" key={String(loan.id)}>
              <div className="portfolio-row-heading"><h3>{market.deployment.collections.find(c => sameAccount(c.address, loan.terms.collection))?.name ?? "NFT"} #{String(loan.terms.tokenId)}</h3>
                <a className="portfolio-row-link" href={`/borrow/nfts?offer=${loan.id}`}>Manage NFT loan #{String(loan.id)}</a></div>
              <p className="portfolio-row-note">{sameAccount(loan.lender, account) ? "You are the lender" : "You are the borrower"} · {loan.status === 2 && data.now > Number(loan.dueAt) + 86400 ? "Default claim available" : ["Unknown", "Funded offer", "Loan active", "Repaid", "Defaulted", "Cancelled", "Expired"][loan.status]}</p>
              <dl className="portfolio-row-values"><div><dt>Principal</dt><dd>{usd(loan.terms.principal)}</dd></div>
                <div><dt>Full repayment</dt><dd>{usd(loan.terms.principal + loan.terms.interest)}</dd></div>
                {sameAccount(loan.lender, account) && loan.usdgCredit > 0n && <div><dt>USDG credit</dt><dd>{usd(loan.usdgCredit)}</dd></div>}
                {sameAccount(loan.nftBeneficiary, account) && <div><dt>NFT withdrawal</dt><dd>Available</dd></div>}
                {loan.dueAt > 0n && <div><dt>Final repayment deadline</dt><dd>{displayDate(Number(loan.dueAt) + 86400)}</dd></div>}
              </dl><Freshness entry={entry} retry={() => portfolio.refreshMarket(market.id)} />
            </article>)}
            {!rows.length && <EmptyState title={filter === "history" ? "No completed NFT loans in this page" : "No NFT positions in these results"} description={data.nextCursor !== null ? "More loans may exist. Load the next page below to check your earlier positions." : "NFT offers you fund and loans you accept with this wallet will appear here."} actions={filter !== "history" && <a className="portfolio-button" href="/borrow/nfts">Explore NFT loans</a>} />}
            {data.nextCursor !== null && <div className="portfolio-pagination"><p className="portfolio-help">More NFT positions may exist. Totals include only loaded loans.</p>
              {entry.olderError && <p role="alert">{entry.olderError}</p>}<button className="portfolio-text-button" disabled={entry.loadingOlder || entry.refreshing} onClick={() => portfolio.loadOlder(market.id)}>Load more NFT loans</button></div>}
          </div>;
        })}
        {sectionLoading("nft", nftEntries) && <LoadingPlaceholder label="Loading NFT positions" />}
        {sectionComplete("nft", nftEntries) && !nftEntries.length && <p className="portfolio-help">No NFT lending deployment is configured.</p>}
        <ReadStatus source={portfolio.sources.find(source => source.id === "nft")} entries={nftEntries} retrySource={() => portfolio.retrySource("nft")} retry={portfolio.refreshMarket} />
      </section>}
      <p className="portfolio-footnote">
        Each position is managed in its own market. Pooled Earn funds lending pools; P2P offers reserve a lender’s USDG
        for one loan. Funds committed to an active P2P loan are unavailable to withdraw.
      </p>
    </>
  );
}

function PoolRows(
  { entry, market, data, filter, retry }: {
    entry: MarketLoad;
    market: PoolMarket;
    data: PoolPosition;
    filter: Filter;
    retry(): void;
  },
) {
  return (
    <div className="portfolio-market-group">
      {data.shares > 0n && filter !== "borrowing" && (
        <article className="portfolio-row">
          <div className="portfolio-row-heading">
            <div>
              <h3>{market.symbol} Earn{market.legacy && <span className="portfolio-status">Legacy pool</span>}</h3>
              {market.legacy && <p className="portfolio-row-meta">Market {shortAddress(market.engine)}</p>}
            </div>
            <a className="portfolio-row-link" href={poolLink(market, "earn")}>Manage lending</a>
          </div>
          <p className="portfolio-row-note">You are lending USDG to this pool. Your shares represent your claim on its assets; only the withdrawable amount can be collected now.</p>
          <dl className="portfolio-row-values">
            <div>
              <dt>Estimated lending value</dt>
              <dd>{usd(data.lendingAssets)}</dd>
            </div>
            <div>
              <dt>Withdrawable now</dt>
              <dd>{usd(data.maxWithdraw)}</dd>
            </div>
          </dl>
          <Freshness entry={entry} retry={retry} />
        </article>
      )}
      {(data.collateral > 0n || data.debt > 0n) && filter !== "lending" && (
        <article className="portfolio-row">
          <div className="portfolio-row-heading">
            <div>
              <h3>{market.symbol} Borrow{market.legacy && <span className="portfolio-status">Legacy market</span>}</h3>
              {market.legacy && <p className="portfolio-row-meta">Market {shortAddress(market.engine)}</p>}
            </div>
            <a className="portfolio-row-link" href={poolLink(market, "borrow")}>Manage loan</a>
          </div>
          <p className="portfolio-row-note">{data.debt > 0n ? "You are the borrower. This debt is what you owe, not money available to spend." : "You have collateral in the contract and no outstanding debt. Depositing collateral alone does not give you USDG."}</p>
          <dl className="portfolio-row-values">
            <div>
              <dt>Debt including interest</dt>
              <dd>{usd(data.debt)}</dd>
            </div>
            <div>
              <dt>Collateral deposited</dt>
              <dd>{formatUnits(data.collateral, market.collateralDecimals)} {market.symbol}</dd>
            </div>
          </dl>
          <Freshness entry={entry} retry={retry} />
        </article>
      )}
    </div>
  );
}

function LoanRow(
  { entry, market, data, loan, account }: {
    entry: MarketLoad;
    market: P2PMarket;
    data: P2PPosition;
    loan: Loan;
    account: Address;
  },
) {
  const lender = sameAccount(loan.lender, account);
  const missed = defaulted(loan, data.now);
  const state = loanState(loan, data.now);
  return (
    <article className="portfolio-row">
      <div className="portfolio-row-heading">
        <div>
          <h3>
            {market.symbol}{" "}
            {loan.status === "open" ? lender ? "offer" : "offer for you" : lender ? "P2P lending" : "P2P borrowing"}
            {" "}
            <span className="portfolio-loan-id">#{loan.id.toString()}</span>
          </h3>
          <p className="portfolio-row-meta">{state}{market.deployment.version === 3 ? " · V3 isolated vault" : market.legacy ? market.deployment.version === 2 ? " · Previous contract" : " · Original pilot" : ""}</p>
        </div>
        <a className="portfolio-row-link" href={p2pLink(market, loan.id)}>
          {settled(loan) ? "View loan" : "Manage P2P loan"}
        </a>
      </div>
      <p className="portfolio-row-note">{lender
        ? "You are the lender. You supplied the USDG; the borrower supplies the collateral."
        : loan.status === "open" ? "You are the invited borrower. No USDG has been sent to you yet. Accepting deposits your collateral and starts the loan."
        : "You are the borrower. You received the USDG and supplied the collateral."}</p>
      <dl className="portfolio-row-values">
        <div>
          <dt>{loan.status === "open" ? "Reserved funding" : "Principal"}</dt>
          <dd>{usd(loan.principal)}</dd>
        </div>
        <div>
          <dt>Collateral{loan.status === "claimed" ? " settled" : loan.status === "open" ? " required" : ""}</dt>
          <dd>{formatUnits(loan.collateral, market.deployment.collateralDecimals)} {market.symbol}</dd>
        </div>
      </dl>
      {loan.status === "active" && !missed && (
        <p className="portfolio-row-note">
          Full repayment: <strong>{usd(loan.principal + loan.interest)}</strong>. Due{" "}
          {displayDate(loan.dueAt)}. Final deadline {displayDate(finalDeadline(loan))}.
        </p>
      )}
      {missed && (
        <p className="portfolio-row-note portfolio-risk">
          The final deadline passed. {market.deployment.version === 3 ? "The remaining collateral" : "All collateral"} is claimable by the lender; no further USDG repayment is due.
        </p>
      )}
      {loan.status === "open" && (
        <p className="portfolio-row-note">
          {data.now >= loan.expiresAt
            ? "Expired funding can be credited back to the lender."
            : `Expires ${displayDate(loan.expiresAt)}. Open offers earn no interest.`}
        </p>
      )}
      {loan.status === "repaid" && (
        <p className="portfolio-row-note">
          Repaid in full. Any unwithdrawn repayment or collateral appears in Ready to withdraw.
        </p>
      )}
      {loan.status === "claimed" && (
        <p className="portfolio-row-note">
          All collateral was credited to the lender. No further USDG repayment is due.
        </p>
      )}
      {entry.refreshing && (
        <p className="portfolio-freshness" role="status">Refreshing this market… Displaying its previous read.</p>
      )}
      {entry.phase === "error" && (
        <p className="portfolio-freshness">
          This position is from an earlier read. Retry the market below for current amounts.
        </p>
      )}
    </article>
  );
}

function Freshness({ entry, retry }: { entry: MarketLoad; retry(): void }) {
  if (entry.refreshing) {
    return <p className="portfolio-freshness" role="status">Refreshing this market… Displaying its previous read.</p>;
  }
  if (entry.phase === "error") {
    return (
      <p className="portfolio-freshness">
        Previous read · Could not refresh.{" "}
        <button className="portfolio-inline-button" onClick={retry}>Retry market</button>
      </p>
    );
  }
  return null;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EmptyState title={title} illustration={!title.includes("unavailable")}>{children}</EmptyState>
  );
}
function LoadingPlaceholder({ label }: { label: string }) {
  return (
    <div className="portfolio-loading" role="status">
      <span>{label}…</span>
      <div aria-hidden="true">
        <i />
        <i />
      </div>
    </div>
  );
}
function ReadStatus(
  { source, entries, retrySource, retry }: {
    source?: { label: string; phase: string; error?: string };
    entries: MarketLoad[];
    retrySource(): void;
    retry(id: string): void;
  },
) {
  const problems = entries.filter((entry) => entry.phase === "error");
  const loading = entries.filter((entry) => entry.phase === "loading");
  return (
    <div className="portfolio-read-status">
      {source?.phase === "error" && (
        <div role="alert" className="portfolio-feedback portfolio-error">
          <p>{source.label} could not be loaded. {source.error}</p>
          <button className="portfolio-text-button" onClick={retrySource}>Retry {source.label.toLowerCase()}</button>
        </div>
      )}
      {problems.map((entry) => (
        <div role="alert" className="portfolio-market-error" key={entry.market.id}>
          <p>
            <strong>{marketLabel(entry.market)} market unavailable.</strong> {entry.error}
          </p>
          <button className="portfolio-text-button" onClick={() => retry(entry.market.id)}>
            Retry {marketLabel(entry.market)} market
          </button>
        </div>
      ))}
      {loading.length > 0 && (
        <p className="portfolio-freshness" role="status">
          Still loading {loading.length}{" "}
          {loading.length === 1 ? "market" : "markets"}. Ready positions remain available.
        </p>
      )}
    </div>
  );
}
