import { useEffect, useId, useRef, useState } from "react";

type Asset = { address: string; collateralSymbol: string; collateralName?: string };
const label = (asset: Asset) => `${asset.collateralSymbol} · ${asset.collateralName ?? asset.collateralSymbol}`;

export function CollateralPicker({ assets, value, onChange }: {
  assets: Asset[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const selected = assets.find((asset) => asset.address.toLowerCase() === value.toLowerCase());
  const matches = assets.filter((asset) => label(asset).toLowerCase().includes(query.trim().toLowerCase()));
  const index = Math.min(active, Math.max(0, matches.length - 1));
  useEffect(() => {
    if (open) list.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index, open]);
  const choose = (asset: Asset) => { onChange(asset.address); setOpen(false); setQuery(""); };
  return <div className="p2p-collateral-picker" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(""); }
  }}>
    <label htmlFor={id}>Collateral asset</label>
    <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={`${id}-options`} aria-activedescendant={open && matches.length ? `${id}-option-${index}` : undefined}
      autoComplete="off" placeholder="Search by symbol or token name"
      value={open ? query : selected ? label(selected) : ""}
      onFocus={() => { setOpen(true); setQuery(""); setActive(0); }}
      onClick={() => { if (!open) { setOpen(true); setQuery(""); setActive(0); } }}
      onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          setActive(open ? Math.max(0, Math.min(matches.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))) : 0);
        } else if (event.key === "Enter" && open) {
          event.preventDefault(); if (matches[index]) choose(matches[index]);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery("");
        }
      }} />
    {open && <div className="p2p-collateral-options">
      <ul ref={list} id={`${id}-options`} role="listbox" aria-label="Collateral assets">
        {matches.map((asset, i) => <li key={asset.address} id={`${id}-option-${i}`} role="option"
          aria-selected={asset.address.toLowerCase() === value.toLowerCase()} data-active={i === index}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(asset)}>
          <strong>{asset.collateralSymbol}</strong><span>{asset.collateralName ?? asset.collateralSymbol}</span>
        </li>)}
      </ul>
      {!matches.length && <p role="status">No matching assets. Try another symbol or name.</p>}
    </div>}
  </div>;
}
