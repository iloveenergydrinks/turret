import { memecoinMarkets } from "../../borrow/memecoin-offers";
import { CollateralLogo } from "./CollateralLogo";
import { OfferListSkeleton } from "./PublicOfferBrowser";
import { Fragment, useEffect, useState } from "react";
import type { Address } from "viem";
import { EmptyState } from "../../comps/EmptyState/EmptyState";
import type { Deployment } from "../../p2p/client";
import { TermsSummary, type RequestBoard } from "./BorrowerRequests";
import { offerKey, parseAmount, sameAddress, shortAddress, type Offer } from "./loanPresentation";
import "./LoanMarketplace.css";
import { loadStandingConfig } from "../../facilities/standing-model";

type Funding = "all" | "funded" | "unfunded";
export function LoanMarketplace({ board, offers, markets, account, assetFilter, onAssetChange, onReview, onCreate, onRequest,
  loading, failed, hasMore, loadMoreDisabled, onLoadMore }: {
  board: RequestBoard; offers: Offer[]; markets: Deployment[]; account: Address | null;
  assetFilter: string; onAssetChange: (asset: string) => void; onReview: (offer: Offer) => void;
  onCreate: () => void; onRequest: () => void; loading: boolean; failed: boolean; hasMore: boolean;
  loadMoreDisabled: boolean; onLoadMore: () => void;
}) {
  const [standing, setStanding] = useState(false);
  useEffect(() => { let live = true; void loadStandingConfig().then(config => { if (live) setStanding(!!config); }).catch(() => {}); return () => { live = false; }; }, []);
  const [memecoinsOnly, setMemecoinsOnly] = useState(() => typeof window !== "undefined"
    && !new URLSearchParams(window.location.search).has("market")
    && new URLSearchParams(window.location.search).get("category") === "memecoins");
  const memeMarkets = memecoinMarkets(markets);
  const memeAddresses = new Set(memeMarkets.map(market => market.address.toLowerCase()));
  const memeSymbols = [...new Set(memeMarkets.map(market => market.collateralSymbol))].sort();
  const otherSymbols = [...new Set(markets.filter(market => !memeAddresses.has(market.address.toLowerCase())).map(market => market.collateralSymbol))].sort();
  const selectCollateral = (value: string) => {
    setMemecoinsOnly(value === "category:memecoins");
    onAssetChange(value === "category:memecoins" ? "" : value);
  };
  const [funding, setFunding] = useState<Funding>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [minimum, setMinimum] = useState("");
  const [maximumDays, setMaximumDays] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [funding, search, sort, assetFilter, memecoinsOnly, minimum, maximumDays]);
  const query = search.trim().toLowerCase();
  const listings = [
    ...offers.map(offer => {
      const { market, loan } = offer;
      // V3 can report a shared-funding shortfall; an open status alone does not prove backing.
      const backed = market.version !== 3 || (loan.fundingAvailable !== undefined && loan.fundingAvailable >= loan.principal);
      return { key: `offer:${offerKey(offer)}`, market, address: loan.lender, principal: loan.principal, interest: loan.interest,
        duration: loan.durationDays, created: loan.createdAt, expiry: loan.expiresAt, funded: backed,
        content: <article className="p2p-request-card" data-offer-key={offerKey(offer)} aria-label={`${market.collateralSymbol} offer ${loan.id}`}>
          <header className="p2p-request-heading"><h3><CollateralLogo market={market} />{market.collateralSymbol} lending offer</h3>
            <p>Lender {shortAddress(loan.lender)}{account && sameAddress(account, loan.lender) ? " · you" : ""} · #{loan.id.toString()}</p>
            <p className={`p2p-help p2p-funding-tag${backed ? " p2p-funded" : ""}`}>{backed ? "Funded · USDG supplied" : loan.fundingAvailable === undefined ? "Funding unverified" : "Unfunded · funding shortfall"}</p>
          </header>
          <TermsSummary market={market} terms={{ principal: loan.principal.toString(), collateral: loan.collateral.toString(), interest: loan.interest.toString(), durationDays: loan.durationDays, expiresAt: loan.expiresAt }} />
          <div className="p2p-listing-action"><p>{backed ? "The lender has supplied USDG. The borrower pledges collateral to accept." : "Funding must be checked before this offer can be accepted."}</p>
            <button className="p2p-button p2p-secondary" data-offer-review onClick={() => onReview(offer)}>{account && sameAddress(account, loan.lender) ? "View your offer" : "Review loan"}</button></div>
        </article> };
    }),
    ...board.listings.map(({ request, market, content }) => ({ key: `request:${request.id}`, market, address: request.borrower,
      principal: BigInt(request.terms.principal), interest: BigInt(request.terms.interest), duration: request.terms.durationDays,
      created: request.createdAt, expiry: request.terms.expiresAt, funded: false, content })),
  ];
  let filterError = "", minimumValue = 0n;
  try { if (minimum.trim()) minimumValue = parseAmount(minimum, 6); }
  catch { filterError = "Enter a valid minimum USDG amount."; }
  if (maximumDays && (!/^[1-9][0-9]*$/.test(maximumDays) || !Number.isSafeInteger(Number(maximumDays)))) filterError = "Enter a positive whole number for maximum days.";
  const filtered = listings.filter(row => (!memecoinsOnly || memeAddresses.has(row.market.address.toLowerCase()))
    && (!assetFilter || row.market.collateralSymbol === assetFilter)
    && (!query || `${row.market.collateralSymbol} ${row.market.collateralName ?? ""} ${row.address}`.toLowerCase().includes(query))
    && row.principal * 1_000_000n >= minimumValue * 10n ** BigInt(row.market.loanDecimals)
    && (!maximumDays || row.duration <= Number(maximumDays))
    && (funding === "all" || row.funded === (funding === "funded")));
  const compare = (a: bigint | number, b: bigint | number) => a < b ? -1 : a > b ? 1 : 0;
  filtered.sort((a, b) => {
    const result = (sort === "amount" || sort === "amount-desc") ? compare(a.principal * 10n ** BigInt(b.market.loanDecimals), b.principal * 10n ** BigInt(a.market.loanDecimals)) * (sort === "amount-desc" ? -1 : 1)
      : (sort === "duration" || sort === "duration-desc") ? compare(a.duration, b.duration) * (sort === "duration-desc" ? -1 : 1)
      : (sort === "rate" || sort === "rate-desc") ? compare(a.interest * b.principal, b.interest * a.principal) * (sort === "rate-desc" ? -1 : 1)
      : sort === "expiry" ? compare(a.expiry, b.expiry) : compare(b.created, a.created);
    return result || a.key.localeCompare(b.key);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * 12, (currentPage + 1) * 12);
  const pending = loading || board.loading;
  const incomplete = failed || board.failed;
  const more = hasMore || board.hasMore;
  const reset = () => { setMemecoinsOnly(false); setFunding("all"); setSearch(""); setMinimum(""); setMaximumDays(""); onAssetChange(""); setPage(0); };
  return <section className="p2p-marketplace p2p-borrower-requests" aria-labelledby="p2p-marketplace-title">
    <div className="p2p-browser-heading"><div className="p2p-section-heading"><h2 id="p2p-marketplace-title">{memecoinsOnly ? "Memecoin loans" : "Loan marketplace"}</h2>
      <p>People with USDG lend to people with tokens. Choose which side you’re on.</p></div></div>
    <div className="p2p-marketplace-actions" aria-label="Borrow or lend USDG">
      <div className="p2p-marketplace-action"><button className="p2p-button" aria-haspopup="dialog" aria-describedby="p2p-borrow-action-help" onClick={onRequest}>Borrow USDG</button>
        <p id="p2p-borrow-action-help">Use your tokens as collateral and ask for a loan. Posting a request moves no funds; a lender must fund it first.</p></div>
      <div className="p2p-marketplace-action"><button className="p2p-button p2p-secondary" aria-haspopup="dialog" aria-describedby="p2p-lend-action-help" onClick={onCreate}>Lend USDG</button>
        <p id="p2p-lend-action-help">Supply your USDG and choose the interest. Funding an offer reserves your money until someone borrows or you cancel.</p></div>
    </div>
    {standing && <div className="p2p-standing-entry"><div><strong>Standing offers</strong><p>Borrow from published terms, or fund one balance for multiple loans.</p></div><a className="p2p-button p2p-secondary" href="/borrow/p2p?standing=1">Find a loan</a><a className="p2p-reset" href="/borrow/p2p?standing=1&intent=lend">Create a lending balance</a></div>}
    {memeSymbols.length > 0 && <p className="p2p-help">Memecoins · {memeSymbols.length <= 3 ? memeSymbols.join(" · ") : `${memeSymbols.length} supported tokens`}{!memecoinsOnly && <> · <button className="p2p-reset" onClick={() => selectCollateral("category:memecoins")}>Browse memecoin loans</button></>}</p>}
    <div className="p2p-marketplace-filters">
      <label>Search loans<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Asset or wallet address" /></label>
      <label>Collateral<select value={memecoinsOnly ? "category:memecoins" : assetFilter} onChange={event => selectCollateral(event.target.value)}>
        <option value="">All collateral</option>
        {memeSymbols.length > 0 && <optgroup label="Memecoins"><option value="category:memecoins">All memecoins</option>{memeSymbols.map(symbol => <option key={symbol}>{symbol}</option>)}</optgroup>}
        {otherSymbols.length > 0 && <optgroup label="Stocks & other tokens">{otherSymbols.map(symbol => <option key={symbol}>{symbol}</option>)}</optgroup>}
      </select></label>
      <label>Funding<select value={funding} onChange={event => setFunding(event.target.value as Funding)}><option value="all">All listings</option><option value="funded">Funded</option><option value="unfunded">Unfunded</option></select></label>
      <label>Sort by<select value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="amount-desc">Largest loan</option><option value="amount">Smallest loan</option><option value="rate">Lowest interest %</option><option value="rate-desc">Highest interest %</option><option value="duration">Shortest duration</option><option value="duration-desc">Longest duration</option><option value="expiry">Expiring soonest</option></select></label>
    </div>
    <details className="p2p-more-filters"><summary>Amount and duration filters</summary><div className="p2p-marketplace-filters">
      <label>Minimum loan · USDG<input inputMode="decimal" value={minimum} onChange={event => setMinimum(event.target.value)} placeholder="Any amount" /></label>
      <label>Maximum days<input inputMode="numeric" value={maximumDays} onChange={event => setMaximumDays(event.target.value)} placeholder="Any duration" /></label>
    </div></details>
    {(memecoinsOnly || search || assetFilter || minimum || maximumDays || funding !== "all") && <button className="p2p-reset" onClick={reset}>Clear filters</button>}
    {filterError && <p role="alert">{filterError}</p>}
    <p className="p2p-help">Funded offers have USDG supplied by a lender. Unfunded requests are looking for one. Posting a request does not start a loan.</p>
    {incomplete && <p role="alert">Some listings couldn’t be loaded. These results may be incomplete. Use the retry controls for the affected markets or requests.</p>}
    <p className="p2p-help" role="status">{filtered.length} {filtered.length === 1 ? "listing" : "listings"}{pending ? " · Loading more listings…" : more ? " · More listings available" : ""}</p>
    {!visible.length && loading && <OfferListSkeleton />}
    {!filterError && visible.map(row => <Fragment key={row.key}>{row.content}</Fragment>)}
    {!filterError && !visible.length && !pending && !incomplete && <EmptyState title={funding === "funded" ? "No funded offers yet" : funding === "unfunded" ? "No unfunded listings found" : memecoinsOnly || search || assetFilter || minimum || maximumDays ? "No loans match these filters" : "Be the first to post a loan"}
      description={funding === "funded" ? "Borrowers may already be looking for lenders. View all listings to see their requests, or request your own terms." : "Create a lending offer or request the amount and terms you need."}
      actions={(memecoinsOnly || search || assetFilter || minimum || maximumDays || funding !== "all") ? <button className="p2p-button p2p-secondary" onClick={reset}>View all listings</button> : undefined} />}
    {pages > 1 && <nav className="p2p-pagination" aria-label="Marketplace pages"><button className="p2p-button p2p-secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button className="p2p-button p2p-secondary" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
    {board.controls}
    {hasMore && <button className="p2p-button p2p-secondary" disabled={loadMoreDisabled} onClick={onLoadMore}>Load older funded offers</button>}
    {more && <p className="p2p-help">Filters and sorting apply to loaded listings. Load older listings to include them.</p>}
    <p className="p2p-help">No price-triggered liquidation. After the final repayment deadline, the lender can claim your collateral. Early repayment still includes the full interest.</p>
  </section>;
}
