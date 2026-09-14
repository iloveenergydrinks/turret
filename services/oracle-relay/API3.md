# Stock USDG API3 service

Candidate implementation. Not deployed or approved for public-capital activation.
CASHCAT and PONS remain deferred. This service updates USDG/USD beacons; it
does not supply the Stock Token price or replace the stock risk monitor.

Run from `services/oracle-relay`:

```sh
npm run start:stock-api3
```

Required configuration:

- `API3_ORACLE_MANIFEST_JSON`, or `API3_ORACLE_MANIFEST_PATH` to a mounted file.
  The manifest has `kind: "stock-api3-usdg"`, `chainId: 4663`, a decimal-string
  `startBlock`, `publication` containing `adapter` and `adapterCodeHash`, and
  distinct `relayAddress`, `guardian` and `keeper` addresses. Use verified
  deployment values, not addresses predicted by a dry run.
- `ORACLE_RPC_URL`, optionally `ORACLE_FALLBACK_RPC_URLS` for RPC failover and
  shared-block comparison. One available RPC is not proof of quorum.
- `ORACLE_STATUS_TOKEN`: at least 32 characters; required for `/status`.
- `ORACLE_DATA_DIR`: a dedicated persistent volume. Never share the keeper's
  journal or run two instances on one volume.

The default `ORACLE_RELAY_MODE=observe` loads no signing key and never submits
updates. API3 public signed-price access requires no provider API key in this
implementation. Do not configure a Pyth or Chainlink credential for this service.

Execution additionally requires `ORACLE_RELAY_MODE=execute`, its own
`ORACLE_RELAY_PRIVATE_KEY` matching the manifest's relay address, and manifest
fields `executionApproved: true` and `reviewDigest`. Those fields record an
operator decision, not proof of a security review. The relay address must be
different from the guardian and liquidation keeper. Never paste secrets into
the manifest, frontend environment, repository or terminal output.

Configure either an HTTPS `ORACLE_ALERT_WEBHOOK_URL` or all three email fields:
`RESEND_API_KEY`, `ORACLE_ALERT_EMAIL_FROM`, `ORACLE_ALERT_EMAIL_TO`. These are
operator notices, not borrower subscriptions. Execute mode refuses a missing
destination; readiness requires successful transport checks and delivery.

Set and fund `ORACLE_MIN_ETH`, `ORACLE_MAX_TX_FEE_ETH` and
`ORACLE_DAILY_GAS_ETH` from measured publication costs. The inherited defaults
are ceilings/reserves, not a promise that they fund continuous operation.
`ORACLE_POLL_MS` defaults to 5000 and accepts 1000–10000. Confirmation depth
defaults to two blocks and cannot be less than two. RPC polling, price freshness
and gas budgets can each stop publication independently.

Endpoints:

- `/health`: liveness only; a live process can still be unready.
- `/ready`: execute mode, valid confirmed and latest cache state, verified
  alert delivery and no critical incident. Returns 503 otherwise.
- `/status`: Bearer-protected snapshot, including cache expiry and incidents.

Expired or superseded pending updates can be cancelled with a zero-value,
empty-data transaction to the relay's own address at the same nonce. The
journal retains the original and cancellation hashes, reconciles either mined
outcome and waits for confirmation depth. Cancellation has a 150,000 gas-unit
ceiling and at most `maxReplacements + 1` attempts, subject to the configured
per-transaction and daily gas limits. Retries cannot transfer funds or call a
contract. The relay refuses cancellation if its account has code, the chain
disagrees, the head is stale or its nonce cannot be reconciled.

Cancellation recovery runs before fetching provider reports, so a provider
outage does not by itself strand the nonce. Execute mode, verified operator
alert transport and the ETH reserve are still required. Clearing a nonce does
not make stale prices usable or make the service ready.

## Independent watchdog

Run `npm run watchdog:stock-api3` from a separately scheduled process or host.
The job checks the relay once and exits zero only when the expected stock
oracle is healthy and watchdog notification delivery has been verified. Keep
its scheduler and volume independent of the relay so a dead relay cannot stop
its own outage notification.

Configure:

- `API3_ORACLE_STATUS_URL`: the relay's HTTPS `/status` endpoint. Plain HTTP is
  accepted only for loopback tests. Redirects and credentials in URLs are refused.
- `API3_ORACLE_EXPECTED_IDENTITY_HASH`: the reviewed relay deployment identity,
  computed by `api3ConfigFromEnv`. Do not discover and automatically trust a new
  identity from the endpoint being monitored.
- `ORACLE_STATUS_TOKEN`: the matching status credential.
- `ORACLE_WATCHDOG_DATA_DIR`: a separate persistent volume for deduplication
  and delivery retries. The relay's volume and other watchdog roles cannot be reused.
- `WATCHDOG_ALERT_WEBHOOK_URL`, or `RESEND_API_KEY` with `WATCHDOG_EMAIL_FROM`
  and `WATCHDOG_EMAIL_TO`.

The watchdog needs no wallet key, RPC credential or price-provider key. It
rejects a different oracle kind, stale process state, unusable confirmed or
latest cache, critical incidents and failed operator delivery. Its own failed
notifications retry; an unchanged outage still exits nonzero even when the
notification is deduplicated. Recovery remains unhealthy until its notification
is delivered. Neither this watchdog nor its scheduler automatically pauses a
market on-chain; they are monitoring, not an execution authority.

The relay and watchdog pass a separate-process test against the native API3
server on a disposable Robinhood fork, including provider/email outages,
restart and forced relay death. Actual email delivery and production scheduling
are not established. Do not enable unattended execution yet: source
qualification, the second USDG source and stock pool commissioning also remain
separate gates.

The native server's metadata mismatch is resolved by [independent compilation
and complete runtime reproduction](../../docs/security/stock-api3-source-verification-2026-09-03.md).
That verifies the contract source, not provider independence or feed-data rights.

Tests:

```sh
npm test
npm run test:stock-api3-integration
```

The fork test requires compiled contract artifacts and `anvil` on PATH. Supply
`API3_TEST_FORK_RPC_URL` privately when the public RPC lacks historical state.
It uses a read-only upstream proxy and generated local signers; all transactions
are confined to the disposable fork. The process test uses a loopback RPC.

[Implementation and evidence](../../docs/security/stock-api3-adapter-2026-09-03.md)
separates tested behavior from the remaining production requirements.
