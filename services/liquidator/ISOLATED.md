# Isolated-market liquidation worker

Status: implemented and tested locally, **not deployed**. This worker targets `DockyardIsolatedCreditEngine` and its bound lender pool, not the live stock-token vault. Market pricing, security review, deployment approval and production verification remain incomplete.

## Operation

Start with `pnpm start:isolated`. The default is `KEEPER_MODE=observe`; observing never signs a new transaction. The existing Docker image includes this entrypoint: a separate service can override its command to `node src/isolated/main.mjs`. Do not change the stock keeper's start command or volume.

Each instance serves exactly one engine and pool. Use a separate keeper wallet and persistent volume for each instance. Do not reuse a wallet already sending transactions elsewhere: local volume leases do not coordinate nonces across services or external wallets. The signer must not be the engine guardian.

Each scan pins registry, debt, price and balance reads to one block. It enumerates at most 64 active borrowers, rejects duplicates, checks principal and interest reconciliation, and verifies that the block remains canonical. It checks engine/pool/token/oracle runtime hashes and deployment bindings every scan. Contract quotes determine liquidation eligibility, repayment and seizure; the worker does not maintain a separate financial formula.

New-risk pause does not prevent liquidation. Unavailable pricing blocks new liquidations, but known receipts can still be reconciled. Missing USDG or gas, exhausted budgets, inconsistent RPCs, and invalid simulations produce operator incidents. The shared alert sender deduplicates incidents and retries delivery; actual production delivery for this new service has not been tested.

Before sending, the worker rechecks deployment bindings, funding and budgets, obtains a fresh quote and simulates the exact transaction. USDG approval and maximum repayment are capped by available balance and spending limits, rather than the exact debt that can grow before confirmation. Liquidation calldata includes a nonzero minimum collateral amount. Successful receipts must contain exactly one matching engine liquidation event within the authorized repayment and collateral bounds.

Signed intents and nonces are committed to SQLite before broadcast. Timeouts retain the existing intent; replacements preserve its nonce and calldata. Receipt recovery checks canonical blocks and confirmation depth. An unexpected consumed nonce or mismatched receipt blocks new sends for operator review.

## Atomic collateral sale

With `ISOLATED_EXIT_ADDRESS` and `ISOLATED_EXIT_CODE_HASH` configured, the worker calls `DockyardAtomicLiquidator`. In one transaction it pulls capped USDG from the keeper, liquidates, sells seized collateral through two pinned V3 pools, and returns sale proceeds plus unused funding to the keeper. A missing route, partial fill, insufficient collateral or insufficient USDG return reverts the entire transaction, including any loss recognition. The executor clears its engine allowance and leaves no new collateral, intermediate token or USDG residue.

`ISOLATED_MIN_PROFIT_USDG` is a strictly positive, six-decimal USDG return floor, defaulting to 1 USDG. It is **before gas**, not a net-profit guarantee. The worker simulates the complete exit and applies its native fee budget separately. Production profit and gas limits still require review: the local integration explicitly tests gas-budget rejection, then uses a higher test-only gas cap without changing the production default.

If an atomic simulation reverts with `InsufficientReturn`, the worker tries a smaller repayment: half the lesser of the previous cap and quoted repayment. It tries at most four sizes at one pinned block. Each attempt requotes collateral and preserves the USDG profit floor. Oracle, route and transfer errors stop preparation; they do not trigger resizing or inventory retention. Before signing, the worker checks that the preparation block is still canonical and at most 30 chain-seconds behind the latest block. Approval can cover the original bounded cap, but a pending liquidation reserves only its selected cap.

The sizing fork experiment covers roughly 94 to 99,000 USDG loans and eight borrowers sharing a route. At the largest size, full exits failed while quarter-debt exits succeeded. A partial exit leaves debt outstanding: zero recognized loss at that point does not establish solvency. These tests use mock spot references and synthetic local funding, exclude gas from gross margins, and do not establish safe production limits.

The repeated-exit fork suite follows roughly 98,000 USDG loans beyond that first partial sale, with a 1 USDG gross return floor. When the mock references track each sale, the half-price cases become healthy after one partial liquidation; the quarter-price cases exhaust collateral after two liquidations and recognize about 42,321 USDG (CASHCAT) and 43,884 USDG (PONS) of lender losses. When the references remain at their first post-shock price, subsequent exits fail and roughly 69,259/70,319 USDG of unhealthy debt remains. Lender withdrawals stay blocked in those cases. Separate voluntary borrower repayments then test oracle-outage closure and cash withdrawal; those repayments are not keeper recovery. See `contracts/utils/isolated-repeated-observations.json` for exact values and assumptions.

### Liquity reference

The oracle research takes inspiration from [Liquity's independent confirmation of large price moves](https://www.liquity.org/blog/price-oracles-in-liquity). Our corroborated-gap adapter is conditional on a fresh independent reference; matching two reads from the same market does not provide that independence. We do not copy Liquity V1's last-good-price fallback for new risk when both feeds fail.

The local Liquity `TroveManager` offsets debt against its Stability Pool and redistributes residual debt and collateral. Our USDG pool has a different obligation: lenders supply existing USDG, borrowers pay interest, and collateral shortfalls can reduce lender assets. This keeper repays debt with separately funded USDG and attempts an atomic collateral sale. It does not mint or burn USDG, provide Liquity redemptions, or implement fixed-term P2P offers. A Stability Pool-style collateral-taking backstop would need separately committed capital and explicit loss/withdrawal rules; it is not supplied by this worker.

The pending transaction reserves its maximum repayment against inventory and daily limits. Inventory cost is released only after a canonical, sufficiently confirmed receipt contains matching engine and executor events, including USDG return and profit. Daily repayment volume and actual gas remain charged. Missing, duplicate or contradictory events block reconciliation rather than releasing budget. Deadlines remain unchanged during same-nonce replacement; a late transaction can revert and spend gas.

The executor has no owner withdrawal or arbitrary-recipient function. **Do not fund it directly:** only the current caller's execution deltas are returned; pre-existing token donations remain untouched. Keep capital in the dedicated keeper wallet and approve the bounded amount.

Without an atomic executor, the optional `ISOLATED_ALLOW_RETAINED_COLLATERAL=true` mode still retains seized tokens in the keeper wallet. Its inventory cost does not reset after an unverified external sale or transfer. There is no automatic fallback from a failed atomic sale to retention. If neither mode is configured, observation continues without new liquidation transactions.

The atomic path is locally tested and has executed real-token sales on a pinned fork, but no production executor or isolated keeper has been deployed. Market manipulation resistance, larger exit sizes, oracle-gap liquidation liveness, MEV, full transaction fees and service operation still need validation. Do not advertise guaranteed liquidation coverage or profit.

## Configuration

All deployment addresses and runtime hashes are mandatory even in observe mode:

- `ISOLATED_ENGINE_ADDRESS`, `ISOLATED_ENGINE_CODE_HASH`
- `ISOLATED_POOL_ADDRESS`, `ISOLATED_POOL_CODE_HASH`
- `ISOLATED_COLLATERAL_ADDRESS`, `ISOLATED_COLLATERAL_CODE_HASH`
- `ISOLATED_PRIMARY_ORACLE`, `ISOLATED_PRIMARY_CODE_HASH`
- `ISOLATED_SECONDARY_ORACLE`, `ISOLATED_SECONDARY_CODE_HASH`

For atomic sale, also supply the paired `ISOLATED_EXIT_ADDRESS` and `ISOLATED_EXIT_CODE_HASH`. The worker verifies its engine, collateral, USDG and route bindings. Executor selection is part of the persistent state identity; do not repoint an existing volume while it contains pending transactions.

The production chain is 4663 and USDG is the canonical address in the existing configuration. There is no fallback to the stock vault. Distinct oracle addresses and bytecode checks do not prove independent price sources; that is a separate release requirement.

Other settings use the shared keeper configuration:

- `ALCHEMY_RPC_URL` or `KEEPER_RPC_URL`; optional `KEEPER_FALLBACK_RPC_URLS`.
- `KEEPER_MODE=observe` initially. Execute mode requires `KEEPER_PRIVATE_KEY` for a dedicated, funded wallet.
- `KEEPER_DATA_DIR` on a private persistent volume; never reuse another keeper's volume.
- `KEEPER_STATUS_TOKEN` of at least 32 characters in production. `/status`, `/metrics` and `/readyz` require bearer authentication. `/healthz` is liveness only.
- `KEEPER_ALERT_WEBHOOK_URL`, with an operator-confirmed delivery test before release.
- `KEEPER_MAX_REPAY_USDG`, `KEEPER_DAILY_BUDGET_USDG`, `KEEPER_INVENTORY_BUDGET_USDG`, `KEEPER_MIN_USDG`, `KEEPER_MIN_ETH`, `KEEPER_MAX_TX_FEE_ETH`, and `KEEPER_DAILY_GAS_ETH` need reviewed values.
- `ISOLATED_COLLATERAL_SLIPPAGE_BPS` defaults to 100, bounded to 0–500. This limits quoted collateral deterioration, not DEX sale slippage or profitability.

The engine always sends collateral to the caller; `KEEPER_COLLATERAL_RECIPIENT` is rejected. Supply credentials through the service's secret environment, not committed files, command lines or logs.

## Verification

From `services/liquidator`, run `pnpm test` for shared and isolated unit tests. The existing stock-vault receipt behavior remains covered after extracting an overridable event decoder.

For the local EVM integration, first compile the research contracts and mock artifacts from `contracts/`:

```sh
forge test --skip script --match-path 'test/research/*.t.sol' --fuzz-runs 1024
```

Then run `pnpm test:isolated-integration` from `services/liquidator`. It launches its own loopback Anvil with ephemeral wallets, mock USDG/collateral and mock oracles. Both retained-collateral and atomic-sale cases test healthy and unavailable pricing, unfunded liquidation, bounded approval, restart recovery, actual signed liquidation, and recovery of the borrower's remaining collateral. The atomic case verifies gas-budget rejection, USDG recycling and receipt-backed inventory release. It requires no production key or RPC. Its temporary SQLite directory is deleted after the test; no production balances or services change.

A third, adaptive case uses a test pool with a deliberately size-dependent return penalty. The real worker decodes the failed full-sale simulation, selects a smaller cap, signs and confirms the transaction, and releases the exact inventory reserve. A second restart verifies that it does not liquidate the remaining healthy debt. The borrower closes that debt separately. This tests keeper integration, not actual V3 price-impact behavior; the real-pool fork suites cover that separately.

The same local scenarios exercise the isolated borrower alert service: wallet signatures, verified email consent, six health states, 12-block confirmation and one deduplicated liquidation notification. USDG is a mock installed at the canonical address only on the freshly spawned loopback Anvil. Email goes to a fake sender, not Resend. The test imports the sibling borrower-alerts service and requires its dependencies installed.

The Node integration uses mock swap pools; real PONS/CASHCAT atomic exits are tested separately in `contracts/test/fork/DockyardIsolatedMarketsFork.t.sol`. Neither verifies production oracle safety, actual alert delivery, sequencer outages or production keeper profitability. Those remain separate release checks.

### Real-pool worker integration

`pnpm test:isolated-real-pools` runs the actual worker against PONS/CASHCAT tokens and V3 pools on a pinned Robinhood fork. It requires `ISOLATED_FORK_RPC_URL` and `ISOLATED_FORK_BLOCK` in the environment; missing configuration fails instead of skipping. First build the test-only helper from `contracts/`:

```sh
forge build test/fork/DockyardForkSwapHarness.sol --skip script --quiet
```

The suite creates a fresh loopback Anvil per case, with ephemeral owner, borrower and keeper wallets. A local proxy forwards only allowlisted upstream reads and removes upstream error details. Anvil receives the proxy's loopback URL, not the credential-bearing provider URL. No production key is used, and the proxy rejects broadcasts and state changes.

Setup acquires USDG and collateral through real pools, opens a loan, and drives a price drop with synthetic whale inventory. The balance override targets a storage slot identified from the local token's actual balance read; assertions check the resulting balance, unchanged pool balance and unchanged total supply before the sale. Setup transactions use a fixed five-million-gas ceiling after simulation because automatic setup estimates were unreliable on this fork. The worker retains its normal estimator, gas buffer and fee checks; its test-only maximum fee and spending caps are not approved production parameters.

The two price-drop cases per token cover unfunded detection, approval, smaller repayment selection, actual signed sales, restart between transactions, receipt matching, USDG recycling, remaining healthy debt or recognized loss, and withdrawal after debt settlement. Voluntary repayment is recorded separately. Oracles are mock references refreshed from pool spot prices, not authenticated independent reports. Fork gas charges are not a complete Robinhood production fee model. This suite does not establish safe launch limits or production readiness.

All four cases passed at fork block 52855086. Moderate crashes left healthy debt after one partial liquidation; severe crashes settled after two liquidations and recognized lender losses. Exact observations are in `contracts/utils/isolated-real-worker-observations.json`. The earlier failed setup runs are not counted as completed tests; changing the fixture's setup gas limit did not alter the keeper or protocol contracts.
