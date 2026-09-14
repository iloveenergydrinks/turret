"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import { AccountButton } from "../comps/AppLayout/AccountButton";
import { BorrowPageHeader } from "../borrow/BorrowPageHeader";
import { P2PAppLayout } from "../p2p/P2PAppLayout";
import { loadP2PRegistry, type Deployment } from "../p2p/client";
import { CollateralLogo } from "../screens/P2PLoansScreen/CollateralLogo";
import { RequestCollateralPicker } from "../screens/P2PLoansScreen/RequestCollateralPicker";
import { useWalletSession } from "../wallet/useWalletSession";
import { factoryAbi, type FactoryConfig } from "./factory.mjs";
import { drawAmounts, same } from "./quotes.mjs";
import { failMessage, loadFacilityQuotes, shortAddress, type Directory, type FacilityMarket } from "./ui-model";
import { loadStandingConfig, loadStandingPage, queueStandingRead, makeStandingClient, registerStandingFacility, setupTerms, standingHref, type SetupDraft } from "./standing-model";
import type { FacilityStage } from "./wallet-transactions";
import "./facilities.css";
import { StandingLoans } from "./StandingLoans";

export function StandingPage({ standalone = false }: { standalone?: boolean }) {
  const [config, setConfig] = useState<FactoryConfig | null>(null), [loaded, setLoaded] = useState(false), [error, setError] = useState<string | null>(null), [attempt, retry] = useState(0);
  useEffect(() => { let live = true; setError(null); setLoaded(false); void loadStandingConfig().then(value => { if (live) { setConfig(value); setLoaded(true); } }).catch(error => { if (live) setError(failMessage(error)); }); return () => { live = false; }; }, [attempt]);
  const body = <div className="borrow-hub"><BorrowPageHeader active="p2p" /><section className="facility-workspace standing-workspace">
    <a className="facility-back" href="/borrow/p2p">P2P stocks and memes</a>
    {error ? <div role="alert"><h1>Unable to load standing offers</h1><p>{error}</p><button className="facility-secondary" onClick={() => retry(n => n + 1)}>Try again</button></div>
      : !loaded ? <p role="status">Loading standing offers…</p> : !config ? <><h1>Standing offers are being prepared</h1><p>You can still make and accept individual P2P offers.</p><a href="/borrow/p2p">Open the loan marketplace</a></> : <StandingMarket config={config} />}
  </section></div>;
  return standalone ? <P2PAppLayout activePage="borrow" network="Robinhood Chain" wallet={<AccountButton />}>{body}</P2PAppLayout> : body;
}
export function StandingMarket({ config }: { config: FactoryConfig }) {
  const session = useWalletSession();
  const [tab, setTab] = useState<"borrow" | "lend" | "loans">(() => { const intent = new URLSearchParams(window.location.search).get("intent"); return intent === "lend" || intent === "loans" ? intent : "borrow"; });
  const [markets, setMarkets] = useState<Deployment[]>([]), [marketError, setMarketError] = useState<string | null>(null), [attempt, retry] = useState(0);
  useEffect(() => { let live = true; setMarketError(null); void loadP2PRegistry().then(registry => {
    const seen = new Set<string>(); const matches = registry.markets.filter(m => {
      if (m.chainId !== config.chainId || !config.collateral.some(t => same(t.address, m.collateralToken)) || seen.has(m.collateralToken.toLowerCase())) return false;
      seen.add(m.collateralToken.toLowerCase()); return true;
    });
    if (!matches.length) throw new Error("Supported collateral could not be loaded.");
    if (live) setMarkets(matches);
  }).catch(error => { if (live) setMarketError(failMessage(error)); }); return () => { live = false; }; }, [config, attempt]);
  return <><header className="facility-heading"><div><h1>Standing lending offers</h1><p>Choose terms a lender has already published, or fund a balance for multiple borrowers.</p></div></header>
    <nav className="facility-tabs" aria-label="Standing offers"><button aria-pressed={tab === "borrow"} onClick={() => setTab("borrow")}>Find a loan</button><button aria-pressed={tab === "lend"} onClick={() => setTab("lend")}>Lend USDG</button><button aria-pressed={tab === "loans"} onClick={() => setTab("loans")}>My loans</button></nav>
    {session.error && <p className="facility-error" role="alert">{session.error}</p>}
    {marketError && <div role="alert"><p>{marketError}</p><button className="facility-text" onClick={() => retry(n => n + 1)}>Retry collateral list</button></div>}
    {tab === "borrow" ? <StandingDirectory config={config} markets={markets} account={session.chainId === config.chainId ? session.account : null} />
      : tab === "loans" ? session.account ? <StandingLoans key={session.account} config={config} account={session.account} /> : <div><p>Connect your wallet to find loans and repayments.</p><button className="facility-primary" onClick={() => void session.connect()}>Connect wallet</button></div> : <><LenderSetup config={config} markets={markets} /><h2 className="standing-balances-heading">Your lending balances</h2>{session.account ? <StandingDirectory key={session.account} config={config} markets={markets} account={session.account} lender={session.account} /> : <p>Connect your wallet to find balances you have already created.</p>}</>}
  </>;
}
export function StandingDirectory({ config, markets, account, lender }: { config: FactoryConfig; markets: Deployment[]; account: Address | null; lender?: Address }) {
  const [selection, setSelection] = useState(""), [cursor, setCursor] = useState<string | undefined>(), [next, setNext] = useState<string | null>(null);
  const [entries, setEntries] = useState<FacilityMarket[] | null>(null), [error, setError] = useState<string | null>(null), [attempt, refresh] = useState(0);
  const token = markets.find(m => same(m.address, selection))?.collateralToken;
  useEffect(() => { let live = true; setEntries(null); setError(null); setNext(null);
    void loadStandingPage(config, { after: cursor, collateral: token, lender, available: !lender }).then(page => { if (live) { setEntries(page.entries); setNext(page.nextCursor); } }).catch(error => { if (live) setError(failMessage(error)); });
    return () => { live = false; };
  }, [config, cursor, token, lender, attempt]);
  return <div className="standing-directory">
    <div className="standing-filters"><RequestCollateralPicker markets={markets} value={selection} label="Filter collateral" emptyLabel="All collateral" disabled={!markets.length} onChange={value => { setSelection(value); setCursor(undefined); }} />
      <div className="facility-buttons">{selection && <button className="facility-text" onClick={() => { setSelection(""); setCursor(undefined); }}>All collateral</button>}<button className="facility-text" onClick={() => refresh(n => n + 1)}>Refresh offers</button></div></div>
    {error ? <p className="facility-error" role="alert">{error}</p> : !entries ? <p role="status">Checking the offer directory…</p> : !entries.length ? <div className="facility-empty"><h3>{lender ? "No published lending balances found" : "No published offers in this selection"}</h3><p>{lender ? "If you created a balance but publication failed, choose the same collateral above and resume setup. Your on-chain balance is preserved." : "Try another asset, check again later, or post an individual loan request."}</p>{!lender && <a href="/borrow/p2p?intent=request">Request a loan</a>}</div>
      : <div className="standing-offer-list">{entries.map(entry => lender ? <article className="standing-balance" key={entry.address}><CollateralLogo market={entry} /><div><h3>{entry.collateralSymbol}</h3><p>Balance {shortAddress(entry.address)}</p></div><a className="facility-secondary" href={standingHref(entry.address, "lend")}>Manage balance</a><a className="facility-text" href={standingHref(entry.address, "loans")}>View loans</a></article>
        : <StandingOffer key={`${entry.address}:${attempt}:${account}`} market={entry} account={account} />)}</div>}
    {(cursor || next) && <div className="facility-buttons standing-pagination">{cursor && <button className="facility-secondary" onClick={() => setCursor(undefined)}>First page</button>}{next && <button className="facility-secondary" onClick={() => setCursor(next)}>More lenders</button>}</div>}
  </div>;
}
function StandingOffer({ market, account }: { market: FacilityMarket; account: Address | null }) {
  const [directory, setDirectory] = useState<Directory | null>(null), [error, setError] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  useEffect(() => { let live = true, reading = false;
    const read = async () => { if (reading) return; reading = true; try { const data = await queueStandingRead(() => loadFacilityQuotes(market, account ?? undefined), () => live); if (live && data) { setDirectory(data); setError(null); } } catch (error) { if (live) setError(failMessage(error)); } finally { reading = false; } };
    void read(); const poll = setInterval(() => void read(), 15000), tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { live = false; clearInterval(poll); clearInterval(tick); };
  }, [market, account]);
  const fresh = directory && now - directory.checkedAt < 30000 && now >= directory.checkedAt - 1000;
  const quotes = fresh ? directory.quotes.filter(row => BigInt(row.envelope.quote.expiresAt) * 1000n > BigInt(now)) : [];
  return <article className="standing-offer"><header><CollateralLogo market={market} /><div><h3>{market.collateralSymbol}</h3><span title={market.lender}>Lender {shortAddress(market.lender)}</span></div></header>
    {error ? <p className="facility-error" role="alert">{error}</p> : !directory ? <p role="status">Checking available USDG…</p> : !fresh ? <p role="status">Refreshing available USDG…</p> : !quotes.length ? <p>No offer is currently available for this wallet. Funding, expiry or lender settings may have changed.</p>
      : <>{quotes.slice(0, 3).map(row => {
        const principal = row.availability.maxDraw, terms = drawAmounts(row.envelope, principal, BigInt(market.feeBps));
        return <div className="standing-terms" key={row.id}><div className="standing-term-heading"><strong>Borrow {formatUnits(row.availability.minDraw, 6)}–{formatUnits(principal, 6)} USDG</strong><span>{Number(row.envelope.quote.duration) / 86400} days + 24h grace</span></div>
          <dl className="standing-comparison"><div><dt>Collateral for {formatUnits(principal, 6)} USDG</dt><dd>{formatUnits(terms.collateral, market.collateralDecimals)} {market.collateralSymbol}</dd></div><div><dt>Total to repay</dt><dd>{formatUnits(principal + terms.interest, 6)} USDG</dd></div><div><dt>Fixed interest</dt><dd>{formatUnits(terms.interest, 6)} USDG</dd></div></dl>
          <a className="facility-secondary" href={`${standingHref(market.address)}&quote=${row.id}`}>Review this offer</a></div>;
      })}{quotes.length > 3 && <a className="facility-text" href={standingHref(market.address)}>View all {quotes.length} offers from this lender</a>}<p className="facility-small">These offers share {formatUnits(directory.capacity, 6)} USDG of available capacity. Funding is checked again when you borrow.</p></>}
  </article>;
}
export function LenderSetup({ config, markets }: { config: FactoryConfig; markets: Deployment[] }) {
  const session = useWalletSession(), wrongChain = !!session.account && session.chainId !== config.chainId;
  const account = session.provider && !wrongChain ? session.account : null, accountRef = useRef(account); accountRef.current = account;
  const transport = useMemo(() => makeStandingClient(config, () => accountRef.current), [config]);
  const [selection, setSelection] = useState(""), [draft, setDraft] = useState<SetupDraft>({ budget: "", minimum: "", maximum: "", collateral: "", interest: "", days: "7" });
  const [review, setReview] = useState<ReturnType<typeof setupTerms> | null>(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [stage, setStage] = useState<FacilityStage | null>(null);
  const [created, setCreated] = useState<FacilityMarket | null>(null);
  const active = useRef(false), mounted = useRef(true), scope = `${account}:${selection}`, current = useRef(scope); current.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; accountRef.current = null; }; }, []);
  useEffect(() => { setReview(null); setConsent(false); setCreated(null); setError(null); setStage(null); }, [scope]);
  const market = markets.find(m => same(m.address, selection));
  const token = config.collateral.find(t => same(t.address, market?.collateralToken));
  const run = async (work: (progress: (s: FacilityStage) => void) => Promise<void>) => {
    if (active.current) return; active.current = true; setBusy(true); setError(null); const captured = current.current;
    const progress = (s: FacilityStage) => { if (mounted.current && captured === current.current) setStage(s); };
    try { await work(progress); } catch (error) { if (mounted.current && captured === current.current) setError(failMessage(error)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const publish = async (address: Address, expected: string) => {
    const entry = await registerStandingFacility(config, address);
    if (!mounted.current || current.current !== expected) return;
    setCreated(entry);
  };
  return <section className="standing-setup"><h2>Create your lending balance</h2><p>Choose one collateral token and a USDG budget. Only idle USDG can be withdrawn immediately; money in active loans remains lent out. The collateral may be worth less than the debt if a borrower defaults.</p>
    {created ? <div role="status"><h3>Your {created.collateralSymbol} lending balance is ready</h3><p>Next, deposit USDG and review the terms you will sign. Creating the balance has not transferred any tokens.</p><a className="facility-primary" href={standingHref(created.address, "lend")}>Continue to funding and terms</a></div> : <form onSubmit={event => { event.preventDefault(); void run(async () => {
      if (!token) throw new Error("Choose collateral first.");
      if (!account) throw new Error(wrongChain ? `Switch your wallet to ${config.chainId === 4663 ? "Robinhood Chain" : "the local test chain"}.` : "Connect your wallet and wait for it to become ready.");
      const captured = current.current;
      const existing = await transport.existing(account, token.address);
      if (existing) { await publish(existing, captured); return; }
      const next = setupTerms(draft, token.decimals); await transport.qualify(token.address);
      if (mounted.current && current.current === captured) { setReview(next); setConsent(false); }
    }); }}>
      <fieldset hidden={!!review} disabled={busy || !!review}>
        <RequestCollateralPicker markets={markets} value={selection} disabled={busy || !!review || !markets.length} label="Lend against" onChange={setSelection} />
        <div className="facility-fields">
          {([['budget', 'Lending budget · USDG'], ['minimum', 'Minimum per loan · USDG'], ['maximum', 'Maximum per loan · USDG'], ['collateral', `Collateral for the maximum loan · ${token?.symbol ?? 'tokens'}`], ['interest', 'Fixed interest on the maximum loan · USDG'], ['days', 'Repay within · days']] as const).map(([key, label]) => <label key={key}>{label}<input value={draft[key]} inputMode={key === 'days' ? 'numeric' : 'decimal'} placeholder={key === 'days' ? '7' : '0.00'} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}
        </div>
      </fieldset>
      {review ? <div className="standing-setup-review"><h3>Review your lending limits</h3><p>Up to <strong>{draft.budget} USDG</strong> outstanding across loans against {token?.symbol}. Each loan will be {draft.minimum}–{draft.maximum} USDG for {draft.days} days, plus 24 hours of grace.</p><p>For a {draft.maximum} USDG loan, your entered terms require {draft.collateral} {token?.symbol} collateral and {draft.interest} USDG fixed interest. Smaller loans scale proportionally, rounding up to token units.</p><p>You will create a lending contract controlled by your connected wallet. Funding and signing an offer are separate steps. Offers can remain open for up to 24 hours; you can publish new terms afterward.</p>
        <label className="facility-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>I understand that lent USDG is not available for immediate withdrawal and that collateral may not cover a default.</span></label>
        <div className="facility-buttons"><button type="button" className="facility-primary" disabled={busy || !consent} onClick={() => void run(async progress => {
          if (!account || !session.provider || !token) throw new Error("Your wallet changed. Reconnect and review setup again.");
          const captured = current.current;
          let address = await transport.existing(account, token.address);
          if (!address) {
            await transport.transactions.execute(session.provider, account, { address: config.factory, abi: factoryAbi, functionName: "createFacility", args: [token.address, review.limits], label: "Create lending balance" }, progress, { check: () => transport.qualify(token.address) });
            address = await transport.existing(account, token.address);
            if (!address) throw new Error("Creation is not visible yet. Check the transaction status and resume setup.");
            // This draft is a convenience only. Every deposit and quote is independently reviewed and checked.
            try { sessionStorage.setItem(`turret:standing:draft:${config.chainId}:${address}:${account}`.toLowerCase(), JSON.stringify(review.quote)); } catch { /* The lender can re-enter terms on the next screen. */ }
          }
          await publish(address, captured);
        })}>Create balance in wallet</button><button type="button" className="facility-text" disabled={busy} onClick={() => { setReview(null); setConsent(false); }}>Edit limits</button></div>
      </div> : <>{!session.account ? <button type="button" className="facility-primary" onClick={() => void session.connect()}>Connect wallet</button> : <button className="facility-primary" disabled={busy}>Review or resume setup</button>}<p className="facility-small">Already created a balance? Select its collateral and resume. Existing balances keep their current limits.</p></>}
      {wrongChain && <p role="alert">Switch your wallet to {config.chainId === 4663 ? "Robinhood Chain (4663)" : "the local test chain (31337)"} to continue.</p>}
    </form>}
    {stage && <p role="status">{stage.message}</p>}{stage?.hash && <p className="facility-small facility-address">Transaction: {stage.hash}</p>}{error && <p className="facility-error" role="alert">{error}</p>}
    {session.account && <button className="facility-text" disabled={busy} onClick={() => void run(async progress => { if (!account) throw new Error("Reconnect on the correct network to check a pending transaction."); const found = await transport.transactions.reconcile(account, progress); if (!found) progress({ status: "confirmed", message: "No saved transaction is pending. You can review or resume setup." }); })}>Check previous transaction</button>}
  </section>;
}
