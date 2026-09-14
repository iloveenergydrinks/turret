# Reusable P2P lender facilities

12 September 2026. Local implementation specification for release C. No production deployment, signer mandate or fee rate is approved by this document. Existing V3 agreements remain untouched.

**Deferred:** active work is the individual V3 P2P release following the owner's scope clarification. This facility specification preserves local research; it is not the current release plan or a prerequisite for independent lenders to fund offers.

## Custody and capital

Deploy one immutable facility for one lender, USDG and one collateral token. There are no pooled shares or cross-lender balances. The facility holds idle USDG. A separate non-upgradeable vault holds each loan's collateral and repayment credits, reusing the V3 vault implementation pattern. Only exact-transfer, non-rebasing tokens are supported.

The lender deposits once. New loans atomically debit recorded idle cash and send exactly the principal to the borrower. A loan's collateral is transferred from that borrower directly into its new vault. No oracle, minting or swap is involved. Lender deposits, idle withdrawals and per-loan recovery all check actual token balance changes, including sender debits.

Two independent bounds apply to every draw: recorded idle cash backed by actual USDG, and the lender's maximum principal exposure. Exposure is active principal plus unresolved default principal. Repayment removes active exposure but creates a lender credit in that loan vault; it does not immediately increase idle cash. Anyone may recycle an available lender repayment credit into the facility. Only the amount actually transferred increases idle cash. The lender can instead withdraw that credit directly. A second recycle cannot reuse the same credit.

Donations do not increase recorded idle cash. Only the lender may withdraw surplus cash. If idle USDG disappears, draws and deposits stop until the lender explicitly acknowledges the missing balance. The acknowledgement reduces recorded cash and reports the loss; it cannot manufacture replenishment. Nominal credits and actual available backing remain separate views.

## Lender mandate and quote authorization

The immutable lender may set hard limits and optionally appoint a quote signer. The lender itself can always sign. Support EOA and ERC-1271 signatures through the repository's pinned OpenZeppelin SignatureChecker. The signer cannot deposit, withdraw, change limits, acknowledge losses or move collateral. It can authorize loans only inside the lender's on-chain limits.

Limits: maximum exposure, minimum and maximum draw, minimum and maximum whole-day duration, maximum quote lifetime, minimum collateral units per principal unit (scaled by 1e18), and minimum fixed interest in basis points. These are supplied by each lender; examples in tests are not deployment defaults. Lowering exposure below existing obligations is allowed and stops new draws without altering old loans.

Each policy or signer change increments an epoch, invalidating all outstanding quotes. New loans may also be paused without blocking repayment or recovery. Pausing suspends execution; it does not revoke signatures. Resuming before expiry makes uncancelled current-epoch quotes executable again. Change policy or cancel nonces to revoke them. A quote includes epoch, nonce, permitted borrower (zero for public), principal capacity, minimum draw, collateral at full capacity, fixed interest at full capacity, duration, valid-after time and expiry. Its EIP-712 domain includes chain ID and the facility address. Tokens, lender and fee configuration are immutable at that address.

A nonce identifies exactly one quote within its epoch. The first fill binds its digest; another signed payload with that same nonce cannot create independent capacity. Cumulative fills never exceed signed capacity and never decrease on repayment or default. The lender can cancel a nonce before or after partial filling. Cancellation, revocation, idle withdrawal and competing draws resolve in transaction order, with no off-chain promise of reserved capacity.

### Signed quote directory

The local directory candidate accepts the exact EIP-712 quote signed for the facility contract. Publishing that signature authorizes capital draws; it is not a harmless listing signature. Any relay can submit an already signed quote. The service does not hold lender keys or sign on their behalf.

Only explicitly admitted facility identities are read. Each read verifies the chain, facility and vault runtime hashes, immutable lender/token/fee bindings, qualified token implementation and transfer controls, policy, cash, exposure, nonce use and current signature authority at one block. It rechecks the block hash after the reads and rejects observations older than 30 seconds. ERC-1271 checks use the facility as caller and the pinned OpenZeppelin signature response rules. Transport failures remain unavailable; they do not become an empty marketplace.

The directory imposes two additional publication rules: expiry must be within the next 24 hours, and the signed collateral and interest ratios must meet lender floors before rounding. The contract still checks the actual rounded draw. These directory rules avoid advertising rates that only qualify for particular tiny draw sizes. A scheduled, paused or temporarily unfunded quote may be stored, but is not advertised as currently available. Repaid amounts do not reset a quote's cumulative fill limit.

SQLite transactions persist quotes and enforce one payload per facility, epoch and nonce while it remains unexpired. A signature for the same payload may be refreshed after verification. Each facility can store at most 100 live quotes; the default directory limit is 2,000. Expired records release those slots. The database must reside on a durable volume. Multiple processes may share that same local database; independent service replicas with separate disks are not supported by this storage implementation.

Each listing rereads all stored quotes for the facility, deduplicates nonce capacity and caps the total by backed idle USDG and remaining exposure. The aggregate is an upper bound: minimum draw sizes can leave unusable dust, and the total is not a promise that one borrower can take it in one transaction. Borrower-bound quotes contribute only for that borrower. Their restriction is enforced on chain; it does not make the terms confidential. The wallet must freshly verify and simulate its exact draw before requesting a transaction signature.

The API handler accepts only bounded JSON submissions from its configured origin and caps concurrent chain checks. The local website server now mounts `/api/facility-quotes` through `facility-platform.mjs`; this change is not deployed. The mount bounds both declared and chunked request bodies, limits concurrent body readers and times out incomplete submissions. Active configuration requires an absolute `FACILITY_QUOTES_DATABASE` path on a durable volume. `FACILITY_ORIGIN` selects the website origin, falling back to `NEXT_PUBLIC_APP_URL`. The release-owned `facility-markets.json` provides admitted identities and token baselines; its current empty registry returns an explicit inactive response and creates no database. There are no admitted production facilities in this release.

Signed quotes share the facility's available capital. A directory must not sum their capacities as if each had its own funded escrow. At one verified block, cap aggregate availability by actual backed idle cash and remaining exposure, then apply quote-specific remaining capacity, expiry and minimum draw. A price quote is not a capital reservation. This differs from V3's independently funded offer vaults and requires a separate client/data model.

## Partial draws and borrower consent

For principal `p` drawn from signed capacity `q`, collateral is `ceil(p * collateralForCapacity / q)` and fixed interest is `ceil(p * interestForCapacity / q)`. Full-precision multiplication/division avoids intermediate overflow. Splitting can increase rounding costs; it cannot reduce the lender's agreed collateral or interest per unit. Enforce minimum draw and all policy bounds on the actual draw.

The borrower calls directly. Funds go to that caller; collateral is pulled only from that caller. Self-borrowing by the lender is rejected. A private quote cannot be filled by another address. The caller supplies maximum collateral and maximum interest as transaction bounds and a minimum remaining quote capacity, so a stale partial-fill review can fail before moving funds. An approval alone does not reserve capacity.

### Wallet client

The local wallet client verifies the admitted facility and vault identities, rereads the signed quote, and shows exact collateral, fixed interest, total repayment and protocol fee before drawing. It reads collateral balances and allowances from the same block. If an allowance differs from the required amount, it clears a nonzero allowance before approving the exact amount. After each approval, it rechecks current quote authority, capacity and wallet identity, then simulates the draw before requesting the loan transaction.

A borrower review can be used for only one execution attempt. Reusing a lender quote is allowed, but reusing a previous borrower confirmation after a timeout is not. Pending hashes and exact requested calls are saved under the facility, chain and original wallet. Recovery verifies the canonical transaction consuming that nonce; a cancelled or different transaction never becomes a successful loan. A successful draw with a lost receipt requires transaction recovery and a fresh review before another draw. Account changes retain the original wallet's pending record. Shared in-page locks prevent concurrent client instances from submitting together, and browser Web Locks extend this protection across tabs where supported.

Lenders and appointed quote signers can review and sign quote terms through their connected wallets. The client explicitly describes the signature as authorization to lend deposited USDG. It rechecks authority after signing. No private key is stored, and no automatic signer is introduced by this client. Quote publication and the user-facing screens still need to be connected to the API.

The client also exposes lender deposits, policy changes, pauses, quote cancellation, repayment, recycling, fee collection, collateral and repayment withdrawals, default settlement, loss acknowledgements and bilateral extensions. Recovery checks immutable custody identities without depending on new-loan token qualification. Available credits are read separately from loan terms: unavailable balance checks remain unknown, not zero, and cannot hide the information needed to repay.

Local wallet screens are wired through `/borrow/p2p?facility=<address>` with Borrow, Lend and My loans views. Individual P2P routes retain their existing flow. A draw review is discarded after use, a wallet change, an offer replacement or 30 seconds; refreshed directory data cannot revive expired consent. Wallet progress and errors appear beside the active form. Signed lender terms are saved locally before publication so an unavailable directory can be retried without asking for another signature. Extension consent is bound to the full displayed proposal tuple. The browser loan list uses the durable `/api/facility-loans` index; isolated clients retain a bounded direct-contract fallback. History includes active, repaid and defaulted loans, so repayments and unclaimed withdrawals remain discoverable. Each request scans bounded contiguous ranges from the admitted start block, checks opening IDs against the contract counter and verifies canonical hashes. SQLite checkpoints and loan records commit atomically; retained checkpoints support rewind, with a full rebuild after deeper reorganizations. A history epoch invalidates orphaned browser rows. Listings read current loan terms at one fresh block, paginate twenty wallet-matched rows at a time and distinguish incomplete synchronization from an empty history. The index shares the explicitly configured durable database with the quote board. These screens have component and local-chain tests but are not yet a verified live browser release.

## Repayment, defaults and recovery

Repayment owes principal plus the entire fixed interest, even when early. Anyone can pay for the named borrower. Repayment is permitted through the final deadline inclusively, which is due time plus 24 hours. Default is permitted strictly after that deadline. The winning confirmed transition is final. No price movement triggers liquidation.

Repayment sends exact USDG into the loan vault, records lender and protocol credits, and makes collateral withdrawable by the original borrower. Default instead makes collateral withdrawable by the lender. Settlement does not claim tokens have already arrived in the beneficiary's wallet. Each withdrawal is limited to that loan's nominal credit and actual balance. Only the beneficiary can acknowledge missing collateral or lender repayment backing.

After default, principal continues consuming exposure even if collateral is claimed. Only the lender can explicitly acknowledge that default, and only after its collateral credit is fully withdrawn or written off. Acknowledgement clears unresolved exposure and records the principal basis of the default; it is not an assertion of realized sale proceeds or profit. Delegated signers therefore cannot silently recycle the mandate after losses.

Extensions require explicit agreement from both borrower and lender. A proposal records a nonce, exact current deadline, proposed later final deadline and acceptance expiry. A stale or cancelled proposal cannot change terms. Interest is unchanged. Extensions may race with default settlement; already settled loans cannot be extended. Facility quote epochs and new-loan limits do not rewrite active loan agreements.

## Fees

The protocol fee rate and recipient are constructor immutables. Local tests exercise multiple rates, including the proposed 10% share of collected interest; no rate is active without a separate deployment decision. Fee is `floor(interest * feeBps / 10000)` per repaid loan. Principal never pays a fee; defaults produce no USDG fee claim.

Lender repayment credit equals principal plus interest minus the fee. Within a loan vault, lender credit has priority over fee credit if USDG backing disappears. Fee withdrawals transfer only available fee backing to the immutable recipient. A blocked fee recipient does not prevent repayment or lender recovery. Accrued fee claims are not collected revenue; track the actual withdrawal event before forwarding through existing staking/treasury routing. This contract does not buy or burn TURRET.

The existing recoverable staking router supports outside revenue through treasury-only `forwardClaimedFees`; its current pool collector cannot make that call. Local receipt reconciliation now matches facility fee events to USDG transfers, validates qualified token/router identities, and matches confirmed treasury remittances to exact collection IDs. Unknown changes in treasury-reported forwarding prevent another clean audit. An operator CLI produces unsigned calldata and allowance requirements. The local-chain test proves the 50/50 transfer into the existing staking reserve. Receipt attribution remains an operator journal responsibility: the existing router does not enforce it on chain. A local SQLite intent API now prevents concurrent reservations, persists the exact treasury nonce before signing, recovers matching transaction hashes after restart and commits confirmed source assignments atomically. It requires one authoritative database and does not sign or send. Wallet integration, verified recovery for reverted/cancelled submissions, and checkpoint rollover remain incomplete. See [fee operations evidence](../output/memecoin-switch-20260912/facility-fee-operations.md).

## Required invariants and tests

1. Idle cash never increases without an exact deposit or actual credit recovery. A draw cannot spend active principal or another loan's credit.
2. Active plus unresolved-default principal never exceeds the current limit as a result of a draw. Policy reductions do not alter existing obligations.
3. Quote fills are monotonic and bounded by signed capacity, including after repayments, epoch changes and conflicting payloads.
4. Domain, signer, epoch, nonce, private borrower, time window and borrower transaction bounds are all enforced before transfer.
5. Loan status transitions and default/repayment deadlines agree at their exact boundaries. Each settlement credits exactly one collateral beneficiary.
6. All token flows reject sender taxes, recipient taxes, skipped transfers, false returns and reentrant state changes without leaving partial accounting.
7. Borrower collateral recovery is independent of protocol fee collection. Cash losses remain local to the facility or affected loan vault.
8. Repeated repayment, default, recycling, withdrawals or extension acceptance cannot duplicate value.

Implementation and stateful accounting tests are local. Before production admission, complete actual-token fork lifecycles, wallet/client integration, browser verification and fee-router reconciliation. The local event index is implemented and tested, but production storage and deployment still need verification. Record a separate approved deployment configuration. No automatic V3 migration or treasury seeding is included.
