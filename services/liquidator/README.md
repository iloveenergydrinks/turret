# Dockyard liquidation keeper

> September 5, 2026: the legacy pilot Railway services have been deleted.
> Their volumes remain detached for recovery. The legacy `railway-services.json`
> now has empty active service and backup lists; its former values are retained
> under `historicalConfiguration`. See the [retirement record](../../docs/security/railway-legacy-cleanup-2026-09-05.md).

## September 3 stock-canary handoff

The old pilot keeper is retired to **keyless observe mode**. The AAPL isolated
keeper also remains in observe mode while commissioning continues. See
[`keeper-handoff-2026-09-03.md`](../../docs/security/keeper-handoff-2026-09-03.md)
for current service identities and activation blockers. The older deployment
instructions below are historical; do not re-enable the old signer.

`KEEPER_OBSERVER_ADDRESS` preserves the existing account-bound SQLite journal
and read-only balance/receipt monitoring after the key is removed. It rejects
both a nonempty `KEEPER_PRIVATE_KEY` and execute mode, and creates no wallet client.
It is not a distributed nonce lock; do not give the active key to another worker.

For atomic exits, `ISOLATED_MIN_PROFIT_USDG` is a strictly positive absolute
gross-USDG floor. Optional `ISOLATED_MIN_PROFIT_BPS` (integer 0–10000; default 0)
adds a proportional threshold on **quoted repayment**, rounded up to USDG's six
decimals. The effective requirement is the greater of these two values. Every
sizing attempt recalculates it; the signed calldata and receipt journal retain
the exact resulting amount. Missing variables preserve the legacy fixed $1 floor.

The AAPL commissioning configuration uses `0.000001` USDG and `50` bps: $0.005
gross return on $1 repaid, $0.25 on $50. This is before ETH gas; treasury gas
subsidies remain bounded by the unchanged ETH transaction/daily budgets. It does
not guarantee a profitable sale or waive the oracle, route, slippage or receipt
checks. Insolvent loans, dust or adverse execution can still be unexecutable.

An always-on worker for the deployed `DockyardUSDGCreditVault` on Robinhood Chain (4663). It is independent of the inherited Liquity contracts and the Dockyard frontend.

The worker discovers borrowers from vault events, reconciles every discovered position with on-chain debt, monitors both feeds, and submits funded USDG liquidations. It retains seized collateral. **It does not sell collateral, manufacture liquidity, bypass the vault's oracle rules, or fund its own wallet.**

## Deployment

- Project: `edf06c48-4331-4fd1-bf0c-04619089a315` / production.
- Worker: `dockyard-keeper` (`1721f2b2-6b8f-490d-a6c5-10a0513d7674`).
- Watchdog: `dockyard-keeper-watchdog` (`625b8688-ea7b-4757-9de0-651eafcd5a78`).
- Vault: `0xb99D842DFFc140b9DD1927767653Bf21861120e9` (heartbeat pilot, aggregate debt capped at 250 USDG).
- Discovery start block: `52900462`; database directory: `/data/heartbeat-v2`.
- Manifest: `contracts/utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json`.
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (six decimals).
- Keeper: `0xACcCD0d5826eea3d1170d54c3c1cf3C771748A6F`.
- Public liveness: <https://dockyard-keeper-production.up.railway.app/healthz>.

The signer, authenticated status token, and Alchemy RPC URL are server-only Railway variables. The frontend does not receive them. The watchdog gets only the status credential; it cannot sign or access the worker database. Each service has its own `/data` volume.

Deploy the worker from the repository root:

```sh
railway up services/liquidator --path-as-root --service dockyard-keeper --environment production --detach
```

Runtime settings are recorded in `railway-services.json`. New Railway services stopped accepting legacy `railway.toml` configuration on August 28, 2026. Apply the explicit settings before deployment (uses existing Railway CLI authentication and only updates the two listed services):

```sh
python3 services/liquidator/scripts/configure-railway.py
python3 services/liquidator/scripts/configure-railway.py --apply
```

Deploy the watchdog from the service directory:

```sh
node scripts/deploy-watchdog.mjs
```

The worker uses one replica, an exclusive volume and a renewable database lease. Do not configure multiple replicas or reuse its signer in another application. Railway must not sleep this service. The watchdog runs every five minutes, separately from the worker, with restart policy `NEVER`. It delivers incidents through the configured direct alert channel and exits successfully after confirmed delivery. It exits nonzero only when direct delivery is unavailable, and signals Railway once per unchanged condition using its persistent volume. This keeps Railway's failed-job notification as a fallback without producing repeated crash notifications for incidents that Resend already delivered.

## Current execution policy

The deployed mode is `execute`. Funding the dedicated address enables spending automatically when a position is eligible. The owner funded it on September 2, 2026 with **295.734670 USDG and 0.01 ETH on Robinhood Chain**, and those balances were reconfirmed after migration to the replacement vault with a 250 USDG global debt ceiling (fees included). The wallet had nonce zero when verified. Always check current exposure before funding; these historical amounts are not an ongoing capital guarantee.

| Control | Railway setting |
| --- | --- |
| Maximum repayment per transaction | 50 USDG |
| Rolling 24-hour repayment budget | 500 USDG |
| Retained collateral cost budget | 500 USDG, persistent across days and restarts |
| Low USDG alert | Below 50 USDG or calculated lending exposure, whichever is greater; exposure respects the verified onchain global debt ceiling |
| ETH reserve | 0.001 ETH must remain after estimated transaction fees |
| Maximum estimated transaction fee | 0.0005 ETH |
| Rolling 24-hour gas budget | 0.003 ETH |
| Receipt confirmation depth | 12 blocks; an operational confirmation threshold, not an L1 finality claim |
| Replacement policy | Same nonce and calldata, 20% fee increase after 60 seconds, at most three replacements |

An allowance is established only when an eligible position needs repayment, and is limited to that repayment. Partial liquidation is supported. The next scan reassesses whether residual debt remains eligible. The keeper receives collateral; no public profitability assumption is needed for this bounded treasury policy. The inventory ledger never assumes that retained tokens have been sold. When that cap is exhausted, execution stops until an operator reviews and deliberately changes the budget. Funding USDG alone does not erase inventory cost.

## Coverage and transaction recovery

1. Replay all borrower events from replacement creation block `52900462`. Persist discovered `(collateral, borrower)` identities and the last processed block hash in SQLite with WAL and synchronous commits.
2. Check the saved block against the canonical chain before continuing. A mismatch rebuilds discovery from deployment. Retaining a stale borrower identity is harmless because balances are read on-chain.
3. Read all market configuration and positions at one block, including disabled markets and collateral-only positions. Sum per-market and global debt and compare it with the vault. No new transaction is sent while discovery is incomplete or the sums disagree.
4. Evaluate the exact `_isSafe` arithmetic, including both integer floors. Read the vault's validated price and both individual feed rounds. Never use an exchange quote to override oracle eligibility.
5. Simulate with current state. Check funds, nonce, allowance and cumulative budgets. Persist the signed transaction and its hash **before** submitting it to RPC.
6. Recover a pending transaction by hash after a restart. Ambiguous sends preserve the same intent and nonce. Check the canonical receipt, confirmation depth, and the matching `Liquidated` event before recording final repayment and collateral amounts.

An untracked consumed nonce or mismatched successful receipt stops further execution for manual reconciliation. Reverts consume the gas budget and activate a retry cooldown. Primary RPC read failures activate a one-minute cooldown and allow the fallback provider to take over. Divergent block hashes stop new sends.

## Status and alerts

```sh
railway ssh --service dockyard-keeper -- node src/status.mjs
railway logs --service dockyard-keeper --lines 100
railway logs --service dockyard-keeper-watchdog --lines 100
```

- `/healthz`: public process-progress check. It is not a statement that liquidation is operational.
- `/status`: authenticated snapshot, coverage, budgets, balance checks, feed health and active incidents.
- `/readyz`: authenticated; requires reconciled execution mode, no critical incidents, and acknowledged direct operator-alert delivery (Resend or webhook). Native Railway email receipt cannot be verified by the worker, so native-only alerting does not pass this stricter readiness check.
- `/metrics`: authenticated Prometheus text output.

The last three endpoints require `Authorization: Bearer <KEEPER_STATUS_TOKEN>`. Read the token through Railway's secret controls; do not put it in URLs, source, shell history, or tickets. Logs deliberately emit error classifications rather than provider error text, because provider errors can contain credentials and signed transaction data.

Set `KEEPER_ALERT_WEBHOOK_URL` to an operator-owned HTTP endpoint for direct incident delivery. Payloads contain `text` plus the structured `event`. The endpoint must return a 2xx response. Alerts are deduplicated, retry failed delivery, and use `KEEPER_ALERT_REMINDER_MS` (disabled by default) for reminders. `scan_failed` and `oracle_blocked` still stop execution on their first cycle, but `KEEPER_ALERT_DEBOUNCE_MS` (30 seconds by default) prevents recovered infrastructure blips from paging the operator. Set a market-specific `KEEPER_ALERT_LABEL` so multi-market deployments remain attributable. Notification history survives recovery, so a flapping condition does not send another outage email every cycle; recovery is visible in logs/status without a recovery email. The current deployment uses direct Resend email through `RESEND_API_KEY`, `KEEPER_ALERT_EMAIL_FROM` and `KEEPER_ALERT_EMAIL_TO`; successful delivery was verified through Resend delivered events. Failed severity escalations retain pending delivery and retry. The independent watchdog also checks execution mode, delivery status and `KEEPER_EXPECTED_VAULT`. Native Railway failed-job email receipt remains a separate unverified channel.

Coverage includes stale/unavailable/mismatched prices, loss of one feed, pending oracle staleness, RPC failover/disagreement, missed scans, low USDG/ETH, pending or failed transactions, exhausted budgets, unhealthy positions, bad debt, and missing or thin collateral liquidity.

## Collateral liquidity

The legacy vault worker (`src/main.mjs`) has no executable stock-token sale route configured. Its default `KEEPER_COLLATERAL_POLICY=quote-required` escalates unknown liquidity to critical when debt or inventory exists. The retired pilot used `bounded-hold`, permitted only when the vault enforces a positive global debt ceiling no larger than 250 USDG. It retains unknown-liquidity warnings while requiring enough USDG, gas and inventory capacity for the capped exposure. This is a treasury holding policy, not a verified sale route or a policy for unlimited public lending.

The current stock-pool worker (`src/isolated/main.mjs`) instead binds a dedicated direct AAPL/USDG liquidation executor and requires a successful atomic sale simulation before signing. Its [real-pool fork evidence](../../docs/security/aapl-real-pool-worker-2026-09-03.md) covers the route and receipt recovery. It remains in observation mode pending production qualification; do not apply the legacy holding policy to this market.

An optional read-only quote adapter can be configured with `KEEPER_LIQUIDITY_QUOTE_URL` and `KEEPER_LIQUIDITY_QUOTE_API_KEY`. Every minute per market it receives:

```json
{"chainId":4663,"tokenIn":"0x...","tokenOut":"0x...","amountIn":"100000000000000000"}
```

It must return those exact fields plus `amountOut` (raw six-decimal USDG units) and `timestamp` (Unix milliseconds). Results older than 60 seconds, mismatched tokens/amounts, malformed values, and failed requests are rejected. By default, quote approximately 50 USDG of collateral and alert below 97% of its oracle value. The adapter must obtain an executable quote from the intended venue; it must not simply echo oracle prices. This interface monitors liquidity and never authorizes a swap or approval to an external router.

## Recovery runbook

- **Hard process crash:** preserve the volume and signer identity. The SQLite lease lasts 120 seconds and renews every 10 seconds. A replacement that starts before expiry exits with `isolated_startup_failed`; this prevents overlapping signers. Let the configured supervisor retry after expiry, then inspect authenticated `/status` for reconciliation and the recorded pending hash. Never delete the lease or transaction journal to speed this up. Receipt reconciliation still runs when execution proofs are unavailable; that does not authorize a new transaction. A clean SIGTERM releases the lease only after the current cycle ends.
- **Low funds:** verify the dedicated address and chain, replenish USDG/ETH, and inspect the next status snapshot. Avoid lending exposure above the funded liquidation capacity.
- **Oracle failure:** inspect both round timestamps, token pause state and feed discrepancy. A corporate-action pause, two invalid feeds or excessive disagreement makes the on-chain liquidation revert. The worker cannot override this. The heartbeat guard rejects prices at or beyond 24 hours, so liquidation availability can stop during closures. Its immutable policy cannot be changed in place. Confirmed independent-price disagreement also quarantines liquidation until guardian recovery; ordinary monitor downtime does not itself block a valid primary liquidation price.
- **Stuck transaction:** inspect the recorded hash and nonce, fee caps and balance. Do not send from the keeper account manually. Restarting preserves the journal. Never delete the state volume to clear a pending transaction.
- **Manual nonce/receipt review:** stop execution (`KEEPER_MODE=observe`), reconcile all persisted hashes against the chain, then repair the journal only after establishing the mined outcome. Preserve a secure database backup first.
- **Debt mismatch or index reorg:** wait for history replay, inspect provider health and historical log support. A mismatch blocks new sends; do not mark it reconciled manually.
- **Liquidity/inventory limit:** inspect token transfer restrictions, venue depth and a usable sale or redemption route. Decide whether to hold, sell externally, or adjust the inventory limit after reviewing treasury exposure.
- **Bad debt:** the worker only alerts. It does not hold the owner's key and cannot write off debt or pause borrowing. The vault owner handles those decisions.
- **Emergency stop:** set `KEEPER_MODE=observe` and redeploy. It stops new signing/rebroadcasts; already broadcast transactions may still execute. Restart and deployment changes are not transaction cancellation.

Persistent state is necessary for recovery. Daily and weekly Railway volume backups are configured for both services. Keep backups access controlled: the database contains signed transaction payloads even though it does not contain the private key. Do not copy a live WAL database with a plain file copy; use SQLite's online backup API or a consistent volume snapshot. Retain the original Railway signer secret through redeployments. A volume backup does not replace independent protection against a Railway-wide outage.

The current stock-pool keeper is `4e7e6c38-6872-43cf-86fc-1727bf08ad99`, not the retired pilot. Its September 3 [read-only infrastructure check](../../docs/security/evidence/2026-09-03/stock-keeper-recovery-infrastructure.json) verified `ALWAYS` restart, one replica, no sleep, no deployment overlap, `/data`, and an existing backup. It did not restore that Railway backup or exercise Railway's own restart scheduler. See [Railway restart policy](https://docs.railway.com/deployments/restart-policy).

The subsequent [physical restore drill and current launch handoff](../../docs/security/stock-keeper-railway-restore-2026-09-03.md) passed in production observation mode. The attached volume instance is now `2e1746da-6796-4a71-b934-116973f616ed`; the original instance remains unmounted for rollback. Use the current identifiers in that report for backup operations, not the historical pre-restore instance.

Before a physical restore, establish the exact service/volume identity, freeze execution, preserve the current journal, and reconcile every known hash and account nonce. Select a fresh, confirmed snapshot; retain the original volume and restore first in observation mode. Railway stages a replacement volume and retains the previous unmounted volume, but restoring an older backup removes newer backups. Inspect the staged changes before deploying. A successful restore must recover the correct account/engine-bound state and reconcile it against the chain; a healthy process alone is insufficient. See [Railway backup behavior](https://docs.railway.com/volumes/backups).

## Verification

Stock-pooled candidate integration is documented in
[`stock-earn-liquidator-2026-09-03.md`](../../docs/security/stock-earn-liquidator-2026-09-03.md).
It requires explicit `ISOLATED_MARKET_KIND=stock`, stock/USDG/gate runtime pins
and an engine-bound liveness endpoint; the pilot configuration is not compatible.
Run `pnpm test:stock-integration` for the local guarded engine/pool worker scenarios.
The suite covers retained collateral, two-hop sales and direct Stock Token/USDG
sales. `DockyardStockDirectLiquidator` uses the same checked execution and receipt
interface; it requires its own reviewed deployment/runtime pin. See the
[direct-exit report](../../docs/security/stock-earn-direct-exit-2026-09-03.md) for
receipt tooling, nine point-in-time fork routes and remaining activation checks.
Passing these mock-market scenarios does not authorize a production deployment.


```sh
pnpm install --ignore-workspace --frozen-lockfile
pnpm test
# Pass the secret RPC URL through the environment, not a literal command argument.
pnpm test:fork
```

`test:fork` requires `FORK_RPC_URL`; optionally set `FORK_BLOCK`. It launches a loopback Anvil fork, checks that the RPC is Anvil before using mutation methods, and never broadcasts to mainnet. It uses deployed vault/token bytecode, injects oracle failures locally, creates a small loan, tests missing capital, then runs the actual worker through approval, restart recovery and liquidation of a disabled market. The fork expects the owner to hold its AAPL canary collateral and the vault to start without debt; choose the recorded block for reproduction if live state changes.

The original V1 fork test remains available through `pnpm test:fork`. For the current heartbeat pilot run `FORK_BLOCK=52895529 node --test test/pilot-fork.integration.mjs` with `FORK_RPC_URL` supplied securely. It uses real Robinhood token bytecode with local candidate deployment and price fixtures. It covers migration, borrowing and repayment, expired approvals, stale/reverting prices, missing capital/gas, guardian quarantine/recovery, ambiguous broadcasts, restart recovery and liquidation while borrowing and the market are disabled. It is not a mainnet liquidation or live-data qualification.

Current evidence and deployment receipts are linked from [the heartbeat rollout report](../../docs/security/dockyard-heartbeat-rollout-2026-09-02.md). The replacement keeper passed authenticated readiness with all ten markets reconciled, zero positions and pending transactions, funded balances and delivered operator email. The old V1 is paused and debt-free, and its old journal remains preserved. `verification/2026-09-02-rollout.json` describes the earlier V1 rollout and is historical.

Borrowing remains paused pending live in-session independent-data qualification, applicable data-use terms, risk-monitor activation and an owner-only real-chain canary. Public lending additionally needs resolution of sequencer recovery, off-hours gaps and collateral exit/capital risks. Successful readiness and fork tests do not establish those outcomes.

The [September 3 simulation](../../docs/security/dockyard-pilot-simulation-2026-09-03.md) additionally verifies full-cap price-gap scenarios against the deployed vault and online SQLite backup restoration with pending approval/liquidation transactions. It does not replace Railway volume restoration or live market-data qualification. A real liquidation is not a prerequisite for the capped owner-only pilot.

## Stock-pool watchdog binding

For a dedicated guarded stock keeper, run the same independent watchdog with
`KEEPER_EXPECTED_KIND=stock` and all of:

```text
KEEPER_EXPECTED_VAULT=<stock credit engine>
KEEPER_EXPECTED_POOL=<its capital pool>
KEEPER_EXPECTED_GATE=<its execution gate>
KEEPER_EXPECTED_COLLATERAL=<its Stock Token>
KEEPER_EXPECTED_ACCOUNT=<dedicated keeper address>
KEEPER_EXPECTED_CODE_HASH=<engine runtime hash>
KEEPER_EXPECTED_POOL_CODE_HASH=<pool runtime hash>
```

Missing bindings fail startup. The response must be an operational stock worker
on chain 4663 with those exact identities; a pilot status cannot satisfy it.
The watchdog keeps its own database and authenticated read-only status credential,
never the keeper's signing key. Pilot mode remains the default for existing
deployments. These settings have local subprocess coverage, not a production
stock-pool rollout. See the
[stock monitor report](../../docs/security/stock-earn-monitor-2026-09-03.md).
