# P2P loan notifications

The borrower-alert service supports an explicit `p2p` mode, separate from pooled-loan subscriptions. It sends opt-in email or Telegram notifications for registered V1, V2 and V3 managers. No wallet key is required: contract access is read-only, and a wallet signature only authorizes notification settings.

The P2P website's **Alerts** view verifies the wallet, then verifies each email address or private Telegram chat. It covers acceptance, repayment and default for both parties, extension proposals for the other party, agreed extensions for both parties, and reminders one day and one hour before the final repayment deadline. An overdue notice identifies when default settlement becomes available. Current loans are discovered when consent is given; historical lifecycle events from before channel verification are excluded.

Repayment, default, changed deadlines and cancelled/expired extension proposals invalidate obsolete queued reminders. Every delivery rechecks the registered contract, recipient, canonical event block and current loan state. A failed scan holds pending loan notifications; it never fabricates a safe state. Deadline reminders use actual chain timestamps. Notifications cannot extend a deadline and may arrive late or be missed.

## Service configuration

Use a separate service and durable SQLite database for P2P. Configure:

| Variable | Purpose |
| --- | --- |
| `ALERTS_PROTOCOL=p2p` | Select P2P monitoring. |
| `ALERTS_P2P_REGISTRY_PATH=/app/config/p2p-markets.json` | Release-owned registered managers, token pairs, deployment blocks and expected runtime hashes. The Docker image includes the website registry at this path. |
| `ALERTS_APP_ORIGIN=https://turret.capital` | Exact website origin for consent messages, links and allowed browser requests. |
| `ALERTS_DB_PATH=/data/p2p-alerts.sqlite` | Persistent private database; never share a pooled-alert database. |
| `ALERTS_DATA_KEY` | Existing 32-byte encryption key encoded as 64 hex characters. Preserve across restarts and keep separate from the database volume. |
| `ALERTS_RPC_URL` / `ALERTS_FALLBACK_RPC_URLS` | Read-only RPC and optional comma-separated fallback URLs. |
| `RESEND_API_KEY` / `ALERTS_EMAIL_FROM` | Existing email provider configuration. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` | Existing Telegram provider configuration; only private `/start` verification is accepted. |
| `ALERTS_P2P_CONFIRMATIONS` | Lifecycle-event confirmation depth; default 12, minimum 1. |
| `PORT` | Service HTTP port; default 3030. |

The website uses the private server environment variable `P2P_ALERTS_URL` for its fixed `/api/p2p-alerts/*` proxy. Keep the proxy behind the website access gate. The browser never chooses an upstream and never receives provider credentials. When no upstream is configured the website clearly reports unavailable automatic alerts.

The public API retains the existing `/capabilities`, `/challenge`, `/session`, `/subscriptions` and `/verify` flow. Email links return to `/p2p?alerts=verify#TOKEN` and require an explicit confirmation click. Tokens are removed from the address bar when the component mounts. `/capabilities` includes the exact P2P market scope and chain so a misconfigured service cannot receive wallet signatures or email verification tokens.

The normalized registry is hashed into wallet consent. Changing a manager address, version, token identity, decimals, deployment block or runtime hash changes that scope. The service refuses to reuse the old database for a different scope. Start a separate database and obtain new consent; do not rewrite the stored scope to bypass this check.

## Delivery and recovery

The existing service cycle runs every 15 seconds. Channels become available after a canonical monitor check. `/healthz` reports monitor and delivery readiness; monitor readiness expires after 90 seconds without a successful check. `catching_up` means bounded discovery is incomplete, while verified loans remain monitored. Per scan, each wallet/market discovers at most 160 older records; later scans resume from its saved cursor. New acceptance events discover obligations separately from invitation history.

Contacts, verification records and outbox bodies are encrypted at rest. Jobs, consent blocks, event cursors and delivery records survive a restart. Email retries retain the provider idempotency key. Telegram has no equivalent provider idempotency guarantee: an uncertain send followed by a retry can duplicate a message. A confirmed event-cursor reorganization stops monitoring for operator investigation rather than silently replaying events; reestablish a reviewed canonical cursor without deleting the notification database or delivery records.

Disabling a channel removes its subscription and queued messages. A newly verified contact gets a new consent identity and cannot inherit queued jobs or historical notifications from the previous contact. Pooled-loan notification policy remains unchanged.

## Local verification

Run from the repository root:

```sh
node --test services/borrower-alerts/test/*.test.mjs
node --test frontend/app/scripts/p2p-alerts-proxy.test.mjs
NODE_OPTIONS=--no-experimental-webstorage pnpm --dir frontend/app exec vitest run src/p2p/P2PAlerts.test.tsx
```

The HTTP lifecycle test starts its own local Anvil on a free loopback port, deploys actual V1/V2/V3 contracts and synthetic tokens, signs consent with disposable Anvil wallets, and delivers email/Telegram messages to a local HTTP sink. It verifies reminders, extensions, repayment, default, revocation and duplicate suppression. It never accepts an external RPC or sends to a real provider. It needs the repository's Foundry tools and Node 24 or later.

`ALERTS_P2P_ALLOW_LOCAL=true` permits chain 31337 for local testing only. Production does not need this flag. `createAlertsService()` in `src/server-runtime.mjs` exposes injected read-only clients and test delivery callbacks for local HTTP/browser fixtures; those hooks are not HTTP endpoints and cannot be selected by a website visitor.

The implementation and local tests do not activate a production P2P service, configure delivery credentials or enroll any real wallet.
