import { useEffect, useState } from "react";
import { EmptyState } from "../../comps/EmptyState/EmptyState";
import type { Deployment } from "../../p2p/client";
import { WalletAvatar } from "../../profiles/WalletAvatar";
import {
  collateralAmount, displayDate, fixedInterestPercent, loanAmount, offerKey, parseAmount,
  shortAddress, sortOffers,
} from "./loanPresentation";
import type { Offer } from "./loanPresentation";

const PAGE_SIZE = 12;

export function OfferListSkeleton() {
  return (
    <div role="status" aria-label="Loading public offers">
      <div className="p2p-offer-results" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div className="p2p-browse-offer" key={row}>
            <div className="p2p-browse-asset p2p-skeleton-stack">
              <span className="p2p-skeleton-bar p2p-skeleton-title" />
              <span className="p2p-skeleton-bar" />
              <span className="p2p-skeleton-bar p2p-skeleton-short" />
            </div>
            <div className="p2p-browse-terms">
              {[0, 1, 2].map((term) => (
                <div className="p2p-skeleton-stack" key={term}>
                  <span className="p2p-browse-mobile-label"><span className="p2p-skeleton-bar p2p-skeleton-short" /></span>
                  <span className="p2p-skeleton-bar p2p-skeleton-title" />
                  <span className="p2p-skeleton-bar" />
                </div>
              ))}
            </div>
            <div className="p2p-browse-lender">
              <span className="p2p-skeleton-bar p2p-skeleton-avatar" />
              <span className="p2p-skeleton-bar" />
            </div>
            <span className="p2p-skeleton-bar p2p-skeleton-action" />
            <div className="p2p-browse-expiry"><span className="p2p-skeleton-bar p2p-skeleton-expiry" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PublicOfferBrowser({
  offers, markets, assetFilter, onAssetChange, onReview, onCreate, hasMore, loading, failed,
  loadMoreDisabled, onLoadMore, onRequest,
}: {
  offers: Offer[];
  markets: Deployment[];
  assetFilter: string;
  onAssetChange: (asset: string) => void;
  onReview: (offer: Offer) => void;
  onCreate: () => void;
  onRequest?: () => void;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  loadMoreDisabled: boolean;
  onLoadMore: () => void;
}) {
  const [search, setSearch] = useState("");
  const [minimum, setMinimum] = useState("");
  const [maximumDays, setMaximumDays] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [search, assetFilter, minimum, maximumDays, sort]);
  const query = search.trim().toLowerCase();
  let filterError = "", minimumValue = 0n;
  try {
    if (minimum.trim()) minimumValue = parseAmount(minimum, 6);
  } catch {
    filterError = "Enter a valid minimum USDG amount.";
  }
  if (maximumDays && (!/^\d+$/.test(maximumDays) || !Number.isSafeInteger(Number(maximumDays))
    || Number(maximumDays) <= 0)) filterError = "Enter a positive whole number for maximum days.";
  const filtered = sortOffers(offers.filter(({ market, loan }) =>
    (!assetFilter || market.collateralSymbol === assetFilter)
    && (!query || `${market.collateralSymbol} ${market.collateralName ?? ""} ${loan.lender}`.toLowerCase().includes(query))
    && loan.principal * 1_000_000n >= minimumValue * 10n ** BigInt(market.loanDecimals)
    && (!maximumDays || loan.durationDays <= Number(maximumDays))
  ), sort);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const first = currentPage * PAGE_SIZE;
  const visible = filtered.slice(first, first + PAGE_SIZE);
  const hasFilters = !!(search || assetFilter || minimum || maximumDays);
  function clearFilters() {
    setSearch(""); onAssetChange(""); setMinimum(""); setMaximumDays(""); setPage(0);
  }
  const symbols = [...new Set(markets.map((market) => market.collateralSymbol))].sort((a, b) => a.localeCompare(b));
  const emptyMarket = !offers.length && !loading && !failed && !hasMore && !hasFilters;
  return (
    <section className="p2p-browser" aria-labelledby="p2p-public-title">
      {!emptyMarket && <><div className="p2p-browser-heading">
        <div className="p2p-section-heading">
          <h2 id="p2p-public-title">Borrow from a funded offer</h2>
          <p>Choose a loan, deposit the required collateral and receive USDG. The full repayment is fixed from the start.</p>
        </div>
        {(visible.length > 0 || loading) && <button className="p2p-button p2p-secondary" aria-haspopup={onRequest ? "dialog" : undefined} onClick={onRequest ?? onCreate}>{onRequest ? "Request your own terms" : "Create an offer"}</button>}
      </div>
      <div className="p2p-browse-search">
        <label>
          Search offers
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder="Asset name, symbol or lender address" />
        </label>

      </div>
      <details className="p2p-more-filters"><summary>Sort and filter offers{hasFilters ? " · filters applied" : ""}</summary><div className="p2p-browse-filters">
        <label>
          Sort offers
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="newest">Newest first</option>
            <option value="amount-desc">Loan amount · high to low</option>
            <option value="amount">Loan amount · low to high</option>
            <option value="rate">Interest % · low to high</option>
            <option value="rate-desc">Interest % · high to low</option>
            <option value="duration">Duration · shortest first</option>
            <option value="duration-desc">Duration · longest first</option>
            <option value="expiry">Expiring soonest</option>
          </select>
        </label>
        <label>Collateral
          <select value={assetFilter} onChange={(event) => onAssetChange(event.target.value)}>
            <option value="">All collateral</option>
            {symbols.map((symbol) => <option key={symbol}>{symbol}</option>)}
          </select>
        </label>
        <label>Minimum loan · USDG
          <input inputMode="decimal" value={minimum} onChange={(event) => setMinimum(event.target.value)}
            placeholder="Any amount" />
        </label>
        <label>Maximum days
          <input inputMode="numeric" value={maximumDays} onChange={(event) => setMaximumDays(event.target.value)}
            placeholder="Any duration" />
        </label>
      </div></details></>}
      {(filtered.length > 0 || loading || filterError) && <div className="p2p-browse-results">
        <p role="status" aria-label="Offer results" className={loading && !filtered.length && !filterError ? "p2p-skeleton-result" : undefined}>
          {filterError ? "Check your filters" : filtered.length
            ? `${first + 1}–${Math.min(first + PAGE_SIZE, filtered.length)} of ${filtered.length} offers${hasFilters ? " matching your filters" : ""}`
            : loading ? <span className="p2p-skeleton-bar" aria-label="Loading offer results" /> : "0 offers"}
          {(filtered.length > 0 || !loading) && (loading || hasMore) && <span> · More offers may be available</span>}
        </p>
        {hasFilters && <button className="p2p-reset" onClick={clearFilters}>Clear filters</button>}
      </div>}
      {filterError ? <p className="p2p-feedback p2p-error" role="alert">{filterError}</p>
        : visible.length ? (
          <>
            <div className="p2p-offer-columns" aria-hidden="true">
              <span>Collateral at risk</span><span>You receive</span><span>Total repayment</span>
              <span>Repay within</span><span>Lender</span><span />
            </div>
            <div className="p2p-offer-results">
              {visible.map((offer) => {
                const { market, loan } = offer;
                return (
                  <article className="p2p-browse-offer" key={offerKey(offer)}
                    data-offer-key={offerKey(offer)} aria-label={`${market.collateralSymbol} offer ${loan.id}`}>
                    <div className="p2p-browse-asset">
                      <h3>{market.collateralSymbol} <span>#{loan.id.toString()}</span></h3>
                      <strong>{collateralAmount(loan.collateral, market)}</strong>
                      <span className="p2p-browse-asset-name">{market.collateralName ?? market.collateralSymbol}</span>
                    </div>
                    <dl className="p2p-browse-terms">
                      <div><dt>You receive</dt><dd><strong>{loanAmount(loan.principal, market)}</strong>
                        <span>USDG to your wallet</span></dd></div>
                      <div><dt>Total repayment</dt><dd><strong>{loanAmount(loan.principal + loan.interest, market)}</strong>
                        <span>Includes {loanAmount(loan.interest, market)} interest · {fixedInterestPercent(loan)} for the full term</span></dd></div>
                      <div><dt>Repay within</dt><dd><strong>{loan.durationDays} days</strong><span>From acceptance + 24h grace</span></dd></div>
                    </dl>
                    <div className="p2p-browse-lender" title={loan.lender}>
                      <WalletAvatar address={loan.lender} size={28} />
                      <span><span className="p2p-browse-mobile-label">Lender</span>{shortAddress(loan.lender)}</span>
                    </div>
                    <button className="p2p-button p2p-secondary" onClick={() => onReview(offer)}>Review loan</button>
                    {market.version === 3 && (loan.fundingAvailable === undefined || loan.fundingAvailable < loan.principal) && <p className="p2p-help">{loan.fundingAvailable === undefined ? "Funding balance unavailable. Refresh before accepting." : "Funding shortfall. This offer cannot currently be accepted."}</p>}
                    <p className="p2p-browse-expiry">Offer expires {displayDate(loan.expiresAt)}</p>
                  </article>
                );
              })}
            </div>
          </>
        ) : loading ? <OfferListSkeleton /> : (
          <EmptyState
            heading={emptyMarket ? "h2" : "h3"}
            id={emptyMarket ? "p2p-public-title" : undefined}
            illustration={!failed}
            title={failed ? "We couldn’t load all offers" : hasFilters ? "No offers match your search" : hasMore ? "No offers in this batch" : "No loans ready to borrow"}
            description={failed ? "Some markets didn’t respond. Retry the affected markets above before treating these results as empty."
              : hasFilters ? "Try another asset, a smaller amount or a longer duration. You can also clear your filters."
              : hasMore ? "Earlier offers haven’t been checked yet. Load more to keep looking, or ask lenders for the terms you need."
              : "Tell lenders how much USDG you need and which tokens you can pledge."}
            actions={!failed && <>
              {hasFilters && <button className="p2p-button" onClick={clearFilters}>Clear filters</button>}
              {!hasFilters && hasMore && <button className="p2p-button" disabled={loadMoreDisabled} onClick={onLoadMore}>Load more offers</button>}
              {onRequest ? <button className={hasFilters || hasMore ? "p2p-button p2p-secondary" : "p2p-button"} aria-haspopup="dialog" onClick={onRequest}>Request a loan</button> : <button className={hasFilters || hasMore ? "p2p-button p2p-secondary" : "p2p-button"} onClick={onCreate}>Create an offer</button>}
            </>}
          />
        )}
      {!filterError && pages > 1 && (
        <nav className="p2p-pagination" aria-label="Offer pages">
          <button className="p2p-button p2p-secondary" disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}>Previous</button>
          <span>Page {currentPage + 1} of {pages}</span>
          <button className="p2p-button p2p-secondary" disabled={currentPage + 1 === pages}
            onClick={() => setPage(currentPage + 1)}>Next</button>
        </nav>
      )}
      {(visible.length > 0 || hasMore || loading) && <div className="p2p-browse-note">
        {visible.length > 0 && <p className="p2p-help">No price-triggered liquidation. If you miss the final repayment deadline, the lender receives the collateral. Early repayment still includes the full interest.</p>}
        {(hasMore || loading) && <p className="p2p-help">Sorting and filters apply to loaded offers. {hasMore
          ? "Load more public offers to include earlier offers."
          : "Results update as the remaining markets load."}</p>}
        {hasMore && (visible.length > 0 || hasFilters || failed) && <button className="p2p-button p2p-secondary" disabled={loadMoreDisabled} onClick={onLoadMore}>
          Load more public offers
        </button>}
      </div>}
    </section>
  );
}
