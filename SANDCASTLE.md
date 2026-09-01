# rUSD Stock Token Sandcastle

This branch is a non-production Liquity V2 fork for borrowing `rUSD` against Stock Token collateral on Robinhood Chain.

## Product boundary

The first version uses ten isolated collateral branches sharing one stablecoin:

| Branch | Initial maximum LTV | Branch debt ceiling |
| ------ | ------------------: | ------------------: |
| AAPL   |               57.1% |              $15.0m |
| MSFT   |               57.1% |              $15.0m |
| GOOGL  |               55.6% |              $12.5m |
| AMZN   |               54.1% |              $10.0m |
| META   |               52.6% |              $10.0m |
| NVDA   |               50.0% |              $10.0m |
| AMD    |               50.0% |               $7.5m |
| ORCL   |               50.0% |               $7.5m |
| MU     |               44.4% |               $5.0m |
| TSLA   |               40.0% |               $5.0m |

Each position contains one collateral. A portfolio vault containing a basket such as SPY, AAPL, and ETH is not implemented; it requires a separate risk engine and liquidation design.

The code and product are independent and must not be presented as an official Robinhood product. Stock Tokens are issuer obligations that provide economic exposure; they are not the underlying shares.

## Safety model

- Every branch has a hard debt ceiling enforced on opening and debt increases.
- The Stock Token/USD adapter checks the token's corporate-action pause flag, positive answers, timestamp freshness, round completeness, sequencer health, and maximum single-update deviation. Both reviewed Chainlink endpoints must be healthy at deployment; if the primary later fails, the adapter uses the secondary endpoint and emits a monitoring event. A branch shuts down for malformed oracle data only when neither endpoint remains usable.
- Expected liveness interruptions (corporate-action pause, stale market feed, sequencer outage, or transient oracle-call failure) temporarily reject price-dependent actions and recover automatically. Malformed data permanently shuts down only the affected branch and freezes its last good price for urgent redemptions.
- Purely risk-reducing adjustments remain available during temporary oracle outages: borrowers may add collateral, repay rUSD, or do both. Borrowing, collateral withdrawal, and mixed adjustments that can reduce collateralization still require a live price.
- A price move above the branch deviation cutoff temporarily freezes the branch. Anyone can stage the candidate; after 30 minutes, a later fresh oracle round must corroborate it within 5% before it becomes the new live price. Same-round or materially drifting candidates cannot bypass or preserve the timer. These test-only values still require historical simulation and independent review.
- Stability Pool collateral and yield gains remain claimable across every scale transition supported by compounded deposits. This closes an accounting gap where a near-total offset could cross three scales while gain getters inspected only two.
- Robinhood's onchain feeds already include the ERC-8056 corporate-action multiplier; the adapter does not apply it again.
- The sandcastle deployer uses faucet collateral tokens and operator-updatable mock feeds. It accepts only Anvil (`31337`) and Robinhood Chain testnet (`46630`), so it cannot deploy to mainnet.
- Leverage and collateral-to-rUSD swaps are deliberately disabled in the sandcastle. Basic borrow, repay, collateral adjustment, liquidation, Stability Pool, and redemption mechanics remain available.

The ratios and ceilings are placeholders for simulation, not production risk parameters.

The one-hour oracle staleness threshold and five-minute sequencer grace period are test-only. Keeping the grace period below the staleness window ensures a new testnet deployment becomes usable before its mock price rounds expire. Stock Token feeds operate 24/5 and may hold their last price without heartbeats during weekends, holidays, thin overnight sessions, and corporate-action pauses. Staleness now causes temporary unavailability rather than irreversible shutdown, allowing the branch to recover when a fresh price arrives. Production still requires historical and Monte Carlo testing of this freeze policy. The secondary Chainlink endpoint improves availability but is not an independent price methodology; Data Streams or another independently reviewed path is still required before safe off-hours liquidations can be enabled. See the [Robinhood Chain oracle documentation](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Robinhood Chain Data Streams documentation](https://docs.robinhood.com/chain/data-streams/), and [Chainlink's Robinhood feed guidance](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

## Executable gap model

`StockTokenRiskModel.t.sol` models a position starting exactly at MCR and measures the largest one-step price gap for which its collateral still covers the debt plus the 10% redistribution penalty. These deterministic checks are a screening tool, not a substitute for historical and Monte Carlo simulation.

| Branch | Maximum LTV | Gap before penalty shortfall | Oracle deviation cutoff |
| ------ | ----------: | ---------------------------: | ----------------------: |
| AAPL   |      57.14% |                       37.14% |                  15.00% |
| MSFT   |      57.14% |                       37.14% |                  15.00% |
| GOOGL  |      55.55% |                       38.88% |                  15.00% |
| AMZN   |      54.05% |                       40.54% |                  17.50% |
| META   |      52.63% |                       42.10% |                  17.50% |
| NVDA   |      50.00% |                       45.00% |                  20.00% |
| AMD    |      50.00% |                       45.00% |                  20.00% |
| ORCL   |      50.00% |                       45.00% |                  20.00% |
| MU     |      44.44% |                       51.11% |                  25.00% |
| TSLA   |      40.00% |                       56.00% |                  25.00% |

The model exposes a deliberate risk tradeoff: all ten branches still cover the 10% redistribution penalty after a 30% gap, but a single 30% oracle update exceeds every configured deviation cutoff. The delayed two-round confirmation path prevents permanent shutdown while blocking normal liquidation until the move is corroborated by a later round from the same endpoint. Production still needs historical testing and an independent price path such as Chainlink Data Streams; sequential rounds or two endpoints from the same provider are not independent confirmation.

`StockTokenLiquidationSimulation.t.sol` connects the production-shaped dual-endpoint adapter to a complete Liquity branch configured with NVDA-style 200% MCR and 230% CCR parameters. It verifies that an unconfirmed 25% gap cannot liquidate, that a later corroborating round can liquidate through the Stability Pool, and that the secondary endpoint can drive a liquidation at the exact 20% circuit-breaker boundary when the primary is unavailable. Corporate-action pauses and stale market closures are also exercised end to end: liquidation and collateral withdrawal remain blocked, collateral top-ups and debt repayment remain available, and fresh primary or secondary data restores liquidation without permanently shutting the branch down. This closes the deterministic integration scenarios only; it is not the required historical, Monte Carlo, or live-testnet soak evidence.

The seeded synthetic runner reads all MCR and deviation cutoffs directly from `StockTokenConfig.sol` and evaluates a one-session return distribution for every branch. For price moves blocked by the circuit breaker, it follows up to eight consecutive 30-minute confirmation windows, restaging materially drifting candidates the way a keeper would. It reports recoveries, paths requiring one or more timer restarts, unresolved four-hour freezes, average windows to resolution, and penalty shortfalls while liquidation is unavailable:

```sh
pnpm --dir contracts test:stock-risk
pnpm --dir contracts simulate:stock-risk
```

Its volatility, jump, buffer, penalty, seed, and trial assumptions live in `contracts/utils/stock-risk-scenario.sandcastle.json`, separate from the engine. The runner reports raw occurrence counts as well as rates so rare penalty shortfalls are not rounded away. These assumptions are intentionally labeled synthetic and unreviewed; the output is a reproducible screening baseline, not a production parameter recommendation or a substitute for sourced historical data.

The historical analyzer accepts a provenance manifest plus one checksummed CSV per configured stock. It rejects synthetic datasets by default, requires a concrete license and HTTPS source, verifies every SHA-256 digest, and measures session gaps, continuous 30-minute losses, circuit-breaker events, closure duration, and liquidation-penalty shortfalls against the Solidity parameters:

```sh
pnpm --dir contracts analyze:stock-history -- /absolute/path/to/provenance.json
```

Each CSV must use the exact header `timestamp,session,open,high,low,close` and the manifest must cover all ten symbols. Licensed historical data is deliberately not committed to this repository; until a sourced dataset is supplied and the report is independently reviewed, the historical-data production gate remains open.

## Local deployment

Prerequisites: Foundry and the repository submodules.

```sh
cd contracts
anvil --disable-code-size-limit
export DEPLOYER_PRIVATE_KEY=<anvil-development-key>
forge script script/DeployStockTokenSandcastle.s.sol:DeployStockTokenSandcastle \
  --rpc-url http://127.0.0.1:8545 \
  --broadcast \
  --slow \
  --disable-code-size-limit
```

The script writes `contracts/deployment-stock-sandcastle.json`. The arrays use this fixed order: AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, ORCL, MU, TSLA.

Before any deployment that uses live Robinhood collateral and Chainlink feeds, run:

```sh
pnpm --dir contracts validate:stock-registry
```

The preflight fails closed if any token is inactive, has a pending multiplier change, has moved addresses, lacks a primary/secondary feed, or if the live feed metadata has drifted from the reviewed 24-hour heartbeat, 0.5% threshold, and 8-decimal configuration. A passing preflight is necessary but not sufficient for production deployment.

Generate the contract portion of the frontend environment from that manifest:

```sh
cd contracts
pnpm tsx utils/deployment-manifest-to-app-env.ts \
  deployment-stock-sandcastle.json ../frontend/app/.env.sandcastle.local
```

This unverified conversion remains read-only. After a broadcast succeeds, verify
the deployed bytecode, ownership renunciation, stablecoin identity, all ten
branch registries, and initial prices before enabling wallet and borrowing flows:

```sh
cd contracts
pnpm verify:stock-deployment \
  deployment-stock-sandcastle.json ../frontend/app/.env.sandcastle.local \
  --verify-rpc "$RH_TESTNET_RPC_URL"
```

Only the verified command emits `NEXT_PUBLIC_DEPLOYMENT_VERIFIED=true`. The
frontend fails closed without it, even when a simulated manifest contains
plausible nonzero addresses.

Then add the chain RPC, block explorer, native currency, multicall address, subgraph URL, and WalletConnect project ID for the target network. The generated configuration disables leverage, governance staking, legacy checks, and the inherited sBOLD/yBOLD pools. It never contains a deployer key.

Build the ten-branch subgraph configuration without publishing it:

```sh
cd subgraph
./deploy-subgraph stock-sandcastle --build-only
```

The manifest records the deployment start block so the indexer does not scan the chain from genesis. Publishing requires a Graph Node configured with the Robinhood network plus explicit `--graph-node` and `--ipfs-node` endpoints.

## Robinhood Chain testnet

Fund a dedicated throwaway deployer with testnet ETH, keep its key outside the repository, and run:

```sh
cd contracts
export DEPLOYER_PRIVATE_KEY=<dedicated-testnet-key>
export RH_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
forge script script/DeployStockTokenSandcastle.s.sol:DeployStockTokenSandcastle \
  --rpc-url "$RH_TESTNET_RPC_URL" \
  --broadcast \
  --slow
```

The public RPC is rate-limited. Use a dedicated provider endpoint for repeated deployments. A deployment requires hundreds of millions of aggregate gas across many transactions, so confirm the deployer balance first and retain the broadcast journal for resumption and verification.

## Tests

```sh
cd contracts
forge build
forge test
forge test --match-path 'test/StockToken*.t.sol'
forge test --match-path test/BranchDebtCeiling.t.sol
```

## Production deployment

`DeployStockTokenProduction.s.sol` is the mainnet-only deployment path. It
accepts only Robinhood Chain ID 4663, canonical live Stock Tokens and reviewed
Chainlink feeds, and requires an explicit production-license confirmation. A
typical broadcast is:

```sh
cd contracts
export RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com
export LIQUITY_PRODUCTION_LICENSE_CONFIRMED=true
export ACKNOWLEDGE_NO_SEQUENCER_UPTIME_FEED=true
forge script script/DeployStockTokenProduction.s.sol:DeployStockTokenProduction \
  --rpc-url "$RH_RPC_URL" \
  --broadcast \
  --slow
pnpm verify:stock-deployment \
  deployment-stock-robinhood-mainnet.json ../frontend/app/.env.production.local \
  --verify-rpc "$RH_RPC_URL"
```

The private key must be supplied through `DEPLOYER_PRIVATE_KEY` at runtime and
must never be committed. The public RPC is suitable for verification but a
dedicated provider endpoint is recommended for broadcasting.

## Production gates

Production proceeds only after all of these are complete:

1. Liquity production-use licensing or friendly-fork permission is documented.
2. Canonical token and Chainlink feed addresses are re-read from Robinhood immediately before deployment.
3. A market-session policy defines borrowing, liquidation, redemption, and recovery behavior during overnight sessions, weekends, holidays, halts, and corporate-action pauses.
4. Stock-market closure, gap, halt, corporate-action, sequencer, stablecoin-depeg, and liquidation-liquidity simulations pass.
5. Parameters, access control, monitoring, and emergency procedures receive independent review.
6. Contracts receive an external audit and a public testnet soak period.
7. A new dedicated deployer is used. No development key or key exposed in logs,
   chat, or source control is reused.

Do not enable production merely because the sandcastle tests pass.
