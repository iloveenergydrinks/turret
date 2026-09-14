import {useEffect, useId, useMemo, useRef, useState} from "react";
import type {Deployment} from "../../p2p/client";
import {memecoinMarkets} from "../../borrow/memecoin-offers";
import {CollateralLogo} from "./CollateralLogo";
import "./RequestCollateralPicker.css";

type Group = "all" | "memes" | "other";
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export function RequestCollateralPicker({markets, value, disabled, onChange, label = "Request collateral", emptyLabel = "Choose collateral"}: {
  markets: Deployment[]; value: string; disabled: boolean; label?: string; emptyLabel?: string; onChange: (address: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<Group>("all");
  const [active, setActive] = useState(0);
  const memes = useMemo(() => new Set(memecoinMarkets(markets).map(m => m.address.toLowerCase())), [markets]);
  const selected = markets.find(m => m.address.toLowerCase() === value.toLowerCase());
  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return markets.filter(m => (group === "all" || memes.has(m.address.toLowerCase()) === (group === "memes"))
      && words.every(word => `${m.collateralSymbol} ${m.collateralName ?? ""} ${m.collateralToken ?? ""}`.toLowerCase().includes(word)))
      .sort((a, b) => a.collateralSymbol.localeCompare(b.collateralSymbol) || a.address.localeCompare(b.address));
  }, [markets, query, group, memes]);
  const index = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-option-${index}`)?.scrollIntoView?.({block: "nearest"}); }, [open, index, id, query, group]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const close = () => { setOpen(false); trigger.current?.focus({preventScroll: true}); };
  const choose = (market: Deployment) => { if (disabled) return; onChange(market.address); close(); };
  return <div className="request-collateral" onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <span id={`${id}-label`} className="request-collateral-label">{label}</span>
    <button ref={trigger} type="button" className="request-collateral-trigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-selection`} aria-expanded={open} aria-controls={`${id}-panel`}
      onClick={() => { setQuery(""); setGroup("all"); setActive(0); setOpen(!open); }}>
      {selected && <CollateralLogo market={selected} />}
      <span id={`${id}-selection`} className="request-collateral-name"><strong>{selected?.collateralSymbol ?? emptyLabel}</strong><span>{selected?.collateralName ?? "Select a supported asset"}</span></span>
      <span className="request-collateral-change">{open ? "Close" : "Change"}</span>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" data-open={open}><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <section id={`${id}-panel`} className="request-collateral-panel" aria-label="Choose request collateral">
      <div className="request-collateral-search">
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref={search} aria-label="Search collateral" role="combobox" aria-autocomplete="list" aria-expanded="true"
          aria-controls={`${id}-results`} aria-activedescendant={results.length ? `${id}-option-${index}` : undefined}
          placeholder="Name, symbol or address" value={query} autoComplete="off" spellCheck={false}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault(); setActive(event.key === "Home" ? 0 : event.key === "End" ? results.length - 1
                : Math.max(0, Math.min(results.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter") { event.preventDefault(); if (results[index]) choose(results[index]); }
          }} />
      </div>
      <div className="request-collateral-filters" role="group" aria-label="Asset type">
        {([["all", "All assets"], ["memes", "Memecoins"], ["other", "Stocks & funds"]] as const).map(([key, label]) =>
          <button type="button" key={key} aria-pressed={group === key} onClick={() => { setGroup(key); setActive(0); search.current?.focus(); }}>{label}</button>)}
      </div>
      <ul id={`${id}-results`} role="listbox" aria-label="Supported collateral" className="request-collateral-results">
        {results.map((m, i) => <li key={m.address} id={`${id}-option-${i}`} role="option"
          aria-selected={m.address.toLowerCase() === value.toLowerCase()} data-active={i === index}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(m)}>
          <CollateralLogo market={m} />
          <span className="request-collateral-name"><strong>{m.collateralSymbol}</strong><span>{m.collateralName ?? m.collateralSymbol}</span></span>
          <span className="request-collateral-address" title={m.collateralToken}>{m.collateralToken ? short(m.collateralToken) : ""}</span>
          <svg className="request-collateral-check" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4 10-10" /></svg>
        </li>)}
      </ul>
      {!results.length && <div className="request-collateral-empty" role="status"><strong>No matching collateral</strong><p>Try a different name, symbol or address.</p><button type="button" onClick={() => { setQuery(""); setGroup("all"); setActive(0); search.current?.focus(); }}>Show all assets</button></div>}
      <p className="request-collateral-count" role="status">{results.length} {results.length === 1 ? "asset" : "assets"} · Robinhood Chain</p>
    </section>}
  </div>;
}
