import { LoanActionDialog } from "./LoanActionDialog";
import { CollateralLogo } from "./CollateralLogo";
import { FieldLabel, TermLabel } from "../../comps/FieldInfo/FieldInfo";
import { LoanInterestField, LoanRepaymentSummary, useLoanInterest } from "../../comps/LoanInterestField/LoanInterestField";
import { EmptyState } from "../../comps/EmptyState/EmptyState";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CollateralMarketPrice, hasWeekendPrices } from "./CollateralMarketPrice";
import { parseUnits, type Address, type EIP1193Provider } from "viem";
import type { Deployment } from "../../p2p/client";
import { bindRequestOffer, loadBorrowerRequests, publishedProposalFunding, requestFundingDraft, signRequestAction,
  type BorrowerRequest, type RequestAction, type RequestFundingDraft, type RequestProposal, type RequestTerms } from "../../p2p/requests";
import { collateralAmount, displayDate, fixedInterestPercent, formatAmount, loanAmount, localDateInput, sameAddress, shortAddress } from "./loanPresentation";
import "./BorrowerRequests.css";

export type RequestBoard = { listings: { request: BorrowerRequest; market: Deployment; content: ReactNode }[]; loading: boolean; failed: boolean; hasMore: boolean; controls: ReactNode };

type Props = { markets: Deployment[]; account: Address | null; provider: EIP1193Provider | null; disabled?: boolean; refreshKey?: number; initialMarket?: string;
  renderBoard?: (board: RequestBoard) => ReactNode; onRequest: (market?: string) => void; onFund: (draft: RequestFundingDraft, immediately?: boolean) => void; intent?: "borrow" | "lend"; onConnect?: () => void; onCreate?: () => void };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed. Refresh before trying again.";
const defaultExpiry = () => localDateInput(Math.floor(Date.now() / 1000) + 7 * 86400);

export function TermsSummary({ terms, market }: { terms: RequestTerms; market: Deployment }) {
  return <dl className="p2p-request-terms">
    <div><dt><TermLabel topic="principal" helpLabel="Loan amount">Loan amount</TermLabel></dt><dd>{loanAmount(BigInt(terms.principal), market)}</dd></div>
    <div><dt><TermLabel topic="collateral" helpLabel="Collateral at risk">Collateral at risk</TermLabel></dt><dd>{collateralAmount(BigInt(terms.collateral), market)}</dd></div>
    <div><dt><TermLabel topic="interest" helpLabel="Total interest">Total interest</TermLabel></dt><dd>{loanAmount(BigInt(terms.interest), market)}<small>{fixedInterestPercent({ principal: BigInt(terms.principal), interest: BigInt(terms.interest) })} for the full term</small></dd></div>
    <div><dt><TermLabel topic="repayment" helpLabel="Total repayment">Total repayment</TermLabel></dt><dd>{loanAmount(BigInt(terms.principal) + BigInt(terms.interest), market)}</dd></div>
    <div><dt><TermLabel topic="duration" helpLabel="Term after acceptance">Term after acceptance</TermLabel></dt><dd>{terms.durationDays} days + 24-hour grace</dd></div>
    <div><dt><TermLabel topic="expiry" helpLabel="Listing / offer expiry">Listing / offer expiry</TermLabel></dt><dd>{displayDate(terms.expiresAt)}</dd></div>
  </dl>;
}

export function RequestTermsForm({ market, initial, disabled, label, onSubmit, onFundNow }: { market: Deployment; initial?: RequestTerms;
  disabled: boolean; label: "request" | "proposal"; onSubmit: (terms: RequestTerms) => Promise<void>; onFundNow?: (terms: RequestTerms) => Promise<void> }) {
  const id = useId();
  const decimals = (value: string, precision: number) => formatAmount(BigInt(value), precision);
  const [principal, setPrincipal] = useState(initial ? decimals(initial.principal, market.loanDecimals) : "");
  const [collateral, setCollateral] = useState(initial ? decimals(initial.collateral, market.collateralDecimals) : "");
  const interestModel = useLoanInterest(principal, market.loanDecimals, initial ? decimals(initial.interest, market.loanDecimals) : "0");
  const { interest } = interestModel;
  const [duration, setDuration] = useState(String(initial?.durationDays ?? 30));
  const [expires, setExpires] = useState(initial ? localDateInput(initial.expiresAt) : defaultExpiry);
  const [review, setReview] = useState<RequestTerms | null>(null);
  const [fundNow, setFundNow] = useState(false);
  const [fundingConsent, setFundingConsent] = useState(false);
  const invalidateReview = () => { setReview(null); setFundingConsent(false); };
  const [pricingOpen, setPricingOpen] = useState(false);
  const [error, setError] = useState("");
  const amount = (value: string, precision: number, allowZero = false) => {
    if (!new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${Math.max(precision, 1)}})?$`).test(value) || (precision === 0 && value.includes("."))) throw new Error("Use exact decimal amounts within the token's precision.");
    const raw = parseUnits(value, precision);
    if ((!allowZero && raw === 0n) || raw >= 1n << 256n) throw new Error("Enter positive amounts within the supported range.");
    return raw.toString();
  };
  return <form className="p2p-request-form" onSubmit={event => {
    event.preventDefault(); setError("");
    try {
      const terms = { principal: amount(principal, market.loanDecimals), collateral: amount(collateral, market.collateralDecimals),
        interest: amount(interest, market.loanDecimals, true), durationDays: Number(duration), expiresAt: Math.floor(new Date(expires).getTime() / 1000) };
      const now = Math.floor(Date.now() / 1000);
      if (!/^[1-9][0-9]*$/.test(duration) || !Number.isSafeInteger(terms.durationDays)
        || !Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= now || terms.expiresAt > (initial?.expiresAt ?? now + 30 * 86400)
        || BigInt(terms.principal) + BigInt(terms.interest) >= 1n << 256n
        || BigInt(terms.expiresAt) + BigInt(terms.durationDays) * 86400n + 86400n > 8_640_000_000_000n) throw new Error(initial
          ? "Choose whole days and an expiry no later than this request's expiry." : "Choose whole days and a future expiry within 30 days.");
      setReview(terms);
    } catch (cause) { invalidateReview(); setError(errorMessage(cause)); }
  }}>
    <div className="p2p-request-amounts">
    <div className="p2p-form-grid">
      {([
        ["principal", label === "proposal" ? "USDG to lend" : "USDG to borrow", principal, setPrincipal],
        ["collateral", `${market.collateralSymbol} collateral`, collateral, setCollateral],
      ] as const).map(([field, text, value, set]) => <div className="turret-labeled-field" key={field}><FieldLabel htmlFor={`${id}-${field}`} topic={field} helpLabel={text}>{text}</FieldLabel><input id={`${id}-${field}`} value={value} inputMode="decimal" disabled={disabled} required onChange={event => { set(event.target.value); invalidateReview(); }} /></div>)}
    </div>
    {hasWeekendPrices(market) && <details className="p2p-request-pricing" onToggle={event => setPricingOpen(event.currentTarget.open)}>
      <summary>Check collateral value</summary>
      {pricingOpen && <CollateralMarketPrice market={market} amount={collateral} />}
    </details>}
    </div>
    <LoanInterestField model={interestModel} duration={duration} decimals={market.loanDecimals} disabled={disabled} onChange={invalidateReview} showSummary={false} />
    <div className="p2p-form-grid p2p-request-timing">
      <div className="turret-labeled-field"><FieldLabel htmlFor={`${id}-duration`} topic="duration" helpLabel="Duration · whole days">Duration · whole days</FieldLabel><input id={`${id}-duration`} value={duration} inputMode="numeric" disabled={disabled} required onChange={event => { setDuration(event.target.value); invalidateReview(); }} /></div>
      <div className="turret-labeled-field"><FieldLabel htmlFor={`${id}-expiry`} topic="expiry" helpLabel="Expiry · your local time">Expiry · your local time</FieldLabel><input id={`${id}-expiry`} type="datetime-local" value={expires} disabled={disabled} required onChange={event => { setExpires(event.target.value); invalidateReview(); }} /></div>
    </div>
    {label === "proposal" && onFundNow && <label className="p2p-check p2p-fund-now-choice">
      <input type="checkbox" checked={fundNow} disabled={disabled} onChange={event => { setFundNow(event.target.checked); invalidateReview(); }} />
      <span><strong>Fund this proposal now</strong><small>{fundNow ? "After signing your terms, continue straight to the USDG approval and deposit." : "Leave this off to propose terms while keeping USDG in your wallet."}</small></span>
    </label>}
    {!review && <LoanRepaymentSummary model={interestModel} decimals={market.loanDecimals} />}
    {error && <p role="alert">{error}</p>}
    {review ? <div className="p2p-request-review"><TermsSummary terms={review} market={market} />
      {fundNow && onFundNow ? <>
        <p className="p2p-help">You will deposit {loanAmount(BigInt(review.principal), market)} into the lending contract for this borrower. They receive it only after accepting and pledging the collateral. The loan starts then.</p>
        <p className="p2p-help">Wallet steps: sign your proposal, approve USDG if needed, confirm the deposit, then sign to link the funded offer. You can cancel the offer before acceptance. Open offers earn no interest.</p>
        <label className="p2p-check"><input type="checkbox" checked={fundingConsent} disabled={disabled} onChange={event => setFundingConsent(event.target.checked)} /><span>I accept that my funds stay locked during an active loan. If the borrower misses the final deadline, I receive the available collateral, which may be worth less than my loan. Repayment is not guaranteed.</span></label>
        <button type="button" className="p2p-button" disabled={disabled || !fundingConsent} onClick={() => { if (fundingConsent) void onFundNow(review); }}>Propose and fund now</button>
      </> : <><p className="p2p-help">These terms and your wallet address will be public. Your signature publishes an unfunded {label}. No collateral moves and no debt is created. An accepted loan requires separate funding and borrower transactions.</p>
      <button type="button" className="p2p-button" disabled={disabled} onClick={() => { void onSubmit(review); }}>Sign and publish {label}</button></>}
    </div> : <button className="p2p-button" type="submit" disabled={disabled}>Review {label}</button>}
  </form>;
}

function Proposal({ request, proposal, market, account, disabled, execute, onFund, onBind }: {
  request: BorrowerRequest; proposal: RequestProposal; market: Deployment; account: Address | null; disabled: boolean;
  execute: (market: Deployment, action: RequestAction, success: string) => Promise<void>;
  onFund: Props["onFund"]; onBind: (request: BorrowerRequest, proposal: RequestProposal, market: Deployment, id: string) => Promise<void>;
}) {
  const [agree, setAgree] = useState(false);
  const [offerId, setOfferId] = useState("");
  const [fundingError, setFundingError] = useState("");
  const borrower = !!account && sameAddress(account, request.borrower);
  const lender = !!account && sameAddress(account, proposal.lender);
  const available = !proposal.cancelled && request.status !== "cancelled" && proposal.terms.expiresAt > Math.floor(Date.now() / 1000);
  const agreed = request.acceptedProposalId === proposal.id;
  return <article className="p2p-request-proposal" aria-label={`Proposal from ${shortAddress(proposal.lender)}`}>
    <h4>Proposed by {shortAddress(proposal.lender)} {lender ? "· you" : ""}</h4>
    <p className="p2p-help">{proposal.cancelled ? "Proposal cancelled" : !available ? "Proposal expired or request closed" : agreed ? "Borrower agreed to these terms · funding and loan acceptance are separate" : "Awaiting borrower agreement"}</p>
    <TermsSummary terms={proposal.terms} market={market} />
    {proposal.fundedOffer && <p><a className="p2p-text-button" href={`/borrow/p2p?market=${encodeURIComponent(market.address)}&offer=${proposal.fundedOffer.id}`}>Review verified on-chain offer #{proposal.fundedOffer.id}</a><span className="p2p-help p2p-request-block">Last verified {proposal.fundedOffer.status} at block {proposal.fundedOffer.blockNumber}. Open the loan to check its current state and accept or manage it.</span></p>}
    {borrower && available && !agreed && <><label className="p2p-check"><input type="checkbox" checked={agree} disabled={disabled} onChange={event => setAgree(event.target.checked)} /><span>I agree to discuss these exact terms. This signature does not borrow money or reserve a loan.</span></label>
      <button className="p2p-button p2p-secondary" disabled={disabled || !agree} onClick={() => { void execute(market, { action: "accept", requestId: request.id, revision: request.revision, proposalId: proposal.id }, "Terms agreed. The lender must fund an offer, and you must separately accept it on-chain to borrow."); }}>Agree to proposal</button></>}
    {fundingError && <p role="alert">{fundingError}</p>}
    {lender && available && !proposal.fundedOffer && <div className="p2p-request-actions"><button className="p2p-button" disabled={disabled} onClick={() => {
      try { setFundingError(""); onFund(requestFundingDraft(request, proposal, market)); } catch (cause) { setFundingError(errorMessage(cause)); }
    }}>Fund this proposal</button>
      <button className="p2p-button p2p-secondary" disabled={disabled} onClick={() => { void execute(market, { action: "cancelProposal", requestId: request.id, revision: request.revision, proposalId: proposal.id }, "Proposal cancelled. Existing on-chain offers are unchanged."); }}>Cancel proposal</button></div>}
    {(lender || borrower) && <section className="p2p-request-link"><h3>{proposal.fundedOffer ? "Refresh verified offer state" : "Already funded? Link the offer"}</h3>
      <p className="p2p-help">Link only an offer from this market with the exact parties and terms above. The server checks the registered contract and current chain state.</p>
      {!proposal.fundedOffer && <label>Funded offer ID<input inputMode="numeric" value={offerId} onChange={event => setOfferId(event.target.value)} disabled={disabled} placeholder="Offer number" /></label>}
      <button className="p2p-button p2p-secondary" disabled={disabled || (!proposal.fundedOffer && !/^[1-9][0-9]*$/.test(offerId))} onClick={() => { void onBind(request, proposal, market, proposal.fundedOffer?.id ?? offerId); }}>{proposal.fundedOffer ? "Verify current offer state" : "Verify and link funded offer"}</button>
    </section>}
  </article>;
}

export function BorrowerRequests({ markets, account, provider, disabled = false, initialMarket = "", onFund, intent = "borrow", onConnect, onCreate, onRequest, renderBoard, refreshKey = 0 }: Props) {
  const currentMarkets = markets.filter(market => !market.legacy && (market.version ?? 1) >= 2);
  const [composing, setComposing] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState(initialMarket);
  const [mine, setMine] = useState(intent === "borrow");
  const [rows, setRows] = useState<BorrowerRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const guard = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identity = `${account ?? ""}:${marketFilter}:${mine}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const busy = disabled || working;
  useEffect(() => { setComposing(null); }, [identity]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setRows([]); setCursor(null);
    if (mine && !account) { setLoading(false); return () => controller.abort(); }
    void loadBorrowerRequests({ market: marketFilter || undefined, account: mine ? account ?? undefined : undefined }, controller.signal).then(page => {
      if (!controller.signal.aborted) { setRows(page.requests); setCursor(page.nextCursor); }
    }).catch(cause => { if (!controller.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [account, marketFilter, mine, revision, refreshKey]);
  const execute = async (market: Deployment, action: RequestAction, success: string, onSaved?: (row: BorrowerRequest) => void) => {
    if (!account || !provider || busy || guard.current) return;
    const started = identityRef.current; guard.current = true; setWorking(true); setError(""); setNotice("");
    try {
      const row = await signRequestAction(provider, account, market, action);
      if (mounted.current && identityRef.current === started) { setRows(previous => [row, ...previous.filter(item => item.id !== row.id)].sort((a, b) => b.sequence - a.sequence)); setNotice(success); onSaved?.(row); }
    } catch (cause) { if (identityRef.current === started) setError(errorMessage(cause)); }
    finally { guard.current = false; setWorking(false); }
  };
  const bind = async (request: BorrowerRequest, proposal: RequestProposal, market: Deployment, id: string) => {
    if (!account || !provider || busy || guard.current) return;
    const started = identityRef.current; guard.current = true; setWorking(true); setError("");
    try {
      const row = await bindRequestOffer(provider, account, { requestId: request.id, proposalId: proposal.id, market }, id);
      if (identityRef.current === started) { setRows(previous => previous.map(item => item.id === row.id ? row : item)); setNotice("The matching on-chain offer was verified. Open its link to check current state and accept or manage it."); }
    } catch (cause) { if (identityRef.current === started) setError(errorMessage(cause)); }
    finally { guard.current = false; setWorking(false); }
  };
  const renderRequest = (request: BorrowerRequest) => {
      const market = markets.find(item => sameAddress(item.address, request.market) && item.chainId === request.chainId);
      if (!market) return <article className="p2p-request-card" key={request.id}><p>This request references a market unavailable in the current registry.</p></article>;
      const owner = !!account && sameAddress(account, request.borrower);
      const open = request.status !== "cancelled" && request.terms.expiresAt > Math.floor(Date.now() / 1000);
      return <article className="p2p-request-card" key={request.id} aria-label={`Borrowing request from ${shortAddress(request.borrower)}`}>
        <header className="p2p-request-heading"><h3><CollateralLogo market={market} />{market.collateralSymbol} borrowing request</h3><p>Borrower {shortAddress(request.borrower)} {owner ? "· you" : ""}</p>
        <p className="p2p-help p2p-funding-tag">{request.status === "cancelled" ? "Request cancelled" : !open ? "Request expired" : request.status === "agreed" ? "Unfunded · terms agreed" : "Unfunded · seeking a lender"}</p></header>
        <TermsSummary terms={request.terms} market={market} />
        {owner && request.status !== "cancelled" && <button className="p2p-button p2p-secondary" disabled={busy} onClick={() => { void execute(market, { action: "cancel", requestId: request.id, revision: request.revision }, "Request cancelled. Existing on-chain offers and loans are unchanged."); }}>Cancel request</button>}
        {account && !owner && open && !market.legacy && <div className="p2p-request-compose">
          <button type="button" className="p2p-button" aria-haspopup="dialog" disabled={busy} onClick={() => { setError(""); setComposing(request.id); }}>Offer to lend</button>
          <p className="p2p-help">Review the terms and choose whether to fund your proposal now.</p>
          {composing === request.id && <LoanActionDialog title={`Offer to lend · ${market.collateralSymbol}`} closeLabel="Close lending proposal" busy={busy} onClose={() => { if (!guard.current) setComposing(null); }}>
            <p>Propose a loan to {shortAddress(request.borrower)} against their {market.collateralSymbol}. Review and confirm before signing in your wallet.</p>
            {error && <p role="alert">{error}</p>}
            {working && <p role="status">Confirm the proposal in your wallet, then wait for it to save.</p>}
            <RequestTermsForm key={`${request.id}:${account}`} market={market} initial={request.terms} disabled={busy} label="proposal" onFundNow={terms => execute(market, { action: "propose", requestId: request.id, revision: request.revision, terms }, "Proposal published. Continue with funding in your wallet.", saved => { setComposing(null); onFund(publishedProposalFunding(request, saved, market, account, terms), true); })} onSubmit={terms => execute(market, { action: "propose", requestId: request.id, revision: request.revision, terms }, "Proposal published. Funds stay in your wallet until you fund an offer.", () => setComposing(null))} />
          </LoanActionDialog>}
        </div>}
        {!account && open && <button className="p2p-button p2p-secondary" disabled={busy} onClick={onConnect}>Connect wallet to offer terms</button>}
        {request.proposals.length > 0 && <section className="p2p-request-proposals"><h3>{request.proposals.length} lender {request.proposals.length === 1 ? "proposal" : "proposals"}</h3>{request.proposals.map(proposal => <Proposal key={`${proposal.id}:${request.revision}`} request={request} proposal={proposal} market={market} account={account} disabled={busy || !!market.legacy} execute={execute} onFund={onFund} onBind={bind} />)}</section>}
      </article>;
  };
  const loadMore = cursor && <button className="p2p-button p2p-secondary" disabled={loading || working} onClick={() => {
      const started = identityRef.current; setLoading(true); setError("");
      void loadBorrowerRequests({ market: marketFilter || undefined, account: mine ? account ?? undefined : undefined, cursor }).then(page => {
        if (identityRef.current === started) { setRows(previous => [...new Map([...previous, ...page.requests].map(row => [row.id, row])).values()]); setCursor(page.nextCursor); }
      }).catch(cause => { if (identityRef.current === started) setError(errorMessage(cause)); }).finally(() => { if (identityRef.current === started) setLoading(false); });
    }}>Load older requests</button>;
  if (renderBoard) return renderBoard({
    listings: rows.flatMap(request => {
      const market = markets.find(item => sameAddress(item.address, request.market) && item.chainId === request.chainId);
      if (!market || request.status === "cancelled" || request.terms.expiresAt <= Date.now() / 1000
        || request.proposals.some(proposal => proposal.fundedOffer && ["open", "active", "repaid", "defaulted"].includes(proposal.fundedOffer.status))) return [];
      return [{ request, market, content: renderRequest(request) }];
    }),
    loading, failed: !!error, hasMore: !!cursor,
    controls: <>{error && <p role="alert">Couldn’t load or update borrowing requests. {error}</p>}
      {notice && <p role="status">{notice}</p>}
      {working && <p role="status">Confirm the listing signature in your wallet, then wait for it to save.</p>}
      {error && <button className="p2p-button p2p-secondary" disabled={loading || working} onClick={() => setRevision(value => value + 1)}>Retry requests</button>}
      {loadMore}</>,
  });
  return <section className="p2p-borrower-requests" aria-label="Borrower requests">
    <div className="p2p-browser-heading"><div className="p2p-section-heading"><h2>{intent === "borrow" ? "Your borrowing requests" : "Find a borrower to lend to"}</h2>
    <p>{intent === "borrow" ? "Review your requests and the terms lenders have proposed, or publish a new request." : "Browse borrowing requests and propose the amount and repayment you are willing to fund."}</p></div>
    {intent === "borrow" && <button className="p2p-button" aria-haspopup="dialog" onClick={() => onRequest(marketFilter)}>Request a loan</button>}</div>
    <p className="p2p-help">Request → lender proposal → funded offer → borrower accepts. Publishing a request or agreeing to terms does not move funds or open a loan.</p>
    <div className="p2p-request-filters"><label>Collateral market<select value={marketFilter} onChange={event => setMarketFilter(event.target.value)}><option value="">All collateral</option>{currentMarkets.map(market => <option key={market.address} value={market.address}>{market.collateralSymbol}</option>)}</select></label>
      <label className="p2p-check"><input type="checkbox" checked={mine} disabled={!account} onChange={event => setMine(event.target.checked)} /><span>My requests and proposals</span></label>
      <button className="p2p-button p2p-secondary" disabled={loading || working} onClick={() => setRevision(value => value + 1)}>Refresh requests</button></div>
    {!account && <p className="p2p-help">Connect a wallet on this chain to publish, negotiate or fund. Anyone can browse.</p>}
    {error && <p role="alert" className="p2p-request-message">{error}</p>}
    {notice && <p role="status" className="p2p-request-message">{notice}</p>}
    {working && <p role="status">Confirm the listing signature in your wallet, then wait for the board to save it.</p>}
    {loading ? <p role="status">Loading borrower requests…</p> : !rows.length && !error && <EmptyState
      title={mine && !account ? "Your requests, in one place" : marketFilter ? "No requests for this asset" : mine ? "You haven’t requested a loan yet" : "No borrowers looking for a loan yet"}
      description={mine && !account ? "Connect your wallet to see the terms you’ve posted and the proposals you’ve received."
        : marketFilter ? "Try another collateral market or browse requests across all assets."
        : mine ? "Choose the USDG you need and the tokens you can pledge. Posting a request does not move your assets or start a loan."
        : "Borrowers’ requests will appear here. You can also create a lending offer for borrowers to consider."}
      actions={<>{marketFilter ? <button className="p2p-button" onClick={() => setMarketFilter("")}>Show all assets</button>
        : mine && !account ? <button className="p2p-button" disabled={busy} onClick={onConnect}>Connect wallet</button>
        : mine && currentMarkets.length > 0 && intent === "borrow" ? <button className="p2p-button" disabled={busy} aria-haspopup="dialog" onClick={() => onRequest(marketFilter)}>Request a loan</button>
        : onCreate ? <button className="p2p-button" disabled={busy} onClick={onCreate}>Create a lending offer</button> : <a className="p2p-button" href="/borrow/p2p">Browse lending offers</a>}
        {mine && <button className="p2p-button p2p-secondary" onClick={() => setMine(false)}>Browse public requests</button>}</>}
    />}
    {rows.map(renderRequest)}
    {loadMore}

  </section>;
}
