# Staking fee collection

## Current recoverable deployment — 10 September 2026

The active router is `0xe4D13090207bf06a6C17B340292E320afe720144`; staking is `0xd13A10798a7604Ae69433be8e50750264cf4d52C` on chain 4663. The authoritative manifests are `frontend/app/src/staking/deployment.json` and `services/staking-collector/config/deployment.json`. Signed migration and bytecode verification are recorded in `output/turret-staking-recoverable-20260910/live-verification.json`.

Protocol fees retain the 50/50 split and fund a gradually released reserve. The reserve releases approximately 1% of its remaining amount per active day, pauses with no stake, and gives each wallet rewards proportional to its stake during that interval. This is not a user's daily yield. Accrual needs no keeper transaction. The public page refreshes personal earned USDG every five seconds and omits the funding budget.

Treasury subsidies use `fundReserve(netAmount)` and are recorded separately from fee revenue. Treasury may recover only unused subsidy through `recoverReserve(amount)` or `recoverAllSubsidy()`. The latter calculates the amount at execution to avoid a stale quote. Recovery always pays the immutable treasury, checkpoints accrued rewards first, and cannot take earned rewards, TURRET principal, fee-derived reserve or unaccounted donations. Recovery reduces future accrual. Private signing and recovery controls are maintained under `output/turret-staking-recoverable-20260910/signing/`.

The collector uses a fresh identity-bound journal at `/data/recoverable-v2`; the historical journal remains intact. Both superseded contracts remain immutable. The original staking controls at `/stake/legacy` support withdrawal and claims only. The intervening non-recoverable streaming contract was never funded, and its allowance is revoked.

The accepted first release uses the reviewed, immutable router for the existing 13 pools, with 50% of collected fees to stakers and 50% retained by treasury. Existing pool contracts still allow direct treasury claims. Automated collection does not remove this dependency.

## Collector

`services/staking-collector` contains a dedicated worker, independent of the liquidation signers. It can submit only zero-value `collect(pool)` calls to the verified router. Its wallet holds ETH for gas; no treasury keys, USDG allowances or stake custody are given to the worker.

The worker checks every five minutes, picks the eligible pool with the largest pending fee, and collects one pool per cycle. It waits for two RPC block confirmations and verifies the router's distribution event. It leaves fees untouched when there are no stakers, gross fees are below 0.01 USDG, allowance is insufficient, chain identity changes, the RPC providers disagree, or spending limits would be exceeded.

Initial gas limits are 0.00001 ETH per transaction and 0.0001 ETH per rolling day, with a 0.00002 ETH reserve. The prepared initial funding is 0.0002 ETH. Limits are in the worker's reviewed configuration and require a code release to change. These are operational limits; the on-chain 50/50 split is immutable.

The journal reuses the existing SQLite Store with a persistent Railway volume, FULL synchronous commits and a single-writer lease. Signed bytes and their hash are committed before broadcast. Unknown submissions are reconciled or rebroadcast byte-for-byte. A consumed nonce without a matching receipt stops execution for review. The worker does not automatically replace transactions with higher gas bids.

The public `/status` route reports operational reasons and public transaction hashes. It does not expose keys, RPC credentials or signed transaction bytes. `/healthz` reports process liveness; an alive process can still be paused for allowance, funding or RPC verification. No new email or chat notification channel is configured.

## Approval and activation

The prepared treasury approval is a bounded **100 USDG**, from the fixed treasury to the verified router. It is a spending allowance, not an immediate transfer. It is consumed as staking shares are forwarded; the worker pauses when more allowance is needed. Treasury can revoke it with `approve(router, 0)`. The worker cannot renew this approval.

Production activation requires a confirmed deployment, strict bytecode and immutable verification, treasury approval and collector gas funding. The worker starts in `observe` mode and switches to `execute` only after these checks. A deployment plan or predicted address must never be used as evidence of deployed code. The current frontend and worker manifests contain the verified recoverable deployment; do not replace them with a predicted address or an older historical manifest.

## Direct claims and future pools

Direct `claimRevenue()` calls must be reconciled against pool receipts and router events. The treasury can remit bypassed fees through `forwardClaimedFees(grossFees)`. The collector never calls this function or guesses a historical gross amount.

Future pools should set a contract fee recipient that atomically applies the split, so a direct claim cannot bypass stakers. **The current router cannot add pools, and the current staking contract accepts rewards only from that router.** A future integration therefore needs a separately reviewed router/staking version and an explicit stake migration or versioning plan. Sending future fees directly to the current staking contract will not allocate them as rewards and must not be used as a shortcut.

Before any future pool launch, review: the immutable recipient wiring, shared versus per-pool rounding, zero-stake behavior, reward distributor authorization, exact transfer accounting, failure atomicity, and any governance ability to change recipients or shares. The current recoverable revision preserves the same 13 pools; adding future pools still requires a separate reviewed integration.
