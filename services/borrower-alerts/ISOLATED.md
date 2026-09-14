# Isolated-market borrower alerts

Implemented locally, not deployed. This mode monitors one `DockyardIsolatedCreditEngine` and its bound USDG lender pool. It does not replace the stock-vault alert service. Engine-specific email verification and alert settings are tested locally and connected to the isolated borrowing screen. Real provider delivery remains unverified.

## Configuration and consent

Use a separate service and encrypted SQLite database for each engine. Set `ALERTS_PROTOCOL=isolated` and provide:

- `ALERTS_VAULT_ADDRESS`, `ALERTS_VAULT_CODE_HASH`: the isolated credit engine.
- `ALERTS_POOL_ADDRESS`, `ALERTS_POOL_CODE_HASH`: its lender pool.
- `ALERTS_COLLATERAL_ADDRESS`, `ALERTS_COLLATERAL_CODE_HASH`: the market token.
- `ALERTS_START_BLOCK`: the positive deployment block, before any borrower activity.

The database binds these values and refuses reassignment. Existing stock subscriptions cannot be imported as isolated-market consent. The signature names the engine, chain, wallet and frontend origin; email or private Telegram verification is still required. Each channel records the latest mined block at verification and receives liquidation events only from later blocks. This avoids comparing millisecond consent time with second-resolution chain timestamps. Legacy records without a block anchor retain their timestamp filter.

Provider secrets, database encryption and origin settings follow the main README. The service needs no wallet private key. Do not share a Telegram bot between polling services. Keep stock mode and its existing volume unchanged.

## Monitoring

Each scan checks chain 4663, a fresh head, engine/pool/token runtime hashes, canonical USDG, decimals and contract bindings. It reads collateral, debt including pending interest, the engine's guarded price and its liquidation threshold at one block. The risk calculation uses the contracts' integer floors. Missing pricing means unknown risk, not a healthy loan. Zero debt remains observable without a working price.

Warnings begin at 10% remaining oracle-price decline, become critical at 3%, and become liquidation-eligible when debt exceeds the contract threshold. Alerts cannot predict price gaps or guarantee time to act. A long RPC or event catch-up invalidates the risk snapshot, clears readiness and replaces queued risk messages with unavailable-data warnings.

Liquidation events need 12-block depth and canonical hashes. Catch-up is limited to 1,000 blocks per scan and starts at the deployment block when no cursor exists. Each channel's consent is checked again after asynchronous reads. Confirmations identify the engine, collateral, transaction, repaid USDG and seized token amount using exact decimal formatting. Failed-transaction monitoring accepts only the authenticated wallet's transactions to the engine, pool, collateral or USDG.

## Frontend and deployment checks

Links include `?engine=<address>` on `/borrow` and `/alerts/verify`. At frontend build time, `NEXT_PUBLIC_ISOLATED_ALERTS_JSON` accepts entries with `engine`, `symbol` (one of the ten canonical stock symbols, or the retained CASHCAT/PONS research scopes), and `url` (the service's HTTPS base URL), bounded to 12 entries. Financial market admission still defers CASHCAT/PONS; adding an alert scope cannot enable lending. Only reviewed deployed engines belong in this allowlist. The default is empty; no production engine or service is configured by this change. Duplicate engines, shared service URLs, stock-service overlaps, URL credentials, query strings and fragments are rejected.

The browser checks `/capabilities` for the expected protocol, vault and collateral before transmitting a signature, session token, contact details or email verification token. Requests reject redirects and omit cookies and referrers. Wallet and engine changes clear in-memory authentication; late challenges cannot prompt the previous wallet. Pass `engine` to `BorrowerAlerts` when wiring the isolated borrowing workspace. Stock controls keep their existing default scope.

Email verification retains the engine query while removing the token fragment from the address bar. Unknown, empty or duplicate engine parameters cannot fall back to the stock service. The confirmation form survives React Strict Mode and preserves a failed request's token in memory for a retry. A successful response means verification was accepted and delivery queued, not that an email arrived.

The isolated borrowing screen supports collateral top-ups, partial repayment and full closure. It requires a separate `NEXT_PUBLIC_ISOLATED_MARKETS_JSON` deployment allowlist with reviewed runtime hashes; alert-service configuration alone cannot enable financial controls. An unknown engine still shows an explicit unavailable state instead of opening AAPL stock-vault controls. Before enabling public alerts, verify that each deployed notification link reaches the intended engine and that its protective actions succeed end to end.

Run `pnpm test` here for unit tests. From `services/liquidator`, `pnpm test:isolated-integration` also exercises wallet signatures, verified subscriptions, six position-health states and one deduplicated liquidation notification in each local keeper scenario. It uses a fresh loopback Anvil with mock assets/oracles and a fake email sender. No actual email is sent.

Before release, verify frontend routing, a monitored persistent deployment, inbox delivery, restart recovery, unsubscribe behavior and incident delivery. Passing local tests does not verify production operation or borrower receipt of an email.

## Guarded stock pools

For a stock Earn deployment, use `ALERTS_PROTOCOL=isolated` with the existing
engine, pool, collateral runtime pins and explicit creation block, plus:

```text
ALERTS_ISOLATED_MARKET_KIND=stock
ALERTS_EXECUTION_GATE=<this stock engine's gate>
ALERTS_EXECUTION_GATE_CODE_HASH=<verified runtime hash>
ALERTS_LIVENESS_URL=https://<this engine's monitor>/liveness
```

`ALERTS_PROTOCOL=stock` remains the legacy owner-funded pilot mode; it does not
select public Earn pools. Use a separately bound database and obtain consent for
the new engine. Existing pilot/generic subscriptions cannot silently migrate.

Stock scans verify the gate binding and runtime, fetch an engine-bound fresh
execution certificate, and simulate `priceWithLiveness` at the same block used
for debt and collateral reads. The engine validates its signature and sources.
No transaction or private key is required. Missing/invalid certificates produce
unknown risk, not a healthy fallback; event and transaction receipt processing
continues. Borrowing-session approval is not needed to value liquidation risk.

The local stock worker integration covers warnings and confirmed-liquidation
notifications with actual EVM signatures, but mocks outbound email delivery.
Production enrollment, delivery and watchdog checks remain separate gates.
