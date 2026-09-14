# Dockyard V2 oracle implementation

The stock-only USDG candidate service has a separate [API3 operator guide](API3.md).
The Pyth implementation and historical findings below remain separate from it.

The selected deployment is now the [Chainlink-based private pilot](../risk-monitor/README.md). This Pyth implementation is retained as a candidate and is not being deployed.

Status: implemented and tested locally, with real Pyth signature verification on a Robinhood mainnet fork. **Not deployed, funded, activated, or connected to the public frontend.** The current Railway keeper and V1 vault were not redeployed.

## Provider access

Pyth Pro is self-service through [Pyth Terminal](https://app.pyth.com). On September 2, 2026, the authenticated account had an active Demo trial, but its key returned HTTP 403 for `Equity.US.AAPL/USD`: no entitlement for asset type equity. The same key successfully fetched signed BTC reports. Terminal offers equities under Pro, starting at $2,500/month plus tax; Starter is crypto-only and Free has no API access. No plan was purchased or changed.

All ten exact `Equity.US.<ticker>/USD` spot feeds were found in Pyth's reference API. This is feed availability, not an account entitlement or a demonstrated executable collateral sale route. RedStone was also investigated; an equivalent self-service stock feed configuration was not verified. No unsigned stock-price API was substituted for an authenticated on-chain oracle.

| Stock | Pyth Pro feed ID |
|---|---:|
| AAPL | 922 |
| MSFT | 1292 |
| GOOGL | 1163 |
| AMZN | 954 |
| META | 1272 |
| NVDA | 1314 |
| AMD | 949 |
| ORCL | 1324 |
| MU | 1298 |
| TSLA | 1435 |

Official Robinhood Pyth verifier: `0xACeA761c27A909d4D3895128EBe6370FDE2dF481`. Runtime hash observed at block 52850604: `0xef41b6fae0a92ef125e99f23cab7dd4bbd4a29d9a16e6de418dd5851bb03b77e`. It verifies provider signatures, not prices signed by Dockyard. Its upstream upgrade authority remains a trust dependency.

## Contract behavior

- `DockyardPythVerifier` checks signatures using that deployed verifier and stores the signed price, confidence, publisher count, exponent, market session and **underlying feed update timestamp**. A new envelope does not refresh a carried-forward price. Old/duplicate reports cannot roll back newer state. Unknown, duplicate, truncated and trailing payload fields are rejected. Missing or invalid values in a newer signed report invalidate the previous usable value.
- `DockyardDualOracle` requires both canonical Chainlink and Pyth to be usable and within the deviation limit. There is no single-source fallback. Pyth stock prices are converted into raw token prices using `uiMultiplier`; Chainlink's token price is not multiplied again. Prices predating an effective corporate action are rejected.
- Signed reports must be less than 30 seconds old. Their underlying prices must be less than the per-market independent maximum age (candidate: 60 seconds). Future timestamps fail. Quality requires at least two publishers and positive confidence no greater than 1% of price in the candidate policy.
- Per-market Chainlink maximum age is separately configured. The candidate uses a **provisional 24-hour upper bound**, because observed Chainlink rounds already range from minutes to over six hours old. It is no longer sufficient for borrowing: a fresh independent observation and at most 2% price disagreement are mandatory. Confirm actual provider heartbeat/deviation guarantees and measure agreement before activating each market. Blindly replacing that bound with five minutes would disable many current markets.
- Candidate borrowing and debt-backed withdrawals require the signed regular trading session. Liquidation accepts regular, pre-market, post-market and overnight sessions while prices are valid. Closed sessions block price-sensitive actions. Session state comes from authenticated reports rather than a hardcoded Monday–Friday calendar; delivery lag is bounded by the 30-second report expiry, not instantaneous at the exchange boundary.
- After an observed outage, closure or a 30-second gap in observations, the adapter needs 60 seconds of healthy observations. The relay records them every ten seconds. During stale prices, disagreement, closure and recovery, repayment, collateral-only top-ups to existing positions, and debt-free exits remain available.
- `DockyardUSDGCreditVaultV2` starts paused; every added market starts disabled. It preserves the existing borrower and keeper ABI where possible. `secondaryOracle` now means the strict dual-source adapter. `oracleStaleness` remains compatibility metadata, not the risk policy. `borrowingPrice(address)` is the session-aware origination quote; `price(address)` remains the liquidation valuation.
- Candidate exposure: 250 USDG global debt cap including fees, 50 USDG per market, 30% borrow LTV, 40% liquidation LTV, 5% bonus. These are conservative candidate limits, not calibrated loss guarantees. No risk setting has been changed on V1.

Fresh valuation does not create weekend liquidity. Quorum disagreement intentionally suspends liquidations rather than selecting a possibly incorrect price. Price gaps and sale liquidity remain economic risks. The earlier sequencer-uptime and dust-settlement findings are outside this implementation and remain open.

## Relay and operating costs

`DockyardOracleRelay` batches price publication and adapter observations. Anyone may submit a provider-signed report; they cannot select unsigned prices or replace adapters. One failed adapter does not prevent the other adapters from being observed.

The worker uses the existing keeper's SQLite lease, durable signed-transaction journal, nonce reconciliation, bounded fee replacement, gas reserves, RPC checks and alert delivery. API/RPC secrets and raw provider error messages are never logged. Its signer must be distinct from the vault owner and liquidation keeper. No token approval is needed for the relay.

This design publishes continuously while running. **Do not assume the keeper's default gas budget is sufficient.** A full ten-market deployment dry run estimated approximately 0.0205 ETH at the sampled fees. Ongoing publication gas must be measured with authorized live equity reports; set and fund the daily budget before activation. A capped budget will intentionally stop publication when exhausted, and the vault will stop price-sensitive actions when prices expire. A narrower initial market list or a future atomic, on-demand borrower integration can reduce cost. This continuous relay has not been load-tested or operated on Railway.

Worker environment:

- `PYTH_API_KEY`: server-side key entitled to every configured stock.
- `ALCHEMY_RPC_URL`, optional `KEEPER_FALLBACK_RPC_URLS`.
- `ORACLE_MANIFEST_JSON` (or `ORACLE_MANIFEST_PATH` to a mounted file): verified V2 manifest, not the simulation output.
- `ORACLE_RELAY_MODE=observe` by default. `execute` requires equity verification, a dedicated `ORACLE_RELAY_PRIVATE_KEY`, and `ORACLE_ALERT_WEBHOOK_URL`.
- `ORACLE_STATUS_TOKEN`: at least 32 characters. `/status` uses Bearer authentication; `/health` reveals liveness/readiness only.
- `ORACLE_DATA_DIR=/data`: persistent Railway volume, one instance per volume.
- `KEEPER_MAX_TX_FEE_ETH`, `KEEPER_DAILY_GAS_ETH`, `KEEPER_MIN_ETH`: explicitly budget and fund publication. The current defaults are guards, not an operating-cost estimate.

Build the Dockerfile **from the repository root**. It installs the keeper's frozen dependency lockfile and shares its transaction implementation. Install an external watchdog for `/health` and test actual alert delivery before activation; a running process alone does not prove fresh prices.

## Verification and deployment sequence

1. Enable equity access, then run `node services/oracle-relay/src/preflight.mjs` with `PYTH_API_KEY` and `ALCHEMY_RPC_URL` in the environment. It is read-only, resolves exact symbols, verifies the deployed verifier, captures token multipliers, and records the access result. The existing evidence contains a real verified crypto report and an explicit failed equity entitlement check.
2. Review `contracts/utils/assets/dockyard-v2-config.json`. Check each feed's signed session/publisher availability, corporate-action conversion, Chainlink heartbeat and observed disagreement. Remove markets that cannot meet the policy; do not lower validation silently to admit them. Test actual collateral sale liquidity and size the keeper inventory.
3. From `contracts`, run `forge script script/DeployDockyardUSDGCreditVaultV2.s.sol:DeployDockyardUSDGCreditVaultV2` against a local fork or configured read RPC. No `--broadcast` is used for simulation. Candidate output is `utils/assets/test_output/dockyard-v2-candidate.json`, labeled `simulation-only`. Never treat those predicted addresses as deployed contracts.
4. Only after access, economic parameters and operating costs are accepted: deploy the paused, unfunded candidate. Confirm mined receipts and every runtime hash; verify source; mark the manifest as a verified deployment only after reading live state. Verify an authenticated signed equity report through the on-chain verifier and adapters before setting `equityAccessVerified: true`. The script deliberately leaves it false.
5. Provision and fund the dedicated relay, mount persistent storage, configure/test alerts and the external watchdog. Run observe mode, then execution, and verify steady fresh data, closures and recovery. Market enablement rejects an unrecovered oracle.
6. Deploy a keeper for V2 with `KEEPER_VAULT_ADDRESS`, `KEEPER_START_BLOCK`, and its runtime hash. The address and start block must be supplied together; V1 remains the default. Use a separate data volume. Keep monitoring V1 until all its debt is repaid; do not have two services race the same signer nonce.
7. Re-read V1 debt and collateral immediately before migration. Do not transfer borrower positions by assumption. Update frontend address/ABI and use `borrowingPrice` to show session restrictions; update borrower-alert monitoring (currently pinned to V1). Fund and enable only verified markets, perform bounded borrow/repay/liquidation checks, then unpause public origination.

Tests:

```sh
cd contracts
forge test --match-contract '^(DockyardOracleV2Test|DockyardUSDGCreditVaultTest)$' --fuzz-runs 1000 -vv
# Set FOUNDRY_ETH_RPC_URL without placing it in command arguments:
FOUNDRY_FORK_BLOCK_NUMBER=52850604 forge test --match-contract '^DockyardPythForkTest$' -vv
```

```sh
node --test services/oracle-relay/test/*.test.mjs
(cd services/liquidator && node --test test/*.test.mjs)
```

Sources: [API-key onboarding](https://docs.pyth.network/price-feeds/pro/acquire-api-key), [current plans](https://app.pyth.com/plans), [Pyth verifier addresses](https://docs.pyth.network/price-feeds/pro/contract-addresses), [payload semantics](https://docs.pyth.network/price-feeds/pro/payload-reference), [Robinhood token accounting](https://docs.robinhood.com/chain/building-with-stock-tokens/). The older Pyth onboarding text suggesting a free equity trial is contradicted by the account's current entitlement response and billing UI.
