import { useState } from "react";
import type { Address, Hex } from "viem";
import type { Deployment } from "../../p2p/client";
import { loadPendingRecord } from "../../p2p/pending-transactions";

export function PendingRecovery({ account, markets, disabled, onRecover }: {
  account: Address; markets: readonly Deployment[]; disabled: boolean;
  onRecover(market: Address, replacement?: Hex): Promise<void>;
}) {
  const [selected, setSelected] = useState("");
  const [replacement, setReplacement] = useState("");
  const pending = markets.flatMap(market => {
    try {
      const record = loadPendingRecord(`turret:p2p:pending:${market.chainId}:${market.address}:${account}`);
      return record ? [{ market, record }] : [];
    } catch { return []; } // The transaction client reports invalid or unavailable storage explicitly.
  });
  const current = pending.find(row => row.market.address === selected) ?? pending[0];
  if (!current) return null;
  const valid = replacement === "" || /^0x[0-9a-f]{64}$/i.test(replacement);
  return <section className="p2p-feedback">
    <h3>Recover a saved transaction</h3>
    <p>Your saved transaction is checked automatically. If your wallet replaced it, you can provide the confirmed replacement hash to check the original sender, nonce and action.</p>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && valid) void onRecover(current.market.address, replacement ? replacement as Hex : undefined); }}>
      {pending.length > 1 && <label className="p2p-field-block">Saved transaction market<select value={current.market.address} disabled={disabled} onChange={event => { setSelected(event.target.value); setReplacement(""); }}>
        {pending.map(({ market }) => <option key={market.address} value={market.address}>{market.collateralSymbol} · V{market.version ?? 1} · {market.address}</option>)}
      </select></label>}
      <p>Saved hash: <span className="p2p-hash">{current.record.hash}</span></p>
      <label className="p2p-field-block">Replacement transaction hash (optional)<input value={replacement} disabled={disabled} onChange={event => setReplacement(event.target.value.trim())} autoCapitalize="none" spellCheck={false} placeholder="0x…" /></label>
      {!valid && <p role="alert">Enter a complete transaction hash: 0x followed by 64 hexadecimal characters.</p>}
      <button className="p2p-button p2p-secondary" disabled={disabled || !valid}>Check saved transaction</button>
    </form>
  </section>;
}
