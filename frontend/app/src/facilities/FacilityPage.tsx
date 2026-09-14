"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { BorrowPageHeader } from "../borrow/BorrowPageHeader";
import { loadStandingConfig, loadStandingFacility, makeStandingClient } from "./standing-model";
import { isAccount } from "./quotes.mjs";
import { AccountButton } from "../comps/AppLayout/AccountButton";
import { P2PAppLayout } from "../p2p/P2PAppLayout";
import { useWalletSession } from "../wallet/useWalletSession";
import { FacilityWorkspace } from "./FacilityWorkspace";
import { failMessage, loadFacilityQuotes, loadFacilityRegistry, makeFacilityClient, shortAddress, type Directory, type FacilityMarket, type FacilityRegistry } from "./ui-model";

export function FacilityPage({ standalone = false }: { standalone?: boolean }) {
  const [registry, setRegistry] = useState<FacilityRegistry | null>(null), [error, setError] = useState<string | null>(null), [attempt, retry] = useState(0);
  const [selection, setSelection] = useState(() => typeof window === "undefined" ? "all" : new URLSearchParams(window.location.search).get("facility") ?? "all");
  useEffect(() => { let live = true; setError(null); void (async () => {
    const config = await loadStandingConfig();
    if (config && isAccount(selection)) {
      await loadStandingFacility(config, selection as Address);
      const entry = await makeStandingClient(config, () => null).verifyEntry(selection as Address);
      return { schemaVersion: 1 as const, entries: [entry], baseline: config.baseline };
    }
    return loadFacilityRegistry();
  })().then(value => { if (live) setRegistry(value); }).catch(error => { if (live) setError(failMessage(error)); }); return () => { live = false; }; }, [attempt, selection]);
  const market = selection === "all" ? registry?.entries[0] : registry?.entries.find(entry => entry.address.toLowerCase() === selection.toLowerCase());
  const body = <div className="borrow-hub"><BorrowPageHeader active="p2p" />
    {error ? <div className="facility-workspace" role="alert"><h1>Unable to load lending balances</h1><p>{error}</p><button className="facility-secondary" onClick={() => retry(n => n + 1)}>Try again</button><p><a href="/borrow/p2p">Manage individual P2P loans</a></p></div>
      : !registry ? <p role="status">Loading lending balances…</p> : !market || !registry.baseline ? <section className="facility-workspace"><h1>Reusable lending is not active here yet</h1><p>{registry.entries.length ? "The requested lending balance is not in the verified directory." : "Individual P2P offers remain available while reusable lending balances are prepared."}</p><a href="/borrow/p2p?intent=lend">Create an individual lending offer</a><p><a href="/borrow">Browse memecoin loans</a></p></section>
      : <>{registry.entries.length > 1 && <div className="facility-workspace facility-selector"><label>Lending balance<select value={market.address} onChange={event => { setSelection(event.target.value); const url = new URL(window.location.href); url.searchParams.set("facility", event.target.value); window.history.replaceState(null, "", url); }}>{registry.entries.map(entry => <option key={entry.address} value={entry.address}>{entry.collateralSymbol} · {shortAddress(entry.lender)}</option>)}</select></label></div>}
        <ConnectedFacility key={`${market.chainId}:${market.address}`} market={market} baseline={registry.baseline} /></>}
  </div>;
  return standalone ? <P2PAppLayout activePage="borrow" network="Robinhood Chain" wallet={<AccountButton />}>{body}</P2PAppLayout> : body;
}
export function ConnectedFacility({ market, baseline }: { market: FacilityMarket; baseline: NonNullable<FacilityRegistry["baseline"]> }) {
  const session = useWalletSession(), wrongChain = !!session.account && session.chainId !== market.chainId;
  const validAccount = session.provider && !wrongChain ? session.account : null;
  const accountRef = useRef<Address | null>(validAccount); accountRef.current = validAccount;
  useEffect(() => { accountRef.current = validAccount; return () => { accountRef.current = null; }; }, [validAccount]);
  const client = useMemo(() => makeFacilityClient(market, baseline, () => accountRef.current), [market, baseline]);
  const [directory, setDirectory] = useState<Directory | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [attempt, refresh] = useState(0);
  useEffect(() => { setDirectory(null); setError(null); }, [market, validAccount]);
  useEffect(() => {
    let live = true, reading = false;
    const read = async () => {
      if (reading) return; reading = true; if (live) setLoading(true);
      try { const value = await loadFacilityQuotes(market, validAccount ?? undefined); if (live) { setDirectory(value); setError(null); } }
      catch (error) { if (live) setError(failMessage(error)); } finally { reading = false; if (live) setLoading(false); }
    };
    void read(); const timer = setInterval(() => void read(), 15000);
    return () => { live = false; clearInterval(timer); };
  }, [market, validAccount, attempt]);
  const initial = new URLSearchParams(window.location.search).get("intent");
  return <>{session.error && <p role="alert" className="facility-error">{session.error}</p>}<FacilityWorkspace market={market} client={client} account={session.account} provider={session.provider} wrongChain={wrongChain}
    directory={directory} loading={loading} error={error} refresh={() => refresh(n => n + 1)} connect={() => { void session.connect(); }}
    initialTab={initial === "lend" ? "lend" : initial === "loans" ? "loans" : "borrow"} /></>;
}
