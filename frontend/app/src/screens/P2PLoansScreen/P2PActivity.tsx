import { EmptyState } from "../../comps/EmptyState/EmptyState";
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { activityAmount, activityCsv, activityExplorer, readP2PActivity, type ActivityClient, type ActivityPage, type P2PActivityEntry } from "../../p2p/activity";
import type { Deployment } from "../../p2p/client";
import { displayDate, shortAddress } from "./loanPresentation";
import "./P2PActivity.css";

export type ActivityMarket = { config: Deployment; client: ActivityClient };
type Props = { account: Address | null; markets: readonly ActivityMarket[]; refreshKey?: string | number };
type MarketState = { market: ActivityMarket; entries: P2PActivityEntry[]; page?: ActivityPage; loading: boolean; error?: string };

/** Read-only history. A new wallet/configuration remounts the entire view immediately. */
export function P2PActivity(props: Props) {
  const identity = props.markets.map(({ config }) => `${config.chainId}:${config.address}:${config.runtimeHash}:${config.rpcUrl}`).join("|");
  return props.account
    ? <WalletActivity key={`${props.account.toLowerCase()}:${identity}`} {...props} account={props.account} />
    : <section className="p2p-activity"><h2>Transaction activity</h2><p>Connect your wallet to view payments, withdrawals and loan events recorded on-chain.</p></section>;
}

function WalletActivity({ account, markets, refreshKey }: Props & { account: Address }) {
  const [states, setStates] = useState<MarketState[]>(() => markets.map(market => ({ market, entries: [], loading: true })));
  const [filter, setFilter] = useState("");
  const [reload, setReload] = useState(0);
  const [exportError, setExportError] = useState("");
  const current = useRef(states); current.current = states;
  const configuration = useRef(markets); configuration.current = markets;
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);

  async function load(targets: MarketState[], generation: number, signal: AbortSignal, older: boolean) {
    let index = 0;
    const worker = async () => {
      while (index < targets.length && !signal.aborted && generation === epoch.current) {
        const target = targets[index++]!;
        try {
          const page = await readP2PActivity(target.market.client, account, {
            cursor: older ? target.page?.next : null, signal,
          });
          if (signal.aborted || generation !== epoch.current) return;
          setStates(previous => previous.map(state => state.market.config.address === target.market.config.address
            ? { ...state, page, entries: older ? [...state.entries, ...page.entries] : page.entries, loading: false, error: undefined }
            : state));
        } catch (error) {
          if (signal.aborted || generation !== epoch.current) return;
          setStates(previous => previous.map(state => state.market.config.address === target.market.config.address
            ? { ...state, loading: false, error: error instanceof Error ? error.message : "Activity is unavailable. Retry this market." }
            : state));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  }

  useEffect(() => {
    const generation = ++epoch.current, abort = new AbortController(); controller.current = abort;
    const targets = configuration.current.map(market => ({ market, entries: [], loading: true }));
    setStates(targets);
    void load(targets, generation, abort.signal, false);
    return () => { abort.abort(); epoch.current++; };
    // Wallet and deployment changes remount the component; fresh prop arrays do not restart scans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, refreshKey, reload]);

  function loadOlder(onlyAddress?: string) {
    if (current.current.some(state => state.loading) || !controller.current) return;
    const targets = current.current.filter(state => (!onlyAddress || state.market.config.address === onlyAddress)
      && (!state.page || state.page.next !== null));
    const ids = new Set(targets.map(state => state.market.config.address));
    setStates(previous => previous.map(state => ids.has(state.market.config.address) ? { ...state, loading: true, error: undefined } : state));
    void load(targets, epoch.current, controller.current.signal, true);
  }

  const visible = states.filter(state => !filter || state.market.config.address === filter);
  const entries = visible.flatMap(state => state.entries).sort((a, b) => b.timestamp - a.timestamp
    || (a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : 0) || b.logIndex - a.logIndex || a.key.localeCompare(b.key));
  const loading = states.some(state => state.loading), hasMore = visible.some(state => state.page?.next), errors = visible.filter(state => state.error);
  const complete = visible.length > 0 && visible.every(state => state.page && state.page.next === null && !state.error && !state.loading);
  function downloadCsv() {
    setExportError("");
    try {
      const url = URL.createObjectURL(new Blob([activityCsv(entries, account)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = `turret-p2p-activity-${account}-${complete ? "complete" : "partial"}.csv`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setExportError("The CSV could not be downloaded. Try again in your browser."); }
  }

  return <section className="p2p-activity" aria-labelledby="p2p-activity-title">
    <div className="p2p-activity-heading"><div><h2 id="p2p-activity-title">Transaction activity</h2><p>Past payments, withdrawals and loan events for this wallet. An approval grants spending permission; it is not a completed loan or payment. Open the loan to see its current state.</p></div>
      <button className="p2p-button p2p-secondary" disabled={loading} onClick={() => setReload(value => value + 1)}>Refresh activity</button>
    </div>
    <div className="p2p-activity-controls"><label>Market<select value={filter} onChange={event => setFilter(event.target.value)}><option value="">All markets</option>{markets.map(({ config }) => <option key={config.address} value={config.address}>{config.collateralSymbol} · V{config.version ?? 1}{config.legacy ? " · previous" : ""}</option>)}</select></label>
      <button className="p2p-button p2p-secondary" disabled={!entries.length} onClick={downloadCsv}>Export {complete ? "activity" : "loaded activity"} CSV</button>
    </div>
    <p role="status" className="p2p-help">{entries.length} events loaded. {loading ? "Reading on-chain activity…" : complete ? "History loaded through market deployment." : "History is incomplete; older or unavailable events are not included."}</p>
    <p className="p2p-help">Credits and settlements are separate from wallet transfers. A credit used for repayment is included in the full repayment event; adding these rows together would count it twice. Token approvals and network fees are not included.</p>
    {exportError && <p role="alert" className="p2p-help">{exportError}</p>}
    {errors.map(state => <p role="alert" className="p2p-help" key={state.market.config.address}>{state.market.config.collateralSymbol} · V{state.market.config.version ?? 1}: {state.error} <button className="p2p-reset" disabled={loading} onClick={() => state.error?.includes("snapshot changed") || state.error?.includes("reorganized") ? setReload(value => value + 1) : loadOlder(state.market.config.address)}>Retry activity</button></p>)}
    {!entries.length && !loading && !errors.length && <EmptyState title={filter ? "No activity for this market" : complete ? "Your loan activity will appear here" : "No activity in the blocks checked"}
      description={complete ? "Payments, withdrawals and loan events appear here after confirmation onchain." : "This is a partial history. Load older activity to keep checking for earlier transactions."}
      actions={filter ? <button className="p2p-button" onClick={() => setFilter("")}>Show all markets</button> : complete ? <a className="p2p-button" href="/borrow/p2p">Explore P2P loans</a> : undefined} />}
    <div className="p2p-activity-list">{entries.map(entry => <article className="p2p-activity-row" key={entry.key}>
      <div><h3>{entry.action}</h3><p>{entry.marketSymbol} · V{entry.version}{entry.loanId !== undefined && <> · <a href={`/borrow/p2p?market=${entry.market}&offer=${entry.loanId}`}>Loan #{entry.loanId.toString()}</a></>}</p><time dateTime={new Date(entry.timestamp * 1000).toISOString()}>{displayDate(entry.timestamp)}</time></div>
      <div className="p2p-activity-amount"><strong>{activityAmount(entry) || "—"}</strong>{entry.writtenOff !== undefined && entry.writtenOff > 0n && <span>Written off: {activityAmount({ ...entry, amount: entry.writtenOff })}</span>}</div>
      <details><summary>Transaction details</summary><dl>
        {entry.actor && <div><dt>Initiator / payer</dt><dd className="p2p-address">{entry.actor}</dd></div>}
        {entry.recipient && <div><dt>Recipient / credited account</dt><dd className="p2p-address">{entry.recipient}</dd></div>}
        <div><dt>Transaction</dt><dd className="p2p-address">{activityExplorer(entry, entry.transactionHash) ? <a href={activityExplorer(entry, entry.transactionHash)!} target="_blank" rel="noreferrer">{entry.transactionHash}</a> : entry.transactionHash}</dd></div>
        <div><dt>Block</dt><dd>{entry.blockNumber.toString()}</dd></div>
        <div><dt>Market</dt><dd title={entry.market}>{shortAddress(entry.market)}</dd></div>
      </dl>{entry.detail && <p className="p2p-help">{entry.detail}</p>}</details>
    </article>)}</div>
    {visible.filter(state => state.page).map(state => <p className="p2p-help" key={state.market.config.address}>{state.market.config.collateralSymbol} · V{state.market.config.version ?? 1}: checked blocks {state.page!.scannedFrom.toString()}–{state.page!.anchor.toString()}{state.page!.next ? "; older history remains." : "; reached deployment."}</p>)}
    {hasMore && <button className="p2p-button p2p-secondary" disabled={loading} onClick={() => loadOlder(filter || undefined)}>Load older activity</button>}
  </section>;
}
