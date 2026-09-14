# Borrower cashback service

The checked-in frontend points to the funded public campaign described below. This service never deploys a contract, enrolls a borrower, publishes a root or signs a transaction by itself.

Run `pnpm install --frozen-lockfile`, then `pnpm start` from this directory. With no `CASHBACK_CONFIG`, the API reports an inactive campaign and needs no RPC or signer. Use Node 24 or later.

For a funded campaign, supply `CASHBACK_CONFIG` as the path to a reviewed JSON configuration and mount persistent storage at `CASHBACK_DATA_DIR` (default `./data`). The directory contains the SQLite ledger and immutable allocation archives. Back up both together; keep the archives through the claim deadline. Set `PORT` and optionally `CASHBACK_POLL_MS` (default 10000).

Configuration fields are `chainId`, `rpcUrl` (or the `CASHBACK_RPC_URL` environment variable), `distributor`, `rewardToken`, `runtimeHash`, `startBlock`, `confirmations` and `policy`. The policy contains `startsAt`, `endsAt`, `settlementDeadline`, `claimDeadline`, `rebateBps: 5000` and an `engines` object keyed by engine address. Each engine entry contains `aprBps`, `pool`, `runtimeHash` and `poolRuntimeHash`. Times are Unix seconds; caps and reward amounts use six-decimal USDG integers. Runtime hashes must match the reviewed deployed bytecode, including constructor immutables.

The start block must include the deployment of every eligible engine and the campaign. Starting from current balances cannot reconstruct campaign-eligible principal or old unpaid interest. Configuration and history cannot be silently changed on an existing ledger. Startup checks chain ID, code hashes, engine/pool binding, USDG decimals, APR, accounting version and campaign dates. Use a reviewed chain-specific confirmation depth; zero confirmations are accepted only for local chain ID 31337.

Endpoints:

- `GET /healthz`: readiness, replay state and last successful synchronization time.
- `GET /v1/campaign`: verified campaign configuration and funded commitments.
- `GET /v1/rewards/<wallet>`: estimated, confirmed, claimable and claimed amounts, plus published proofs.

The website proxy uses `BORROWER_CASHBACK_URL`; it forwards only these reward reads and strips browser credentials. The service has no HTTP enrollment, funding or publication endpoints.

Before publication, review eligibility and receipts. With `CASHBACK_CONFIG` and `CASHBACK_DATA_DIR` set to the running service’s configuration and volume, run `pnpm prepare-publication`. The command requires the confirmed canonical head, verifies enrolled caps, archives cumulative proofs durably and prints an unsigned publication transaction. Review the archive, root, checkpoint and configured operator before signing. It never loads a signing key or broadcasts a transaction. Submit the reviewed root using the configured contract operator. Indexing the `Published` receipt protects its accounting range from automatic reorganization rollback. A reorganization affecting published entitlements stops automatic correction; older contract claims remain valid. Pausing enrollment does not pause claims or the lending contracts.

For Railway, build from the repository root using `services/borrower-cashback/Dockerfile`, mount a volume at `/data`, and use `/healthz` as the health endpoint. Deploy an active frontend manifest only after the contract is funded and published terms contain the actual dates and limits. Public participants reserve their own caps through `join()`; no operator invitation is required.

Validation: `node --test test/*.test.mjs`. The local-chain test compiles the production loan contracts, creates a private Anvil process, runs borrowing/repayment/claim/liquidation, checks fee routing, and closes the process. It uses only standard public development accounts.


## Public campaign deployed September 11, 2026

- Robinhood Chain 4663; distributor `0x29eaa2065d521B6f3ffbaA3012805edc57314Ad6`.
- Dev wallet `0xD6Db8d5d228f8D381F2D1bBbFb41fDE73696735C` is funder, operator and recovery treasury.
- 1,000 USDG funded separately; 25 USDG shared per wallet across all 13 configured markets. The first 40 wallets can reserve a slot. This is a wallet cap, not proof of a unique person.
- Enrollment/accrual: September 11, 2026 17:00 UTC through October 11, 2026 17:00 UTC. Settlement deadline November 10, 17:00 UTC; claim deadline December 10, 17:00 UTC.
- Public configuration: `output/borrower-cashback-20260911/production-config.json`. The RPC URL is configured only as a Railway variable. The service contains no wallet signing key.
- Railway project `18d8be5b-b287-46fc-b75f-67dcbd9536a7`, environment `187f9ada-7dba-408b-b794-28d0c9659b2b`, service `9a5ffaf8-ba56-432c-a3ad-a4c990923eed`, volume `970dfed6-b579-4430-9928-49853c05b9a9` at `/data`.
- API: `https://turret-borrower-cashback-production.up.railway.app`; public domain targets Railway's injected port 8080. The server follows `PORT`.

`policy.walletCap: "25000000"` enables public accounting. Every enrollment reserves the same shared wallet cap across markets. Paid rebates consume the cap in canonical receipt order; later markets cannot displace previously earned rebates. Forecasts share the unused portion of that cap.

`historicalRange: 10000` enables bounded `eth_getLogs` range replay. Every relevant transaction uses its full authenticated receipt. Range boundaries and event blocks are retained; recent blocks retain contiguous headers. History inside a skipped range is not silently reconstructed after a deep reorganization: the reader fails closed. The initial ledger includes all engine history from block 57,000,000, with range checkpoints cross-checked against an independent RPC. A deployment seed is copied only into an empty volume; restarts retain the live SQLite database.

The API fails closed while replaying or indexing has failed. Operator publication accepts a canonical confirmed checkpoint no more than 120 seconds behind chain time; exact head equality is inappropriate for a continuously advancing chain.

Publication is **operator-reviewed, not automatic**. On the running service, run `pnpm prepare-publication` to archive proofs and prepare the unsigned transaction. Review and sign with the dev operator, then verify `Published` indexing and claim availability. The indexing service never signs or transfers funds. Pausing new enrollment leaves repayments and existing published claims usable.
