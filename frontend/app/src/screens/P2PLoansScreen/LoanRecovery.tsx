import { useId, useState } from "react";
import type { Deployment, Loan } from "../../p2p/client";

export function LoanRecovery({ markets, open, busy }: {
  markets: Deployment[];
  open(market: Deployment, id: bigint): Promise<Loan>;
  busy: boolean;
}) {
  const fieldId = useId();
  const [address, setAddress] = useState("");
  const [id, setId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return <section className="p2p-controls p2p-recovery">
    <h3>Find a loan by its ID</h3>
    <p className="p2p-help">Open a known loan directly, even while your loan list is updating. Use the market and loan ID from your offer link.</p>
    <form className="p2p-form" onSubmit={async event => {
      event.preventDefault();
      if (loading || busy) return;
      const market = markets.find(market => market.address === address);
      if (!market || !/^[1-9]\d{0,77}$/.test(id) || BigInt(id) >= 2n ** 256n) {
        setError("Choose a market and enter a valid positive loan ID."); return;
      }
      setLoading(true); setError("");
      try { await open(market, BigInt(id)); }
      catch { setError("This loan could not be loaded. Check the market and ID, then retry."); }
      finally { setLoading(false); }
    }}>
      <div className="p2p-fields">
        <div><label htmlFor={`${fieldId}-market`}>Loan market</label><select id={`${fieldId}-market`} value={address} onChange={event => setAddress(event.target.value)} disabled={loading || busy}>
          <option value="">Select a market</option>
          {markets.map(market => <option key={market.address} value={market.address}>{market.collateralSymbol}{market.legacy || (market.version !== 2 && market.version !== 3) ? " · legacy" : ` · V${market.version}`}</option>)}
        </select></div>
        <div><label htmlFor={`${fieldId}-loan`}>Loan ID</label><input id={`${fieldId}-loan`} inputMode="numeric" value={id} maxLength={78} onChange={event => setId(event.target.value)} disabled={loading || busy} placeholder="e.g. 12" /></div>
      </div>
      <button className="p2p-button p2p-secondary" type="submit" disabled={loading || busy}>{loading ? "Opening loan…" : "Open loan"}</button>
      {error && <p role="alert" className="p2p-help">{error}</p>}
    </form>
  </section>;
}
