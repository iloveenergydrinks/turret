"use client";
import { alertsRequest as scopedRequest, resolveAlertScope, type AlertScope } from "@/src/dockyard-alert-scope";
import { useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";

export { ALERTS_URL, alertsRequest } from "@/src/dockyard-alert-scope";
type Subscription = { channel: "email" | "telegram"; delivered: number | null; failed: boolean };
type Capabilities = {
  email: boolean; telegram: boolean; monitorReady: boolean;
  monitorOperational?: boolean; monitorReason?: string;
};

// Memory-only sessions. Changing wallets invalidates local access and any pending
// response; the server independently verifies ownership for every change.
export function BorrowerAlerts(props: { address?: `0x${string}`; transactionHash?: `0x${string}`; engine?: string }) {
  const scope = resolveAlertScope(props.engine);
  return <AlertSettings key={`${props.address ?? "disconnected"}:${props.engine ?? "stock"}`} {...props} scope={scope} />;
}
function AlertSettings({ address, transactionHash, scope }: {
  address?: `0x${string}`; transactionHash?: `0x${string}`; scope: AlertScope | null;
}) {
  const alertsRequest = (path: string, session = "", body?: object, method?: string) =>
    scopedRequest(path, session, body, method, scope);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [session, setSession] = useState("");
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [telegramLink, setTelegramLink] = useState("");
  const active = useRef(true);
  const actionPending = useRef(false);
  const { signMessageAsync } = useSignMessage();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    const refresh = () =>
      alertsRequest("/capabilities").then((value) => {
        if (!cancelled) setCapabilities(value);
      }).catch(() => {
        if (!cancelled) setCapabilities(null);
      });
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const refresh = () =>
      alertsRequest("/subscriptions", session).then((value) => {
        if (!cancelled) setSubscriptions(value);
      }).catch(() => {
        if (!cancelled) {
          setSession("");
          setError("Session expired or service unavailable. Verify your wallet again to manage alerts.");
        }
      });
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session]);
  useEffect(() => {
    if (!session || !transactionHash || !subscriptions.length) return;
    let cancelled = false;
    // RPCs may not see a just-submitted transaction immediately.
    const timer = setTimeout(() => {
      void alertsRequest("/transactions", session, { hash: transactionHash }).catch(() => {
        if (!cancelled) {
          setError("This transaction could not be linked to off-site alerts. Follow its confirmation on this page.");
        }
      });
    }, 4000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, transactionHash, subscriptions.length]);

  async function act(action: () => Promise<void>) {
    if (actionPending.current || !active.current) return;
    actionPending.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      if (active.current) {
        setError(
          e instanceof Error && !e.message.includes("\n")
            ? e.message
            : "Request cancelled or unavailable. Please retry.",
        );
      }
    } finally {
      actionPending.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function verify() {
    if (!address || !scope || !active.current) return;
    const challenge = await alertsRequest("/challenge", "", { wallet: address });
    if (!active.current) return;
    // Prevent a misconfigured service from asking for an unrelated signature.
    const expected =
      `${window.location.origin} requests Dockyard borrower alert access.\nWallet: ${address.toLowerCase()}\nChain ID: 4663\nVault: ${scope.vault}\nNonce: ${challenge.id}\nExpires: `;
    const ending = "\nThis signature only manages notifications. It authorizes no token approvals or transactions.";
    const expiry = typeof challenge.message === "string"
      ? challenge.message.slice(expected.length, -ending.length)
      : "";
    const expires = Date.parse(expiry);
    if (
      typeof challenge.message !== "string" || challenge.message !== expected + expiry + ending
      || !/^[a-f0-9]{64}$/.test(challenge.id) || !Number.isFinite(expires) || expires <= Date.now()
      || expires > Date.now() + 360000
    ) throw new Error("Alert service does not match this site and vault.");
    const signature = await signMessageAsync({ message: challenge.message });
    if (!active.current) return;
    const result = await alertsRequest("/session", "", { id: challenge.id, signature });
    if (active.current) setSession(result.session);
  }
  async function subscribe(channel: "email" | "telegram") {
    const result = await alertsRequest("/subscriptions", session, {
      channel,
      ...(channel === "email" ? { email } : {}),
    });
    if (!active.current) return;
    if (channel === "telegram") {
      if (!/^https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=[a-f0-9]{64}$/.test(result.url)) {
        throw new Error("Invalid Telegram verification link.");
      }
      setTelegramLink(result.url);
      setMessage("Open Telegram and press Start to confirm. The link expires in 15 minutes.");
    } else setMessage("Confirmation email queued. Follow its link to activate alerts; check your spam folder too.");
  }
  async function remove(channel: string) {
    await alertsRequest("/subscriptions", session, { channel }, "DELETE");
    if (active.current) {
      setSubscriptions((rows) => rows.filter((row) => row.channel !== channel));
      setMessage(`${channel === "email" ? "Email" : "Telegram"} alerts disabled.`);
    }
  }
  const monitorOperational = capabilities?.monitorOperational ?? capabilities?.monitorReady;
  const available = monitorOperational && (capabilities?.email || capabilities?.telegram);
  return (
    <section className="dockyard-alert-settings" aria-labelledby="borrower-alerts-title">
      <h2 id="borrower-alerts-title">Alerts when you’re away</h2>
      <p>
        Get warnings when your loan approaches liquidation {scope?.protocol === "isolated" ? `for your ${scope.symbol} position in this market.` : "across your Stock Token positions."}
      </p>
      {!scope || !capabilities
        ? <p role="status">Off-site alerts are currently unavailable. Check your position here regularly.</p>
        : !capabilities.monitorReady
        ? monitorOperational
          ? <p role="alert">Current liquidation-risk checks are unavailable. Loan balances and confirmed transactions are still checked. Liquidation-risk warnings need fresh price data. You can manage alert settings and check your position here.</p>
          : <p role="alert">The alert monitor is unavailable. Do not rely on notifications to protect your collateral.</p>
        : null}
      {!address
        ? <p>Connect your wallet to manage alerts.</p>
        : !session
        ? (
          <button className="dockyard-secondary-action" disabled={busy || !scope} onClick={() => void act(verify)}>
            Verify wallet to manage alerts
          </button>
        )
        : (
          <>
            <p className="dockyard-help">Wallet verified. No transaction or spending approval is required.</p>
            {subscriptions.map((sub) => (
              <div className="dockyard-alert-channel" key={sub.channel}>
                <div>
                  <strong>{sub.channel === "email" ? "Email" : "Telegram"} connected</strong>
                  <p>
                    {sub.failed
                      ? "Delivery failed; retries are queued. Check your position directly."
                      : sub.delivered
                      ? "Last accepted by provider: " + new Date(sub.delivered).toLocaleString()
                      : "Delivery not yet confirmed."}
                  </p>
                </div>
                <button
                  className="dockyard-secondary-action"
                  disabled={busy}
                  onClick={() => void act(() => remove(sub.channel))}
                >
                  Disable {sub.channel}
                </button>
              </div>
            ))}
            {capabilities?.email && !subscriptions.some((s) => s.channel === "email") && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => subscribe("email"));
                }}
              >
                <label className="dockyard-alert-email">
                  Email address<input
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <button className="dockyard-secondary-action" disabled={busy || !available}>
                  Send confirmation email
                </button>
              </form>
            )}
            {capabilities?.telegram && !subscriptions.some((s) => s.channel === "telegram") && (
              <button
                className="dockyard-secondary-action"
                disabled={busy || !available}
                onClick={() => void act(() => subscribe("telegram"))}
              >
                Connect Telegram alerts
              </button>
            )}
            {telegramLink && (
              <a className="dockyard-alert-link" href={telegramLink} target="_blank" rel="noopener noreferrer">
                Confirm in Telegram ↗
              </a>
            )}
            {capabilities && !capabilities.email && !capabilities.telegram && (
              <p>No delivery channels are configured yet.</p>
            )}
          </>
        )}
      {message && <p role="status">{message}</p>}
      {error && <p className="dockyard-form-error" role="alert">{error}</p>}
      <p className="dockyard-help">
        Opt-in only. Your wallet address is linked to your chosen email or Telegram chat for delivery. Disable a channel
        here to delete that subscription. Alerts can be delayed or missed and do not stop liquidation.
        Check this page for transaction confirmations and current data availability.
      </p>
    </section>
  );
}
