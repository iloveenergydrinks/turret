# Risk monitor

> September 5, 2026: the legacy pilot Railway services have been deleted.
> Their volumes remain detached for recovery. The legacy `railway-services.json`
> now has empty active service and backup lists; its former values are retained
> under `historicalConfiguration`. See the [retirement record](../../docs/security/railway-legacy-cleanup-2026-09-05.md).

For the current pooled Stock Token deployment and session-aware implementation,
use the [24/5 rollout runbook](../../docs/security/stock-24x5-rollout-2026-09-03.md).
The private-pilot deployment details below are historical; do not use them to
retarget the current engine or restore the retired keeper signer.

## Calendar maintenance

The current source contains the published NYSE holiday and early-close dates for
2026–2028. `/status.calendar` reports coverage and time remaining. Within 90 days
of expiry the monitor raises `risk_calendar_expiring`; beyond reviewed coverage it
withholds borrowing approvals and raises `risk_calendar_expired`. A calendar
warning does not replace live venue, price or liquidation checks. Review each new
schedule before extending coverage; do not infer holidays from generic formulas.
Source: [NYSE holidays and trading hours](https://www.nyse.com/trade/hours-calendars).

## Historical Chainlink-based private pilot

This is the selected replacement for the Pyth candidate. It is **deployed in observation mode, with the replacement guarded vault paused and funded with 250 USDG**. The funded liquidation keeper is running in execution mode; the frontend and borrower-alert service target this replacement. It uses the existing canonical Chainlink price as the sole on-chain valuation source. An operator-controlled monitor compares that price with independent stock data and issues short-lived borrowing approvals. This does not provide two independent decentralized oracles.

## Limits enforced by the contracts

- `DockyardUSDGCreditVaultPilot`: immutable 250 USDG global debt ceiling, maximum 50 USDG per market, fees included. Maximum borrow LTV 30%, liquidation threshold at most 40%, liquidation bonus at most 5%, origination fee 0.5%.
- An owner-managed borrower allowlist applies to **all** borrowing entry points, including the old ABI. The candidate initially allows only the existing owner wallet. Removing a borrower cannot prevent repayment or collateral top-ups.
- `DockyardHeartbeatGuard`: Chainlink price strictly younger than its configured feed heartbeat (86,400 seconds for these ten feeds), valid rounds and positive answers, canonical corporate-action and token-pause checks. The multiplier is already incorporated in the Chainlink value; it is applied only to the independent stock quote for comparison.
- Borrowing and collateral withdrawal with outstanding debt require an EIP-712 approval for the exact guard contract, chain 4663, Chainlink round, price/timestamp hash and incident epoch. Approvals expire in at most 60 seconds; the worker issues at most 45 seconds and never beyond the source quote's 60-second age limit or session close.
- Borrowing hours: 09:35–15:50 America/New_York, 12:50 close on reviewed half days. Weekends and NYSE holidays are excluded. The reviewed calendar ends December 31, 2026 and then fails closed.
- Two minutes of continuous healthy observations are required before the worker signs. A process restart, more than 30 seconds between observations, or a failed comparison restarts recovery. On-chain incident recovery additionally enforces a two-minute delay.
- The guardian may revoke outstanding approvals and quarantine liquidations on a confirmed price disagreement. It cannot set a price, withdraw vault money, change limits, enable markets or add borrowers. Its key is distinct from the owner and keeper.
- Missing monitoring data stops approval issuance. Previously issued approvals remain usable until revoked or expired. Liquidation using a fresh Chainlink price continues during an ordinary monitor outage. A known price disagreement quarantines liquidation until recovery. Detection, transaction inclusion and Chainlink shared-source risk remain.
- Repayment, existing-position collateral top-ups, and debt-free exits do not require a monitor approval. Token transfer restrictions still apply.

## Cost and data access

Healthy cycles do not submit on-chain transactions. A borrowing transaction carries its approval through `depositAndBorrowChecked`; incident quarantine and recovery are the guardian's only routine gas-consuming operations. Anvil verification measures the actual combined transaction, rather than assuming this is free.

The implemented data client uses Alpaca snapshots with an explicit `iex` or entitled `sip` feed. It compares a fresh bid/ask midpoint against both the latest trade and Chainlink, rejects crossed/wide quotes and source timestamps older than 60 seconds, and enforces 2% maximum price deviation. It never falls back to delayed SIP, cached daily bars or a second proxy to the same Chainlink aggregator.

Alpaca advertises a free developer/paper-account IEX tier and a $99/month individual Algo Trader Plus tier. Those prices do **not** establish business licensing for Dockyard. Actual account access, live timestamp quality, symbol coverage and permitted internal monitoring use must be verified before activation. The terms linked by the signup page restrict use to personal/noncommercial purposes by default, require 30 days of advance written notice for commercial or third-party applications, and require written consent for specified commercial distribution. A paper-account key or a successful API response does not establish Dockyard's commercial permission. Keep account testing separate from activation until that permission is resolved. [Signup terms, pages 1–2](https://s3.amazonaws.com/files.alpaca.markets/disclosures/library/TermsAndConditions.pdf). On September 2, the authenticated paper account showed the Basic plan. Its API key and secret were stored and read back successfully in the separate Railway `dockyard-risk-monitor` service, with `ALPACA_DATA_FEED=iex` and `RISK_MODE=observe`. A real API request using those stored credentials returned trade and quote records for all ten configured symbols. This was after the regular session; quotes were stale or invalid, so `marketDataVerified` remains false. No subscription was purchased. The monitor is now deployed in observation mode; its independent five-minute watchdog has completed a healthy check. [API verification evidence](../../docs/security/evidence/2026-09-02/pilot-alpaca-api-verification.json). [Alpaca access and plans](https://docs.alpaca.markets/us/docs/about-market-data-api), [snapshot schema](https://docs.alpaca.markets/us/reference/stocksnapshots-1), [reviewed session calendar](https://www.nyse.com/trade/hours-calendars).

## Configuration

Build using `services/risk-monitor/Dockerfile` with the repository root as context. Node 24 and the keeper's frozen viem dependency are reused. One replica, persistent `/data`, no sleeping, automatic restarts, `/healthz` liveness. The authenticated `/status` endpoint distinguishes readiness from process life. Public `/approvals/<collateral>` returns only a signed decision and deployment identity; it does not distribute stock prices.

Required variables:

| Variable | Purpose |
| --- | --- |
| `RISK_MANIFEST_JSON` or `RISK_MANIFEST_PATH` | Verified deployment output; simulation manifests cannot execute |
| `RISK_MODE` | Defaults to `observe`; `execute` permits signing and incident transactions |
| `RISK_GUARDIAN_PRIVATE_KEY` | Dedicated guardian EOA, kept in Railway secrets |
| `ALCHEMY_RPC_URL`, `KEEPER_FALLBACK_RPC_URLS` | Existing RPC selection and canonical-block checks |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | Independent stock data credentials |
| `ALPACA_DATA_FEED` | `iex` by default; `sip` only when entitled |
| `RISK_STATUS_TOKEN` | At least 32 random characters |
| `RISK_APP_ORIGIN` | Exact frontend origin allowed by CORS |
| `RISK_DATA_DIR` | Persistent volume; current deployment uses `/data/heartbeat-v2` |
| `RISK_KEEPER_STATUS_URL`, `RISK_KEEPER_STATUS_TOKEN` | Authenticated keeper status; required in execute mode |
| `RISK_ALERT_WEBHOOK_URL` | Operator alert webhook; alternatively use the Resend fields below |
| `RESEND_API_KEY`, `RISK_ALERT_EMAIL_FROM`, `RISK_ALERT_EMAIL_TO` | Verified-domain operator email delivery |

Execution requires a `receipt-verified` manifest and `marketDataVerified: true`. Those fields record completed verification; changing them is not a substitute for verification. Alert transport is tested at startup and hourly. Failed transport, insufficient guardian gas, or a keeper that is unavailable, underfunded, unreconciled, not executing, or bound to a different deployment withholds all approvals. Keeper scans must be no older than 30 seconds; chain, vault address, code hash and signer must match the manifest. Transaction intents, nonces, replacements, receipts and gas budgets use the keeper's durable SQLite journal.

Run the independent watchdog as a separate Railway scheduled service every five minutes, with command `node services/risk-monitor/src/watchdog.mjs`, `RISK_STATUS_URL`, `RISK_STATUS_TOKEN`, and its own volume. It delivers incidents through the configured direct alert channel and exits successfully after confirmed delivery. It exits nonzero only when direct delivery is unavailable, and signals Railway once per unchanged condition. Run it independently of the worker so it can detect worker death.

## Current deployment

The receipt-verified replacement vault is `0xb99D842DFFc140b9DD1927767653Bf21861120e9`; the guardian is `0x81Cfef2D90007B13A5C3FCd52d1B5b51165d4Fe8`, funded with 0.002 ETH. Use `contracts/utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json` (`revision: heartbeat-v2`). The original five-minute pilot at `0x9545CA977C235BE45eD97C5fD76b5309376a8eB9` is superseded and unfunded. Do not enable it or use its manifest.

The new vault contains 250 USDG, has zero debt, is paused, and has all markets disabled. Only the owner is allowlisted. V1 was paused and verified debt-free before the owner moved 250 USDG. Its remaining 41.802475 USDG stays in V1. The replacement's keeper, frontend and borrower alerts are deployed; the keeper is operational in execute mode with 295.734670 USDG and 0.01 ETH at the September 2 verification. These balances are dated evidence, not guarantees.

The monitor at <https://dockyard-risk-monitor-production.up.railway.app> runs with `RISK_MODE=observe` and `marketDataVerified: false`. Its watchdog runs every five minutes with `RISK_EXPECTED_MODE=observe` and `RISK_EXPECTED_VAULT` set to the replacement. Change expected mode together with worker activation. Both services have separate persistent volumes; daily/weekly backup schedules are configured. Actual backup restoration remains untested.

Operator email delivery was confirmed through Resend delivered events. Runtime settings and IDs are in `railway-services.json`; apply them with `python3 services/risk-monitor/scripts/configure-railway.py --apply`. This configures the listed monitor/watchdog runtime settings and the listed volume backup schedules. Source-only release bundles exclude credentials and unrelated work.

See the [rollout report and evidence](../../docs/security/dockyard-heartbeat-rollout-2026-09-02.md) for receipts, source verification, migration, service checks and remaining risks.

## Activation runbook

**Deployment, guardian funding, V1 migration, keeper retargeting, frontend deployment and borrower-alert retargeting are complete. Do not redeploy contracts to activate this pilot.**

1. Review real in-session observations and run `node services/risk-monitor/src/preflight.mjs` with the deployed manifest and credentials. Require fresh independent quotes, valid primary prices, agreement and continuous recovery. A successful API response or accumulated observation count alone does not qualify a market. Reduce enabled markets if only some qualify; do not weaken freshness checks.
2. Establish applicable market-data use terms for the intended deployment. Basic IEX API access alone does not establish commercial permission. No subscription or commercial notice has been submitted.
3. Record completed data verification in the receipt-verified manifest, set the monitor and watchdog to execute mode, and verify a fresh proof plus keeper admission. Keep the existing guardian signer and persistent journal. Test approval publication before the owner enables a qualified market and unpauses.
4. Perform a small owner-only real-chain borrow/repay/withdraw canary. Verify keeper discovery and debt reconciliation, and enroll that borrower for email alerts. The replacement borrower-alert database is `/data/heartbeat-v2.sqlite`; V1's database remains preserved. Do not silently reassign old subscriptions.
5. Admit further allowlisted wallets only after those checks pass. The 250 USDG debt cap and treasury holding policy are pilot limits. A legitimate live liquidation has not occurred because there are no eligible positions; the real-token fork liquidation passed.

New deployment tooling, for future reviewed revisions only, is `contracts/script/DeployDockyardHeartbeatPilot.s.sol`. It deploys paused and unfunded. Every receipt, runtime, feed, signer, heartbeat, cap, ownership transfer and creation block must be verified before using its output. Simulation manifests must never authorize execution.

## Verification

### Pooled stock markets

The stock Earn implementation uses the same entrypoint with an explicit
`kind: "stock-pool"` manifest, **one engine/pool per monitor and dedicated keeper**.
It is not activated by the pilot configuration described above. Current work and
verification limits are recorded in
[the pooled stock monitor report](../../docs/security/stock-earn-monitor-2026-09-03.md).

Required manifest fields, in addition to the existing status/data-verification,
chain, owner, keeper, guardian and creation-block fields:

- `vault` / `vaultCodeHash`: the stock credit engine and its runtime hash.
- `pool` / `poolCodeHash`: that engine's lender pool.
- `usdg` / `usdgCodeHash`: canonical USDG and its runtime hash.
- `executionGate` / `executionGateCodeHash`.
- `usdgPrimary` / `usdgPrimaryCodeHash`, `usdgSecondary` / `usdgSecondaryCodeHash`.
- Exactly one `markets` entry with `symbol`, `collateral`, `collateralCodeHash`,
  `primaryOracle`, `primaryCodeHash`, `adapter`, `adapterCodeHash`, and
  `maxPriceAgeSeconds`. Symbol checks are not evidence of canonical token identity;
  the deployment and data sources must also be qualified before activation.

All hashes refer to deployed runtime, not creation bytecode. On every scan the
monitor verifies the engine/pool/dependency wiring, guardian and heartbeat; it
simulates the actual checked quote before releasing borrowing certificates.
Runtime pins cannot establish proxy-implementation immutability, independent data
provenance, commercial rights, or sufficient collateral liquidity.
The latest candidate uses two health signatures: price authorization for the
guard and market authorization for the specific engine. The engine validates and
caches its own authorization; HTTP labels are not the security boundary. The
health payload is `(Health, bytes priceSignature, bytes marketSignature)`. Public
quarantine-recovery transactions deliberately contain only the price proof.
See [engine-scoped authorization](../../docs/security/stock-earn-authorization-2026-09-03.md).

The public frontend endpoint is `GET /stock/approvals/<engine>` and returns the
exact engine/pool/feed identities plus separate `health` and `liveness` proofs.
Pilot-style `/approvals/<collateral>` is not available in stock-pool mode.
`GET /liveness` identifies this engine in the `vault` field for its stock keeper.
Execution liveness intentionally remains independent of keeper admission: the
keeper first needs liveness to price the pool and become ready. Borrowing approval
still requires the correctly bound, funded, reconciled execution keeper.

Operator notification delivery also runs independently of chain observations and
execution-proof publication. Slow or rejected email/webhook requests cannot stop
proof refresh. Notification attempts are serialized, with only the latest waiting
incident snapshot retained. New admission waits for verified transport and a
successfully processed notification snapshot matching the current incident codes
and severities. This does not bypass price validity, chain quorum, recovery,
guardian signatures or proof expiry. It does not fix loss of the immutable guardian
key or the lender withdrawal restrictions in the existing contracts.

Run `pnpm test:stock-integration` from this service directory with Anvil available
and current compiled contracts. This starts the real monitor and keeper on a
local chain. The subprocess fixture replaces only the market-data HTTP response
and wall-clock offset; it is never imported by production entrypoints. Mock data
and local liquidity do not qualify production providers or routes.

From `contracts`: `forge test --match-contract 'DockyardHeartbeatPilotTest|DockyardChainlinkPilotTest|DockyardOracleV2Test|DockyardUSDGCreditVaultTest' --fuzz-runs 1000`.

From `services/risk-monitor`: `node --test test/*.test.mjs`, then `node --test test/evm.integration.mjs` (requires local Anvil and compiled Foundry artifacts). The latter sends a JavaScript-produced EIP-712 approval to the actual Solidity bytecode and verifies expiration and exit behavior; it uses local mocks and is not live-data validation.

From `frontend/app`: `pnpm exec vitest run src/dockyard-risk-approval.test.ts src/screens/DockyardBorrowScreen/PositionSafety.test.tsx` and `pnpm exec tsc --noEmit`.

The existing keeper and borrower-alert suites must also pass from their respective service directories. Fresh in-session independent data, applicable data-use permission, risk-monitor execution checks and the owner canary remain activation gates. Receipt/source verification, migration, guardian funding, keeper execution/readiness, observation monitoring and operator email delivery are complete. Overnight price gaps, sequencer outages and insufficient collateral liquidity are not solved by this design.
