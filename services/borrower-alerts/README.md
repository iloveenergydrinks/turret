# Dockyard borrower alerts

Read-only borrower notifications for Robinhood Chain 4663 and vault
`0x576c510e9A268B06448f67598B7BF1ed33388e20`. This is separate from the liquidator.
It has **no signing key, token approvals, or authority to move funds**.

Stock mode is the default. A separate, undeployed isolated-market mode is documented
in [ISOLATED.md](./ISOLATED.md); it requires its own deployment and borrower consent.

## Behavior

- Scans verified subscribers' positions every 15 seconds, non-overlapping. Reads
  position, price and market threshold at one block. A stale chain head (>60s),
  failed position read or rejected dual-oracle price is not interpreted as safe.
- Uses the vault's exact integer safety comparison (USDG 6 / collateral 18 decimals).
  Warning: <=10% further price decline to liquidation. Critical: <=3%. Eligible:
  debt strictly exceeds the liquidation threshold. Equality is not eligible.
- Sends only approaching-liquidation, critical and liquidation-eligible warnings, with immediate escalation and at most hourly reminders at the same severity. Recovery, unavailable data, transaction failures and confirmed liquidations are recorded without borrower messages.
  Unknown, healthy and repaid states cancel queued stale warnings silently. Only verified email-confirmation requests and explicitly classified risk warnings can pass the delivery allowlist, including after upgrades. Risk jobs expire after one hour.
- Scans `Liquidated` logs with 12-block confirmation depth and a durable cursor;
  catches up 1,000 blocks per cycle without skipping gaps. A confirmed cursor hash
  mismatch fails closed and needs operator investigation, not a blind cursor reset.
  No pre-subscription event history is delivered. The first scan establishes the cursor.
- Watches failed receipts for wallet-owned, Dockyard-targeted transactions linked
  by the active frontend alert session. Not a general wallet transaction indexer.
- Signatures bind site, wallet, chain, vault, single-use nonce and five-minute expiry.
  Thirty-minute bearer sessions are held only in browser memory. Email requires
  a one-time confirmation; Telegram requires `/start` in the user's private bot chat.
- Persists encrypted contacts and outbox in SQLite WAL. Retries up to 10 attempts
  with exponential backoff (30 seconds to one hour); non-risk jobs expire after a day.
  Resend requests use idempotency keys. Telegram has no equivalent: a timeout after
  provider acceptance or process crash can produce duplicates (at-least-once).
- Provider acceptance is **not proof of inbox delivery or that a borrower read it**.
  Alerts are best-effort. Price gaps and delayed transactions can liquidate before
  a notification arrives. UI states this explicitly.

## Deployment configuration

Run one replica (no horizontal replicas with a shared SQLite file).
Build from repository root with `services/borrower-alerts/Dockerfile`.
Attach a persistent volume at `/data`; ensure the service can write there.
Set the variables in `.env.example` in the hosting secret manager:

1. `ALERTS_APP_ORIGIN`: exact canonical frontend origin (HTTPS in production).
2. `ALERTS_DATA_KEY`: 32 cryptographically random bytes encoded as 64 hex characters.
   Keep separately from the database and back it up securely. Losing it loses the
   subscriptions. Do not rotate without a database re-encryption migration.
3. A read-only `ALERTS_RPC_URL` on Robinhood Chain (public default is available).
4. Email: a sending-only `RESEND_API_KEY` scoped to verified `turret.capital`.
   The default sender is `Turret <alerts@turret.capital>`; override it with
   `ALERTS_EMAIL_FROM` only for another verified sender. Domain DNS setup alone
   does not supply an API key. No key is needed in the frontend.
5. Telegram: bot token and username from BotFather. This service owns getUpdates;
   do not use the same bot with another poller or a webhook.
6. Public HTTPS URL for this service. Set `NEXT_PUBLIC_BORROWER_ALERTS_URL` to it
   in the frontend **at build time**, and rebuild the frontend. This URL is public;
   no provider key belongs in the frontend.

At least one delivery provider must be configured. No provider is pretended to be
connected when its secrets are absent. This change does not deploy or configure
those providers automatically.

## Verify before enabling publicly

`pnpm install --ignore-workspace --frozen-lockfile && pnpm test`

1. Deploy the service with a persistent volume; monitor `/healthz` externally.
   A 503 means stale/incomplete monitoring, Telegram polling failure, or a recorded
   delivery failure. `/capabilities` separately exposes monitoring/channel configuration.
2. Sign in with an operator-owned test wallet. Verify email and Telegram. Confirm
   a requested email-verification message arrives. Activation itself sends no welcome email.
3. Exercise warnings/recovery, oracle outage and provider failure using test fixtures
   (tests never send real messages). **Do not deliberately liquidate a production borrower.**
4. Restart the service; verify subscriptions, cursor and pending retries survive.
5. Disable channels and check no further messages arrive. Telegram `/stop` removes
   every wallet subscription in that private chat. A message already in flight may
   still arrive. Deletion cannot retract messages already retained by the provider.
6. Exercise wallet switching, rejection, stale sessions and inaccessible-provider UI.
7. Confirm public hostname routing serves `/alerts/verify` on the protocol site.

The in-memory loop is non-overlapping, with eight concurrent position reads per
market. Load-test before expanding beyond a small launch cohort; the hard
100-subscription/pending-confirmation cap is an abuse
ceiling, **not a demonstrated capacity guarantee**. Backlogs and slow RPCs degrade
freshness and must trip the external health monitor. Apply edge rate limits as well:
the built-in IP limiter uses socket IP, not untrusted forwarding headers.

Back up the encrypted SQLite volume and encryption key separately. Restrict database
access, configure retention/backups to match the privacy notice, and avoid request
body logging in proxies. Contacts, signatures and provider/RPC URLs are never logged
by this service. API responses contain generic provider failures only.
