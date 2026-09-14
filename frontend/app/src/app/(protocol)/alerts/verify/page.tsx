"use client";
import { alertsRequest, resolveAlertScope } from "@/src/dockyard-alert-scope";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
export default function VerifyAlerts() {
  return <Suspense><VerifyRoute /></Suspense>;
}
function VerifyRoute() {
  const params = useSearchParams();
  const engines = params.getAll("engine");
  const engine = engines.length === 0 ? undefined : engines.length === 1 ? engines[0] : "";
  return <VerifyForm key={engine ?? "stock"} engine={engine} />;
}
function VerifyForm({ engine }: { engine?: string }) {
  const scope = resolveAlertScope(engine);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  const active = useRef(true);
  const pending = useRef(false);
  const back = engine === undefined ? "/borrow" : `/borrow?engine=${encodeURIComponent(engine)}`;
  useEffect(() => {
    active.current = true;
    if (!initialized.current) {
      initialized.current = true;
      const value = window.location.hash.slice(1);
      setToken(/^[a-f0-9]{64}$/.test(value) ? value : "");
      // Keep the engine binding; remove the token and unrelated query parameters.
      window.history.replaceState(null, "", window.location.pathname
        + (engine === undefined ? "" : `?engine=${encodeURIComponent(engine)}`));
      if (!/^[a-f0-9]{64}$/.test(value)) setStatus("This confirmation link is incomplete. Request a new link from your alert settings.");
    }
    return () => { active.current = false; };
  }, []);
  async function confirm() {
    if (!scope || pending.current || !/^[a-f0-9]{64}$/.test(token)) return;
    pending.current = true;
    setBusy(true);
    try {
      await alertsRequest("/verify", "", { token }, undefined, scope);
      if (!active.current) return;
      setToken("");
      setStatus(
        "Email confirmed. Your first delivery is queued; check your inbox, then review alert status on the borrowing page.",
      );
    } catch {
      if (!active.current) return;
      setStatus(
        "This link expired, was already used, or the service is unavailable. Request another confirmation from your wallet’s alert settings.",
      );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <main className="dockyard-borrow">
      <section className="dockyard-alert-settings dockyard-alert-verification">
        <h1>Confirm borrower alerts</h1>
        <p>
          Confirm that this email should receive Turret risk and liquidation notifications for the wallet shown in
          your email.
        </p>
        {scope?.protocol === "isolated" && <p>{scope.symbol} market · Robinhood Chain<br />Vault: {scope.vault}</p>}
        {!scope && <p role="alert">Alerts are not configured for this market. No confirmation has been sent. Check the link with Turret support.</p>}
        <button
          className="dockyard-primary-action"
          disabled={busy || !scope || !/^[a-f0-9]{64}$/.test(token)}
          onClick={() => void confirm()}
        >
          {busy ? "Confirming…" : "Confirm email alerts"}
        </button>
        <p role="status">{status}</p>
        <a className="dockyard-alert-link" href={back}>Back to borrowing</a>
      </section>
    </main>
  );
}
