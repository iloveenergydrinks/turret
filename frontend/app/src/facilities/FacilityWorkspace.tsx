"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatUnits, type Address, type EIP1193Provider } from "viem";
import type { DrawReview, FacilityClient, QuoteReview } from "./client";
import { drawAmounts, same, ZERO_ADDRESS, type SignedQuote } from "./quotes.mjs";
import { parseSignedQuote } from "./quotes.mjs";
import { requirePendingStorage } from "../p2p/pending-transactions";
import { amount, failMessage, publishFacilityQuote, shortAddress, type Directory, type FacilityMarket } from "./ui-model";
import type { FacilityProgress, FacilityStage } from "./wallet-transactions";
import "./facilities.css";

const show = (value: bigint, decimals = 6) => formatUnits(value, decimals);
const date = (seconds: bigint) => new Date(Number(seconds) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
type Tab = "borrow" | "lend" | "loans";
type Run = (action: (progress: FacilityProgress) => Promise<unknown>, success?: string) => Promise<void>;
export type FacilityWorkspaceProps = {
  market: FacilityMarket; client: FacilityClient; account: Address | null; provider: EIP1193Provider | null; wrongChain: boolean;
  directory: Directory | null; loading: boolean; error: string | null; refresh: () => void; connect: () => void;
  initialTab?: Tab; preview?: boolean;
};
export function FacilityWorkspace(props: FacilityWorkspaceProps) {
  const { market, client, account, provider } = props;
  const [tab, setTab] = useState<Tab>(props.initialTab ?? "borrow");
  const [busy, setBusy] = useState(false), [stage, setStage] = useState<FacilityStage | null>(null), [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const [feedbackHost, setFeedbackHost] = useState<Element | null>(null);
  const identity = `${market.address}:${account ?? ""}:${props.wrongChain}`, latest = useRef(identity); latest.current = identity;
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (feedbackHost && !feedbackHost.isConnected) setFeedbackHost(null); });
  useEffect(() => { setStage(null); setError(null); setSuccess(null); setRevision(n => n + 1); }, [identity]);
  useEffect(() => { if (busy) return; const timer = setInterval(() => setRevision(n => n + 1), 15000); return () => clearInterval(timer); }, [busy]);
  const run: Run = async (action, confirmation) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setSuccess(null);
    setFeedbackHost(document.activeElement?.closest("[data-facility-feedback]") ?? null);
    const scope = latest.current;
    setStage({ status: "checking", message: "Checking your wallet and current loan state…" });
    try {
      await action(value => { if (mounted.current && latest.current === scope) setStage(value); });
      if (mounted.current && latest.current === scope) {
        setStage(value => value?.hash ? value : null);
        setSuccess(confirmation ?? null); setRevision(n => n + 1); props.refresh();
      }
    } catch (cause) { if (mounted.current && latest.current === scope) setError(failMessage(cause)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  const ready = !!account && !!provider && !props.wrongChain && !props.preview;
  const owner = !!account && same(account, market.lender);
  const feedback = <div className="facility-feedback" aria-live="polite">{stage && !error && !success && <p role="status">{stage.message}</p>}{success && <p role="status">{success}</p>}
    {stage?.hash && <p className="facility-small facility-address">Transaction: {stage.hash}</p>}
    {error && <div className="facility-error" role="alert"><p>{error}</p><p>If a transaction was submitted, check its status before trying again.</p></div>}
  </div>;
  return <section className="facility-workspace">
    <a className="facility-back" href="/borrow/p2p?standing=1">All standing offers</a>
    <header className="facility-heading"><div><h1>{tab === "lend" ? "Lend against" : tab === "loans" ? "Your loans against" : "Borrow against"} {market.collateralSymbol}</h1><p>{tab === "lend" ? "Fund loans and set the terms borrowers can accept." : tab === "loans" ? "Repay loans, recover collateral and manage withdrawals." : "Receive USDG. Repay the fixed total to reclaim your coins."}</p></div>
      <button className="facility-text" onClick={() => { setRevision(n => n + 1); props.refresh(); }} disabled={props.loading || busy}>Refresh</button></header>
    <div className="facility-context"><span>{owner ? "Your lender account" : `Lender ${shortAddress(market.lender)}`}</span>{tab === "borrow" && !owner && <span>{props.error ? "Funded availability is unavailable" : props.loading ? "Checking available USDG" : props.directory ? `${show(props.directory.capacity)} USDG available across these terms` : "Available USDG has not been checked"}</span>}</div>
    <nav className="facility-tabs" aria-label="Lending balance views">{([['borrow', 'Borrow'], ['lend', 'Lend'], ['loans', 'My loans']] as const).map(([id, label]) =>
      <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setError(null); setSuccess(null); setStage(null); }} disabled={busy}>{label}</button>)}</nav>
    <div className="facility-task" key={`${identity}:${tab}`}>
      {!ready && <p className="facility-wallet-note">{props.preview ? "Illustrative preview · wallet transactions are disabled." : props.wrongChain ? `Switch your wallet to ${market.chainId === 4663 ? "Robinhood Chain" : "the local test chain"} to continue.` : account ? "Waiting for your wallet connection…" : <>Connect your wallet to review a loan or manage your lending balance. <button className="facility-text" onClick={props.connect}>Connect wallet</button></>}</p>}
      {tab === "borrow" ? <BorrowTerms key={identity} {...props} ready={ready} busy={busy} run={run} /> : tab === "lend" ? <LenderBalance key={identity} {...props} ready={ready} busy={busy} run={run} revision={revision} /> : <FacilityLoans key={identity} {...props} ready={ready} busy={busy} run={run} revision={revision} />}
      {feedbackHost?.isConnected ? createPortal(feedback, feedbackHost) : feedback}
      {account && <button className="facility-text" disabled={busy || !ready} onClick={() => void run(async progress => {
        const found = await client.transactions.reconcile(account, progress); if (!found) throw new Error("No pending transaction is saved for this wallet and lending balance.");
      }, "Previous transaction confirmed. Review updated balances before continuing.")}>Check pending transaction</button>}
    </div>
    <details className="facility-contracts"><summary>Contracts and loan rules</summary><p>Price changes alone do not liquidate these loans. Repay by the deadline, including 24 hours of grace, or the lender can claim all pledged coins. Their value may differ from the amount borrowed.</p>
      <p>Repayment and collateral withdrawal are separate transactions. Token restrictions or losses may affect recovery. The contracts have not received an independent external audit.</p>
      <dl><div><dt>Lender</dt><dd>{market.lender}</dd></div><div><dt>Lending balance</dt><dd>{market.address}</dd></div><div><dt>{market.collateralSymbol}</dt><dd>{market.collateralToken}</dd></div><div><dt>USDG</dt><dd>{market.loanToken}</dd></div></dl>
    </details>
  </section>;
}
type ChildProps = FacilityWorkspaceProps & { ready: boolean; busy: boolean; run: Run; revision?: number };
function Figure({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function BorrowTerms({ market, client, account, provider, directory, loading, error, ready, busy, run, preview }: ChildProps) {
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("quote")), [input, setInput] = useState("");
  const [storedReview, setReview] = useState<DrawReview | null>(null), [consent, setConsent] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const stale = !!directory && now - directory.checkedAt >= 30000;
  const row = selected ? directory?.quotes.find(q => q.id === selected) : directory?.quotes[0];
  const review = storedReview && storedReview.digest === row?.id && now - storedReview.checkedAt < 30000 ? storedReview : null;
  useEffect(() => { if (storedReview && !review) { setReview(null); setConsent(false); } }, [storedReview, review]);
  const choose = (id: string) => { setSelected(id); setInput(""); setReview(null); setConsent(false); };
  const canReview = (ready || !!preview) && !busy && !loading && !error && !stale && !!row && !!input;
  if (loading && !directory) return <div className="facility-loading" role="status">Checking signed terms and available USDG…</div>;
  if (error || stale) return <div className="facility-empty" role="status"><h2>Availability needs a fresh check</h2><p>{error ?? "These terms have not been checked recently. Refresh to see what can be borrowed."}</p><p>Your existing loans remain under My loans.</p></div>;
  if (!row && selected && directory?.quotes.length) return <div className="facility-empty"><h2>This offer is no longer available</h2><p>The selected offer may have expired, filled or been cancelled. Review another offer from this lender.</p><button className="facility-secondary" onClick={() => choose(directory.quotes[0]!.id)}>Choose other terms</button></div>;
  if (!row) return <div className="facility-empty"><h2>No funded terms available</h2><p>This lender needs to fund a balance and publish terms before you can borrow. You can also request an individual P2P loan.</p><a href="/borrow/p2p?intent=request">Request a loan</a></div>;
  let estimate: ReturnType<typeof drawAmounts> | null = null;
  try { if (input) estimate = drawAmounts(row.envelope, amount(input, 6), BigInt(market.feeBps)); } catch { /* Form submission explains invalid amounts. */ }
  const days = Number(row.envelope.quote.duration) / 86400;
  return <div className="facility-borrow-grid" data-review={!!review}>{!review && <div className="facility-terms">
    <h2>Choose your terms</h2><div className="facility-terms-list">{directory!.quotes.map(q => <button key={q.id} className="facility-term" aria-pressed={q.id === row.id} onClick={() => choose(q.id)} disabled={busy}>
      <strong>{Number(q.envelope.quote.duration) / 86400} days</strong><span>{show(q.availability.minDraw)}–{show(q.availability.maxDraw)} USDG</span>
      <span>{show(BigInt(q.envelope.quote.interestForCapacity) * 10000n / BigInt(q.envelope.quote.capacity), 2)}% fixed interest</span>
    </button>)}</div><p className="facility-small">These terms share one lending balance. Available USDG is checked again before signing.</p>
  </div>}<form className="facility-loan-form" data-facility-feedback onSubmit={event => { event.preventDefault(); if (!canReview || !row) return; void run(async () => { setConsent(false); setReview(await client.reviewDraw(row.envelope, amount(input, 6))); }); }}>
    <h2>{review ? "Review your loan" : "Your loan"}</h2>
    {review ? <p className="facility-selected-terms">{days}-day loan · {show(BigInt(row.envelope.quote.interestForCapacity) * 10000n / BigInt(row.envelope.quote.capacity), 2)}% fixed interest</p> : <label>You receive · USDG<input inputMode="decimal" value={input} placeholder={`${show(row.availability.minDraw)}–${show(row.availability.maxDraw)}`} disabled={busy} onChange={event => { setInput(event.target.value); setReview(null); setConsent(false); }} /></label>}
    <dl className="facility-figures"><Figure label={`Collateral locked · ${market.collateralSymbol}`}>{review ? show(review.collateral, market.collateralDecimals) : estimate ? show(estimate.collateral, market.collateralDecimals) : "—"}</Figure>
      <Figure label="Fixed interest · USDG">{review ? show(review.interest) : estimate ? show(estimate.interest) : "—"}</Figure>
      <Figure label="Total repayment · USDG">{review ? show(review.repayment) : estimate ? show(estimate.repayment) : "—"}</Figure>{review ? <Figure label="You receive · USDG">{show(review.principal)}</Figure> : <Figure label="Loan duration">{days} days</Figure>}</dl>
    <p className="facility-small">The full fixed interest is due even if you repay early. Network fees are additional.</p>
    {review ? <><p className="facility-deadline">Repay within {days} days of the confirmed loan, followed by a 24-hour grace period. Otherwise the lender can claim all {show(review.collateral, market.collateralDecimals)} {market.collateralSymbol}.</p>
      <p className="facility-small">After repayment, withdraw your collateral separately. Quote expires {date(BigInt(row.envelope.quote.expiresAt))}.</p>
      <label className="facility-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I understand the repayment amount and collateral loss if I miss the final deadline.</span></label>
      <button type="button" className="facility-primary" disabled={!ready || busy || !consent} onClick={() => void run(async progress => { const approved = review; setReview(null); setConsent(false); await client.draw(provider!, approved, progress); }, "Loan confirmed. Your USDG is in your wallet; find the repayment deadline under My loans.")}>Approve collateral and borrow {show(review.principal)} USDG</button>
      <button type="button" className="facility-text" disabled={busy} onClick={() => { setReview(null); setConsent(false); }}>Edit amount or terms</button></> : <button className="facility-primary" disabled={!canReview}>Review loan</button>}
    {!account && <p className="facility-small">Connect your wallet in the header to review your balance.</p>}
  </form></div>;
}

function LenderBalance({ market, client, account, provider, ready, busy, run, revision }: ChildProps) {
  const [state, setState] = useState<Awaited<ReturnType<FacilityClient["fundingState"]>> | null>(null), [loadError, setLoadError] = useState<string | null>(null);
  const [cash, setCash] = useState(""), [capacity, setCapacity] = useState(""), [collateral, setCollateral] = useState(""), [interest, setInterest] = useState("");
  const [days, setDays] = useState("7"), [minimum, setMinimum] = useState(""), [minutes, setMinutes] = useState("10"), [borrower, setBorrower] = useState("");
  const [review, setReview] = useState<QuoteReview | null>(null), [consent, setConsent] = useState(false), [signed, setSigned] = useState<SignedQuote | null>(null), [nonce, setNonce] = useState("");
  useEffect(() => {
    setCash(""); setCapacity(""); setCollateral(""); setInterest(""); setMinimum(""); setDays("7"); setMinutes("10"); setReview(null); setConsent(false); setSigned(null); setNonce(""); setBorrower("");
    if (!account || !same(account, market.lender)) return;
    try {
      const key = `turret:standing:draft:${market.chainId}:${market.address}:${account}`.toLowerCase();
      const draft = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (draft && ["cash", "capacity", "minimum", "collateral", "interest", "days", "minutes"].every(key => typeof draft[key] === "string" && draft[key].length < 100)) {
        amount(draft.cash, 6); amount(draft.capacity, 6); amount(draft.minimum, 6); amount(draft.collateral, market.collateralDecimals);
        if (draft.interest !== "0") amount(draft.interest, 6);
        if (!/^[1-9][0-9]{0,5}$/.test(draft.days) || !/^[1-9][0-9]{0,5}$/.test(draft.minutes)) return;
        setCash(draft.cash); setCapacity(draft.capacity); setMinimum(draft.minimum); setCollateral(draft.collateral); setInterest(draft.interest); setDays(draft.days); setMinutes(draft.minutes);
        sessionStorage.removeItem(key);
      }
    } catch { /* Invalid local drafts never authorize a deposit or signed quote. */ }
  }, [account, market.address, market.chainId, market.collateralDecimals, market.lender]);
  const signedKey = `turret:facility:signed:${market.chainId}:${market.address}:${account ?? ""}`.toLowerCase();
  useEffect(() => { try { const stored = localStorage.getItem(signedKey); if (stored) { const quote = parseSignedQuote(JSON.parse(stored)); if (same(quote.facility, market.address) && quote.chainId === market.chainId) { setSigned(quote); setNonce(quote.quote.nonce); } } } catch { /* Review/cancellation remains available if a previous signature cannot be decoded. */ } }, [signedKey, market.address, market.chainId]);
  useEffect(() => { let live = true; setLoadError(null); void client.fundingState().then(value => { if (live) setState(value); }).catch(error => { if (live) setLoadError(failMessage(error)); }); return () => { live = false; }; }, [client, revision]);
  const owner = !!account && same(account, market.lender), signer = owner || !!account && !!state && same(account, state.quoteSigner);
  if (!state) return <div className="facility-empty" role="status"><h2>{loadError ? "Unable to check this lending balance" : "Checking lender settings…"}</h2>{loadError && <p>{loadError}</p>}</div>;
  const edited = () => { setReview(null); setConsent(false); };
  return <div className="facility-lender">
    {loadError && <p className="facility-error" role="alert">Unable to refresh this lending balance: {loadError} The figures below are from the previous check. Wallet actions verify current state before signing.</p>}
    <section><h2>Your lending balance</h2><dl className="facility-figures"><Figure label="Idle USDG">{show(state.idleCash)}</Figure><Figure label="Outstanding loans · USDG">{show(state.activePrincipal)}</Figure><Figure label="Unresolved defaults · USDG">{show(state.unresolvedDefaultPrincipal)}</Figure><Figure label="New loans">{state.paused ? "Paused" : "Enabled"}</Figure></dl>
      {state.cash !== null && state.cash < state.idleCash && <p className="facility-error">This balance has {show(state.idleCash - state.cash)} USDG missing. New deposits and loans are blocked until the lender acknowledges the loss.</p>}
      {!owner ? <p className="facility-small">This balance belongs to {shortAddress(market.lender)}. To fund your own individual offer, <a href="/borrow/p2p?intent=lend">create a P2P lending offer</a>.</p> : <details className="facility-funding" open={state.idleCash === 0n && state.activePrincipal === 0n}><summary>Manage funding and pause loans</summary><div className="facility-fund-form" data-facility-feedback>
        <p className="facility-small">Repayments become available for new loans after they are returned from the individual loan vault. Defaulted principal stays within your exposure limit until you acknowledge the loss.</p>
        <label>USDG amount<input value={cash} inputMode="decimal" placeholder="0.00" disabled={busy} onChange={event => setCash(event.target.value)} /></label>
        <div className="facility-buttons"><button className="facility-primary" disabled={!ready || busy || !cash} onClick={() => void run(progress => client.deposit(provider!, amount(cash, 6), progress), "USDG deposited. Publish terms to make loans available.")}>Deposit USDG</button>
          <button className="facility-secondary" disabled={!ready || busy || !cash} onClick={() => void run(progress => client.withdrawIdle(provider!, amount(cash, 6), account!, progress), "Idle USDG withdrawn to your wallet.")}>Withdraw idle USDG</button></div>
        <button className="facility-text" disabled={!ready || busy} onClick={() => void run(progress => client.pause(provider!, !state.paused, progress), state.paused ? "New loans resumed. Unexpired quotes may be accepted again." : "New loans paused. Repayment and recovery remain available.")}>{state.paused ? "Resume new loans" : "Pause new loans"}</button>
      </div></details>}
    </section>
    <section className="facility-publish" data-facility-feedback><h2>Publish lending terms</h2><p className="facility-small">One quote can fund several smaller loans. You set collateral and interest for the full capacity; each borrower’s share is rounded up. Signing authorizes spending your deposited USDG on these terms.</p>
      {!signer ? <p>Connect the lender or its appointed quote signer to publish terms.</p> : <form onSubmit={event => { event.preventDefault(); void run(async () => {
        if (!/^[1-9][0-9]*$/.test(days) || !/^[1-9][0-9]*$/.test(minutes)) throw new Error("Use whole positive days and minutes.");
        const fresh = await client.fundingState();
        const random = crypto.getRandomValues(new Uint32Array(4)); const quoteNonce = [...random].reduce((n, part) => (n << 32n) + BigInt(part), 0n);
        setReview(await client.reviewQuote({ epoch: String(fresh.epoch), nonce: String(quoteNonce), borrower: (borrower || ZERO_ADDRESS) as Address,
          capacity: String(amount(capacity, 6)), minDraw: String(amount(minimum || show(fresh.limits.minDraw), 6)), collateralForCapacity: String(amount(collateral, market.collateralDecimals)),
          interestForCapacity: interest === "0" ? "0" : String(amount(interest, 6)), duration: String(BigInt(days) * 86400n), validAfter: String(fresh.timestamp), expiresAt: String(fresh.timestamp + BigInt(minutes) * 60n) })); setConsent(false);
      }); }}>
        <fieldset disabled={busy || !!review}><div className="facility-fields">
          <label>Total quote capacity · USDG<input inputMode="decimal" value={capacity} onChange={e => { setCapacity(e.target.value); edited(); }} /></label>
          <label>Minimum per loan · USDG<input inputMode="decimal" value={minimum} placeholder={show(state.limits.minDraw)} onChange={e => { setMinimum(e.target.value); edited(); }} /></label>
          <label>Collateral for full capacity · {market.collateralSymbol}<input inputMode="decimal" value={collateral} onChange={e => { setCollateral(e.target.value); edited(); }} /></label>
          <label>Interest for full capacity · USDG<input inputMode="decimal" value={interest} onChange={e => { setInterest(e.target.value); edited(); }} /></label>
          <label>Loan duration · days<input inputMode="numeric" value={days} onChange={e => { setDays(e.target.value); edited(); }} /></label>
          <label>Quote available for · minutes<input inputMode="numeric" value={minutes} onChange={e => { setMinutes(e.target.value); edited(); }} /></label>
        </div><details className="facility-borrower-restriction"><summary>{borrower ? `Restricted to ${shortAddress(borrower)}` : "Any borrower · restrict to a wallet"}</summary><label>Permitted borrower · optional<input value={borrower} placeholder="Any wallet" onChange={e => { setBorrower(e.target.value); edited(); }} /></label><p className="facility-small">Restricting acceptance to an address does not make these terms confidential.</p></details></fieldset>
        {review ? <div className="facility-quote-review"><h3>Review authorization</h3><p>Authorize up to <strong>{show(BigInt(review.envelope.quote.capacity))} USDG</strong> in loans for {Number(review.envelope.quote.duration) / 86400} days each, backed by {show(BigInt(review.envelope.quote.collateralForCapacity), market.collateralDecimals)} {market.collateralSymbol} at full capacity.</p>
          <p>Full-capacity repayment is {show(BigInt(review.envelope.quote.capacity) + BigInt(review.envelope.quote.interestForCapacity))} USDG. Turret receives {show(review.feeBps, 2)}% of collected interest; the lender receives the rest. Partial-loan rounding can affect totals.</p>
          <p>Expires {date(BigInt(review.envelope.quote.expiresAt))}. {review.paused ? "New loans are paused. This quote can become usable if you resume before it expires." : "Borrowers can accept immediately once these signed terms are public and capital is available."}</p>
          <label className="facility-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>I authorize lending my deposited USDG on these terms and accept the risk of receiving collateral worth less than the loan.</span></label>
          <button type="button" className="facility-primary" disabled={!ready || busy || !consent} onClick={() => void run(async progress => {
            requirePendingStorage(); const quote = await client.signQuote(provider!, review, progress); setSigned(quote); setNonce(quote.quote.nonce); localStorage.setItem(signedKey, JSON.stringify(quote)); await publishFacilityQuote(quote); setReview(null); setConsent(false);
          }, "Signed terms published. They share this facility’s available USDG.")}>Sign and publish terms</button>
          <button type="button" className="facility-text" disabled={busy} onClick={edited}>Edit terms</button>
        </div> : <button className="facility-primary" disabled={!ready || busy || !capacity || !collateral || !interest}>Review lending terms</button>}
      </form>}
      {signed && <div className="facility-signed"><p>Last signed quote number: <span>{signed.quote.nonce}</span>. A valid signature authorizes loans even if publication failed.</p><button className="facility-text" disabled={!ready || busy} onClick={() => void run(() => publishFacilityQuote(signed), "Signed quote published.")}>Retry publishing this signature</button></div>}
      {owner && <details className="facility-policy"><summary>Quote cancellation and lender limits</summary>
        <p>Pausing does not revoke quotes. Cancel a quote number, or update policy to invalidate all previous quotes.</p>
        <label>Quote number<input inputMode="numeric" value={nonce} onChange={e => setNonce(e.target.value)} disabled={busy} /></label>
        <button className="facility-secondary" disabled={!ready || busy || !/^(0|[1-9][0-9]*)$/.test(nonce)} onClick={() => void run(progress => client.cancelQuote(provider!, BigInt(nonce), progress), "Quote cancelled on chain.")}>Cancel quote</button>
        <PolicyForm key={String(state.epoch)} {...{ client, provider, ready, busy, run, state, market }} />
      </details>}
    </section>
  </div>;
}

function PolicyForm({ client, provider, ready, busy, run, state, market }: Pick<ChildProps, "client" | "provider" | "ready" | "busy" | "run" | "market"> & { state: Awaited<ReturnType<FacilityClient["fundingState"]>> }) {
  const [revoke, setRevoke] = useState(false);
  const initialCollateral = show((state.limits.minCollateralPerPrincipalWad + 10n ** 12n - 1n) / 10n ** 12n, market.collateralDecimals);
  const [fields, setFields] = useState({ exposure: show(state.limits.maxExposure), min: show(state.limits.minDraw), max: show(state.limits.maxDraw),
    minDays: String(state.limits.minDuration / 86400n), maxDays: String(state.limits.maxDuration / 86400n), lifetime: String(state.limits.maxQuoteLifetime),
    collateral: initialCollateral, interest: show(state.limits.minInterestBps, 2), signer: same(state.quoteSigner, ZERO_ADDRESS) ? "" : state.quoteSigner });
  const [agreed, setAgreed] = useState(false);
  const field = (key: keyof typeof fields, label: string, numeric = false) => <label key={key}>{label}<input value={fields[key]} inputMode={numeric ? "numeric" : "decimal"} disabled={busy} onChange={event => { setFields(before => ({ ...before, [key]: event.target.value })); setAgreed(false); }} /></label>;
  return <div className="facility-policy-current" data-facility-feedback><h3>Current limits</h3><dl className="facility-figures"><Figure label="Maximum exposure · USDG">{show(state.limits.maxExposure)}</Figure><Figure label="Maximum per loan · USDG">{show(state.limits.maxDraw)}</Figure><Figure label="Duration range">{String(state.limits.minDuration / 86400n)}–{String(state.limits.maxDuration / 86400n)} days</Figure><Figure label="Quote signer">{same(state.quoteSigner, ZERO_ADDRESS) ? "Lender only" : shortAddress(state.quoteSigner)}</Figure></dl>
    <label className="facility-consent"><input type="checkbox" checked={revoke} disabled={busy} onChange={e => setRevoke(e.target.checked)} /><span>Invalidate every previous quote while keeping these limits and signer.</span></label>
    <button className="facility-secondary" disabled={!ready || busy || !revoke} onClick={() => void run(progress => client.setPolicy(provider!, state.limits, state.quoteSigner, progress), "All previous quotes revoked. Limits and signer remain the same.")}>Revoke all previous quotes</button>
    <details><summary>Change limits or appoint a signer</summary><p>These are hard limits on new loans. A quote signer can authorize lending inside them but cannot withdraw your funds. Saving changes revokes every previous quote.</p>
      <form onSubmit={event => { event.preventDefault(); if (!agreed) return; void run(async progress => {
        for (const key of ["minDays", "maxDays", "lifetime"] as const) if (!/^[1-9][0-9]*$/.test(fields[key])) throw new Error("Durations and quote lifetime must be whole positive numbers.");
        const limits = { maxExposure: amount(fields.exposure, 6), minDraw: amount(fields.min, 6), maxDraw: amount(fields.max, 6),
          minDuration: BigInt(fields.minDays) * 86400n, maxDuration: BigInt(fields.maxDays) * 86400n, maxQuoteLifetime: BigInt(fields.lifetime),
          minCollateralPerPrincipalWad: fields.collateral === initialCollateral ? state.limits.minCollateralPerPrincipalWad : amount(fields.collateral, market.collateralDecimals) * 10n ** 12n,
          minInterestBps: fields.interest === "0" ? 0n : amount(fields.interest, 2) };
        if (limits.maxDraw < limits.minDraw || limits.maxExposure < limits.maxDraw || limits.maxDuration < limits.minDuration || limits.minInterestBps > 10000n) throw new Error("Check the minimum, maximum and exposure limits. Minimum interest cannot exceed 100%.");
        await client.setPolicy(provider!, limits, (fields.signer || ZERO_ADDRESS) as Address, progress);
      }, "Lender limits updated. All previous quotes are revoked."); }}><div className="facility-fields">
        {field("exposure", "Maximum total exposure · USDG")}{field("min", "Minimum per loan · USDG")}{field("max", "Maximum per loan · USDG")}
        {field("minDays", "Shortest loan · days", true)}{field("maxDays", "Longest loan · days", true)}{field("lifetime", "Maximum quote lifetime · seconds", true)}
        {field("collateral", `Minimum ${market.collateralSymbol} per 1 USDG`)}{field("interest", "Minimum fixed interest · %")}
      </div><label>Optional quote signer address<input value={fields.signer} placeholder="Lender only" disabled={busy} onChange={event => { setFields(before => ({ ...before, signer: event.target.value })); setAgreed(false); }} /></label>
        <label className="facility-consent"><input type="checkbox" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} /><span>I approve these lending limits and signer, and understand all previous quotes will be revoked.</span></label>
        <button className="facility-secondary" disabled={!ready || busy || !agreed}>Update lending limits</button>
      </form>
    </details>
    {state.cash !== null && state.cash < state.idleCash && <LossAction label={`Acknowledge ${show(state.idleCash - state.cash)} USDG missing from idle cash`} ready={ready} busy={busy} action={() => run(progress => client.acknowledgeIdleLoss(provider!, progress), "Missing idle USDG acknowledged. No funds were recovered.")} />}
  </div>;
}

function FacilityLoans(props: ChildProps) {
  const { client, account, revision, busy } = props;
  const [rows, setRows] = useState<Awaited<ReturnType<FacilityClient["loanPage"]>>["rows"]>([]), [cursor, setCursor] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const loadedOlder = useRef(false);
  const [indexComplete, setIndexComplete] = useState(true), historyEpoch = useRef<number | undefined>(undefined);
  const [id, setId] = useState<bigint | null>(null), [find, setFind] = useState("");
  useEffect(() => {
    let live = true; if (!account) { setLoading(false); return; }
    setLoading(true); setError(null);
    void client.loanPage(account).then(page => { if (live) {
      const reorganized = historyEpoch.current !== undefined && page.historyEpoch !== historyEpoch.current;
      historyEpoch.current = page.historyEpoch; setIndexComplete(page.indexComplete !== false);
      setRows(before => [...new Map([...(reorganized ? [] : before), ...page.rows].map(row => [String(row.id), row])).values()].sort((a, b) => a.id > b.id ? -1 : 1));
      if (!loadedOlder.current || reorganized) setCursor(page.nextCursor);
      if (reorganized) { loadedOlder.current = false; setId(null); }
    } }).catch(error => { if (live) setError(failMessage(error)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [client, account, revision]);
  if (!account) return <div className="facility-empty"><h2>Your loans and repayments</h2><p>Connect your wallet to see loans you borrowed or funded through this lending balance.</p></div>;
  return <div className="facility-loans"><div className="facility-loans-list"><h2>Your loans</h2>
    {loading && <p role="status">Checking loan state…</p>}{error && <p role="alert" className="facility-error">{error}</p>}
    {!indexComplete && <p role="status">Loan history is still syncing. These results may be incomplete; refresh to check progress.</p>}
    {!loading && !error && indexComplete && !rows.length && <p>{cursor ? "No loans for your wallet in these recent results. Check older loans below." : "You have no loans in this lending balance."}</p>}
    {rows.map(loan => <button className="facility-loan-row" key={String(loan.id)} aria-pressed={id === loan.id} disabled={busy} onClick={() => setId(loan.id)}>
      <span><strong>Loan #{String(loan.id)}</strong><span>{same(loan.borrower, account) ? "You borrowed" : "You lent"} {show(loan.principal)} USDG</span></span><span>{loan.status === 1 ? "Active" : loan.status === 2 ? "Repaid" : "Defaulted"}</span>
    </button>)}
    {cursor !== null && <><p className="facility-small">Showing loaded loans. Older loans are not included yet; open a loan to refresh its exact state.</p><button className="facility-text" disabled={loading || busy} onClick={async () => {
      setLoading(true); setError(null); try {
        const page = await client.loanPage(account, cursor);
        if (historyEpoch.current !== undefined && page.historyEpoch !== historyEpoch.current) throw new Error("Loan history changed during pagination. Refresh to reload canonical results.");
        loadedOlder.current = true;
        setIndexComplete(page.indexComplete !== false);
        setRows(before => [...new Map([...before, ...page.rows].map(row => [String(row.id), row])).values()]); setCursor(page.nextCursor);
      } catch (error) { setError(failMessage(error)); } finally { setLoading(false); }
    }}>Check older loans</button></>}
    <details className="facility-find"><summary>Find a loan by number</summary><form onSubmit={event => { event.preventDefault(); if (/^[1-9][0-9]*$/.test(find)) setId(BigInt(find)); }}><label>Loan number<input inputMode="numeric" value={find} onChange={e => setFind(e.target.value)} disabled={busy} /></label><button className="facility-secondary" disabled={busy || !/^[1-9][0-9]*$/.test(find)}>Open loan</button></form></details>
  </div>{id ? <FacilityLoan key={String(id)} {...props} id={id} /> : <div className="facility-loan-placeholder"><p>Select a loan to see its deadline, repayment and available withdrawals.</p></div>}</div>;
}

function FacilityLoan({ id, market, client, account, provider, ready, busy, run, revision }: ChildProps & { id: bigint }) {
  const [loan, setLoan] = useState<Awaited<ReturnType<FacilityClient["loan"]>> | null>(null), [credits, setCredits] = useState<Awaited<ReturnType<FacilityClient["loanCredits"]>> | null>(null);
  const [error, setError] = useState<string | null>(null), [consent, setConsent] = useState(false), [withdraw, setWithdraw] = useState("");
  const [extension, setExtension] = useState<readonly [Address, bigint, bigint, bigint, bigint] | null>(null);
  const [extraDays, setExtraDays] = useState(""), [extensionConsent, setExtensionConsent] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setError(null);
    void client.loan(id).then(value => { if (live) setLoan(value); }).catch(error => { if (live) setError(failMessage(error)); });
    void client.loanCredits(id).then(value => { if (live) setCredits(value); }).catch(() => { if (live) setCredits(null); });
    void client.extension(id).then(value => { if (live) setExtension(value); }).catch(() => { if (live) setExtension(null); });
    return () => { live = false; };
  }, [client, id, revision]);
  if (error) return <div className="facility-error" role="alert"><p>{error}</p><p>Refresh loan state before acting.</p></div>;
  if (!loan) return <div role="status">Loading loan #{String(id)}…</div>;
  const owner = same(account, market.lender), borrower = same(account, loan.borrower), active = loan.status === 1;
  const finalDeadline = loan.dueAt + 86400n, overdue = BigInt(Math.floor(Date.now() / 1000)) > finalDeadline;
  const receivesCollateral = loan.status === 2 && borrower || loan.status === 3 && owner;
  const extensionKey = extension?.map(String).join(":") ?? null;
  return <section className="facility-loan-detail"><h2>Loan #{String(id)}</h2><dl className="facility-figures">
    <Figure label={active ? "Total repayment · USDG" : "Agreed repayment · USDG"}>{show(loan.principal + loan.interest)}</Figure>
    <Figure label={`Pledged ${market.collateralSymbol}`}>{show(loan.collateralAmount, market.collateralDecimals)}</Figure>
    <Figure label="Repayment due">{date(loan.dueAt)}</Figure><Figure label="Final deadline · includes grace">{date(finalDeadline)}</Figure>
  </dl><p className="facility-small">{active ? "Early repayment owes the same total. If repayment is missed, the lender can claim all pledged collateral after the final deadline." : loan.status === 2 ? "This loan was repaid. Withdraw collateral and repayment credits separately." : "This loan defaulted. The lender is entitled to its pledged collateral."}</p>
    {active && borrower && !overdue && <div className="facility-loan-action" data-facility-feedback><label className="facility-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>Repay {show(loan.principal + loan.interest)} USDG from my wallet. I will withdraw my collateral afterward.</span></label><button className="facility-primary" disabled={!ready || busy || !consent} onClick={() => void run(progress => client.repay(provider!, id, progress), "Loan repaid. Withdraw your collateral below to return it to your wallet.")}>Approve and repay {show(loan.principal + loan.interest)} USDG</button></div>}
    {active && overdue && owner && <div className="facility-loan-action" data-facility-feedback><p>The final deadline has passed. Settle the default to make collateral available for withdrawal.</p><button className="facility-primary" disabled={!ready || busy} onClick={() => void run(progress => client.claimDefault(provider!, id, progress), "Default settled. Collateral is now claimable by the lender.")}>Settle default</button></div>}
    {receivesCollateral && <div className="facility-loan-action" data-facility-feedback><h3>Collateral withdrawal</h3><p>{credits?.collateral == null ? "Available collateral could not be checked. Refresh before withdrawing." : `${show(credits.collateral, market.collateralDecimals)} ${market.collateralSymbol} available for your wallet.`}</p>
      {credits?.collateral != null && credits.collateral < loan.collateralCredit && <p className="facility-small">Recorded credit is {show(loan.collateralCredit, market.collateralDecimals)}. The remaining collateral is missing.</p>}
      <button className="facility-primary" disabled={!ready || busy || !credits?.collateral} onClick={() => void run(progress => client.withdrawCollateral(provider!, id, credits!.collateral!, account!, progress), "Collateral withdrawn to your wallet.")}>Withdraw available collateral</button>
      {credits?.collateral != null && credits.collateral < loan.collateralCredit && <LossAction label="Acknowledge missing collateral" busy={busy} ready={ready} action={() => run(progress => client.writeOffCollateral(provider!, id, progress), "Missing collateral acknowledged. No assets were recovered by this action.")} />}
    </div>}
    {owner && loan.status === 2 && <div className="facility-loan-action" data-facility-feedback><h3>Repayment credit</h3><p>{credits?.repayment == null ? "Available repayment could not be verified." : `${show(credits.repayment)} USDG can be withdrawn or returned to the lending balance.`}</p><p className="facility-small">Recorded lender credit: {show(loan.lenderCredit)} USDG. Only available funds can be withdrawn.</p>
      <div className="facility-buttons"><button className="facility-primary" disabled={!ready || busy || !credits?.repayment} onClick={() => void run(progress => client.recycleRepayment(provider!, id, progress), "Available repayment returned to the lending balance.")}>Return repayment to lending</button></div>
      <label>Withdraw to my wallet · USDG<input inputMode="decimal" value={withdraw} onChange={e => setWithdraw(e.target.value)} disabled={busy} /></label><button className="facility-secondary" disabled={!ready || busy || !withdraw || !credits?.repayment} onClick={() => void run(progress => client.withdrawRepayment(provider!, id, amount(withdraw, 6), account!, progress), "Repayment withdrawn to your wallet.")}>Withdraw repayment</button>
      {credits?.repayment != null && credits.repayment < loan.lenderCredit && <LossAction label="Acknowledge missing repayment" busy={busy} ready={ready} action={() => run(progress => client.writeOffRepayment(provider!, id, progress), "Missing repayment acknowledged. No USDG was recovered by this action.")} />}
    </div>}
    {owner && loan.status === 3 && !loan.defaultAcknowledged && <LossAction label={`Acknowledge ${show(loan.principal)} USDG default principal`} ready={ready && loan.collateralCredit === 0n} busy={busy} action={() => run(progress => client.acknowledgeDefault(provider!, id, progress), "Default principal acknowledged and removed from unresolved exposure.")}><p>Withdraw or acknowledge missing collateral first. This records the principal basis as defaulted; it does not mean the loan was repaid or collateral sold for that amount.</p></LossAction>}
    {active && (owner || borrower) && <details className="facility-extension" data-facility-feedback><summary>Agree to a later repayment deadline</summary><p>The other party must accept. Fixed interest stays the same; a proposal alone does not extend your deadline.</p>
      <form onSubmit={e => { e.preventDefault(); void run(async progress => { if (!/^[1-9][0-9]*$/.test(extraDays)) throw new Error("Enter whole positive days."); const latest = await client.loan(id); const block = await client.verifyIdentity(); await client.proposeExtension(provider!, id, latest.dueAt + 86400n + BigInt(extraDays) * 86400n, block.timestamp + 3600n, progress); }, "Deadline extension proposed. The current deadline still applies until accepted."); }}><label>Additional days<input inputMode="numeric" value={extraDays} onChange={e => setExtraDays(e.target.value)} disabled={busy} /></label><button className="facility-secondary" disabled={!ready || busy || !extraDays}>Propose extension</button></form>
      {extension && !same(extension[0], ZERO_ADDRESS) && <div className="facility-extension-review"><p>Proposed final deadline: {date(extension[3])}. Acceptance expires {date(extension[4])}.</p>{same(extension[0], account) ? <button className="facility-text" disabled={!ready || busy} onClick={() => void run(progress => client.cancelExtension(provider!, id, progress), "Extension proposal cancelled.")}>Cancel proposal</button> : <><label className="facility-consent"><input type="checkbox" checked={extensionConsent === extensionKey} disabled={busy} onChange={e => setExtensionConsent(e.target.checked ? extensionKey : null)} /><span>Accept this exact later deadline with unchanged interest.</span></label><button className="facility-secondary" disabled={!ready || busy || extensionConsent !== extensionKey} onClick={() => void run(progress => client.acceptExtension(provider!, id, extension[1], extension[2], extension[3], extension[4], progress), "New repayment deadline confirmed.")}>Accept extension</button></>}</div>}
    </details>}
    <details className="facility-small"><summary>Loan vault and protocol credit</summary><p className="facility-address">Vault: {loan.vault}</p><p>Protocol fee recorded: {show(loan.feeCredit)} USDG. Available: {credits?.fee == null ? "unknown" : `${show(credits.fee)} USDG`}.</p>{!!credits?.fee && <button className="facility-text" disabled={!ready || busy} onClick={() => void run(progress => client.collectFee(provider!, id, progress), "Available fee sent to the protocol recipient.")}>Collect available protocol fee</button>}</details>
  </section>;
}
function LossAction({ label, children, ready, busy, action }: { label: string; children?: ReactNode; ready: boolean; busy: boolean; action: () => Promise<void> }) {
  const [checked, setChecked] = useState(false);
  return <details className="facility-loss" data-facility-feedback><summary>{label}</summary>{children}<label className="facility-consent"><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} /><span>I understand this records a loss. It does not recover funds or collateral.</span></label><button className="facility-secondary" disabled={!ready || busy || !checked} onClick={() => void action()}>{label}</button></details>;
}
