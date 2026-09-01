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
| AVGO   |               50.0% |               $7.5m |
| LLY    |               50.0% |               $7.5m |
| MU     |               44.4% |               $5.0m |
| TSLA   |               40.0% |               $5.0m |

Each position contains one collateral. A portfolio vault containing a basket such as SPY, AAPL, and ETH is not implemented; it requires a separate risk engine and liquidation design.

The code and product are independent and must not be presented as an official Robinhood product. Stock Tokens are issuer obligations that provide economic exposure; they are not the underlying shares.

## Safety model

- Every branch has a hard debt ceiling enforced on opening and debt increases.
- The Stock Token/USD adapter checks the token's corporate-action pause flag, positive answers, timestamp freshness, round completeness, sequencer health, and maximum single-update deviation.
- Expected liveness interruptions (corporate-action pause, stale market feed, sequencer outage, or transient oracle-call failure) temporarily reject price-dependent actions and recover automatically. Malformed data or an excessive unconfirmed update permanently shuts down only the affected branch and freezes its last good price for urgent redemptions.
- Robinhood's onchain feeds already include the ERC-8056 corporate-action multiplier; the adapter does not apply it again.
- The sandcastle deployer uses faucet collateral tokens and operator-updatable mock feeds. It accepts only Anvil (`31337`) and Robinhood Chain testnet (`46630`), so it cannot deploy to mainnet.
- Leverage and collateral-to-rUSD swaps are deliberately disabled in the sandcastle. Basic borrow, repay, collateral adjustment, liquidation, Stability Pool, and redemption mechanics remain available.

The ratios and ceilings are placeholders for simulation, not production risk parameters.

The one-hour oracle staleness threshold is test-only. Stock Token feeds operate 24/5 and may hold their last price without heartbeats during weekends, holidays, thin overnight sessions, and corporate-action pauses. Staleness now causes temporary unavailability rather than irreversible shutdown, allowing the branch to recover when a fresh price arrives. Production still requires historical and Monte Carlo testing of this freeze policy, and a Data Streams or secondary-price path before safe off-hours liquidations can be enabled. See the [Robinhood Chain oracle documentation](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Robinhood Chain Data Streams documentation](https://docs.robinhood.com/chain/data-streams/), and [Chainlink's Robinhood feed guidance](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

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
| AVGO   |      50.00% |                       45.00% |                  20.00% |
| LLY    |      50.00% |                       45.00% |                  20.00% |
| MU     |      44.44% |                       51.11% |                  25.00% |
| TSLA   |      40.00% |                       56.00% |                  25.00% |

The model exposes a deliberate unresolved conflict: all ten branches still cover the 10% redistribution penalty after a 30% gap, but a single 30% oracle update exceeds every configured deviation cutoff and currently causes permanent shutdown before normal liquidation can use the new price. A production design needs an independently validated secondary price or an explicitly reviewed gap-handling mechanism; the cutoff must not simply be removed.

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

The script writes `contracts/deployment-stock-sandcastle.json`. The arrays use this fixed order: AAPL, MSFT, GOOGL, AMZN, META, NVDA, AVGO, LLY, MU, TSLA.

Generate the contract portion of the frontend environment from that manifest:

```sh
cd contracts
pnpm tsx utils/deployment-manifest-to-app-env.ts \
  deployment-stock-sandcastle.json ../frontend/app/.env.sandcastle.local
```

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

## Production gates

There is intentionally no mainnet deployment script. Production work starts only after all of these are complete:

1. Liquity production-use licensing or friendly-fork permission is documented.
2. Canonical token and Chainlink feed addresses are re-read from Robinhood immediately before deployment.
3. A market-session policy defines borrowing, liquidation, redemption, and recovery behavior during overnight sessions, weekends, holidays, halts, and corporate-action pauses.
4. Stock-market closure, gap, halt, corporate-action, sequencer, stablecoin-depeg, and liquidation-liquidity simulations pass.
5. Parameters, access control, monitoring, and emergency procedures receive independent review.
6. Contracts receive an external audit and a public testnet soak period.
7. A new hardware-backed multisig deployer is used. No development key is reused.

Do not enable production merely because the sandcastle tests pass.
