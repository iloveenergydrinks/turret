# AAPL weekend observation pilot

This production pilot collects evidence for a possible future weekend lending market. It does not change loan admission, oracle valuation, contract addresses, collateral rules, or the existing trading calendar.

## Production

- Service: `dockyard-stock-risk`
- Engine: `0x37DF02D0D721aB8a351333052535B2b7F1262F36`
- Release: `ac7bf03d-2027-4f9a-88bc-4c0b709075af`
- [Public observation status](https://dockyard-stock-risk-production.up.railway.app/weekend/status)
- Detailed observations: `/weekend/observations`, using the service's existing `RISK_STATUS_TOKEN` bearer token.
- Evidence and reproducible release scripts: `output/weekend-pilot/`.

The observer runs once per minute in a separate worker thread. It receives the public manifest, the configured RPC endpoints and a journal directory. It receives no wallet keys, guardian signing capability, status token or notification credentials. A worker failure cannot publish or withdraw borrowing approvals. The parent restarts a failed or stalled worker.

`/weekend/status` contains availability, source freshness and sample counts. It does not expose market prices or detailed order books. The authenticated endpoint returns the latest observation and up to 60 recent samples. Both retain the service's existing origin and method restrictions.

## Evidence collected

The onchain collector verifies the chain, exact engine, pool, token, oracle, executor and factory runtime code hashes, plus the manifest's proxy implementation pins. Reads and simulations use one block, with a final block-hash and age check. If two RPC providers are configured, their block views must agree. The initial release used one provider and explicitly reported `IndependentRpcCorroborationUnavailable`. The September 5 RPC follow-up adds the operator's QuickNode endpoint to the AAPL service alongside Alchemy; current observations use both providers. Risk-monitor fallback traffic is paced at eight requests per second. See `aapl-sunday-readiness.md` for the free-plan credit estimate and scope.

For the actual Robinhood AAPL/USDG pool, it records:

- Spot price, 5-minute and 30-minute TWAPs, liquidity and the most recent pool observation age.
- Collateral decimals, multiplier, oracle pause and corporate-action metadata.
- Canonical stock and USDG oracle values, original timestamps, ages and configured validity limits.
- Simulated full-input sales sized at 10, 50, 100 and 1,000 USDG of pool spot value.

The sale probe replaces only its executor code and synthetic collateral inventory within `eth_call`. Pool liquidity, prices and token transfer behavior remain real. It rejects incomplete input sales. No transaction is broadcast. Output includes pool fees and price impact, excludes gas, and includes a separate value after a 2% haircut. This is not a complete keeper liquidation test or a guaranteed future fill.

Kraken observations use the public AAPLxUSD Depth and Trades endpoints, spaced at least one second apart. Only the exact pair is accepted. The collector validates book ordering, spread, timestamps, positive usable prices, response bounds and request deadlines. Kraken's terminal zero-price bid levels are excluded from usable depth and counted explicitly. Hypothetical Kraken sales use 0.1, 1 and 10 AAPLx token units and exclude trading fees.

Kraken xStocks and Robinhood collateral are different assets. The indicative comparison divides the Robinhood token's USD price by its onchain multiplier once, then compares that share-equivalent value with Kraken's displayed-token price. It is explicitly marked `unitBasisVerified:false` and `forAdmission:false`. Kraken's displayed-token/share basis needs independent confirmation before any oracle use.

## Interpreting status

- `borrowingEnabled:false` and `borrowingEligible:false` are unconditional for the pilot.
- `observationComplete:true` means both sources were collected in time. It does not mean the prices are suitable for lending.
- Kraken trade freshness requires an actual trade younger than 120 seconds. Receiving an unchanged book does not refresh trade time. Valid stale data remains visible with `KrakenStaleTrade`; public freshness is recomputed when read.
- An onchain feed's `fresh` means within the existing contract's maximum age. For AAPL that limit is 86,400 seconds. This must not be read as evidence of fresh weekend stock trading.
- An available TWAP can extrapolate a dormant pool price. The latest pool observation is not necessarily a trade. Neither proves manipulation resistance or sufficient future liquidity.
- Failed sources remain missing with bounded error codes; the other source's evidence is retained. Raw RPC errors and credentials are not published.

## Persistence and recovery

The observer writes its own SQLite journal at `<RISK_DATA_DIR>/weekend-observer/observations.sqlite`. It never writes the keeper or admission journals. Storage is bound to the engine address and retains at most 14 days / 20,160 samples. The authenticated response includes retained sample count, complete sample count and first/last timestamps. Older details can be inspected from this journal by an operator.

On restart, the next successful collection restores the history summary. Failed workers restart after 60 seconds. Workers without a sample for over 180 seconds are terminated by a 30-second watchdog. Public status becomes unavailable when the latest sample is older than 150 seconds or the worker faults. The existing risk service has its own recovery period, unchanged by this pilot.

## Validation

The staged production risk-service regression suite passed 115 tests. The Node 24 container E2E exercised live RPC and Kraken collection, identity verification, all four sale simulations, HTTP access controls, persistence and worker restart. Production verification checks advancing samples, live risk recovery, exact deployed source hashes, unchanged configuration, and the existing `market_closed` approval response.

Tests do not assert a successful weekend loan, because this release deliberately does not enable one. Moving to weekend loans requires a separate oracle-capable market design and evidence covering source outages, stressed sale depth, weekend price changes and reopening gaps.
