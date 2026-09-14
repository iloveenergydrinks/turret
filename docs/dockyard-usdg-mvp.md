# Dockyard USDG MVP

Dockyard's production MVP is an owner-funded USDG credit facility on Robinhood Chain. It does not issue a stablecoin and does not deploy the inherited Liquity contracts.

## Product flow

1. The vault owner supplies canonical USDG.
2. A borrower atomically deposits one supported canonical Robinhood Stock Token and draws USDG up to that market's maximum LTV.
3. If the vault lacks enough USDG, the transaction fails before any collateral or debt remains in the vault.
4. The borrower repays USDG and withdraws the Stock Token.
5. If the position crosses its liquidation LTV, a liquidator repays USDG and receives collateral with the configured bonus.

The ten initial markets are AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, ORCL, MU, and TSLA. They share the vault's available USDG liquidity but retain separate debt ceilings and LTV parameters.

## Canonical dependencies

- Robinhood Chain mainnet: chain ID `4663`
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- Stock Tokens and dual Chainlink feeds: `contracts/src/StockTokens/StockTokenConfig.sol`

The deployment preflight fails if USDG or a Stock Token is missing, a Stock Token is not an 18-decimal token, a canonical oracle is missing, or a Stock Token reports that its oracle is paused.

## Risk controls

- New borrowing starts 500 basis points below the liquidation LTV.
- Each market has an isolated USDG debt ceiling.
- The primary opening flow is atomic: insufficient USDG liquidity reverts the complete deposit-and-borrow transaction.
- Both Chainlink feeds must be fresh; one may provide failover if the other is unavailable.
- If both feeds are live, their prices must agree within 200 basis points.
- The lower valid price is used when both feeds are available.
- Robinhood corporate-action oracle pauses fail closed.
- Global or per-market pauses stop deposits and new borrowing without blocking repayment, collateral withdrawal after repayment, or liquidation.
- Liquidators receive a 500-basis-point collateral bonus.
- The owner can explicitly recognize fully exhausted residual debt as a loss.

This is a centrally funded MVP. It has no public LP shares, interest accrual, governance, redemption mechanism, Stability Pool, leverage, or protocol-issued stablecoin.

## Wallet history

The borrowing page includes read-only wallet history below the position form. It follows the connected account or accepts a public wallet-address lookup. Rows group each market's actions within a transaction, including deposits, borrowing and fees, repayments, withdrawals, liquidations, and bad-debt write-offs. Token approvals, swaps, owner funding, and activity outside this vault are not part of this borrower history.

History reads borrower-indexed events directly from Robinhood Chain RPC, without a subgraph or new API key. Each page scans up to 100,000 blocks in 10,000-block requests; “Load earlier activity” continues back to the verified vault creation block, 52,112,699. Empty recent ranges are not presented as empty lifetime history. Wallet changes cancel obsolete scans, failed pages can be retried, and confirmed transactions refresh the list. Amounts retain on-chain precision. The configured explorer provides transaction details, including network fees.

The history deployment guard currently recognizes chain 4663 and vault `0x576c510e9A268B06448f67598B7BF1ed33388e20`. A replacement deployment requires its verified creation block and vault address to be updated in `frontend/app/src/dockyard-history.ts`.

## Verification

Run the focused unit suite:

```sh
cd contracts
forge test --match-path test/DockyardUSDGCreditVault.t.sol
```

Run the live registry check:

```sh
cd contracts
pnpm validate:stock-registry
```

Dry-run the complete deployment against Robinhood Chain mainnet without broadcasting:

```sh
cd contracts
DEPLOYER_PRIVATE_KEY=1 forge script \
  script/DeployDockyardUSDGCreditVault.s.sol:DeployDockyardUSDGCreditVault \
  --rpc-url https://rpc.mainnet.chain.robinhood.com -vv
```

The dummy key is only for local simulation. Never fund or broadcast from a private key that has appeared in source code, logs, chat, or shell history.

## Production deployment

Use a fresh deployer stored in a secret manager. Fund it with enough ETH on Robinhood Chain for deployment gas and, if desired, canonical USDG for initial liquidity. The latest dry run estimated approximately 0.0038 ETH of gas, but the required balance must be recalculated immediately before broadcast.

Supported environment variables:

- `DEPLOYER_PRIVATE_KEY`: fresh deployer secret.
- `DOCKYARD_OWNER`: owner address; defaults to the deployer.
- `DOCKYARD_ORIGINATION_FEE_BPS`: one-time loan fee, default 50 and maximum 500.
- `DOCKYARD_ORACLE_STALENESS`: maximum feed age in seconds, default one day.
- `DOCKYARD_INITIAL_USDG`: optional whole-USDG amount funded during deployment.

After a successful broadcast, verify the deployed bytecode, review the generated `deployment-dockyard-usdg-mainnet.json`, confirm all ten markets and live oracle prices onchain, make a small owner funding deposit, and execute a capped canary loan before enabling the production UI.
