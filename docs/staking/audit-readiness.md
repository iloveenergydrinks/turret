# TURRET staking security review — 9 September 2026

Status: internal review and remediation complete; prepared for independent audit. No production deployment has occurred. This review is preparation for the independent audit, not that audit or a guarantee of safety.

## Scope and intended guarantees

Review the exact `TurretStaking` and `TurretFeeRouter` contracts, their pinned OpenZeppelin dependencies, deployment configuration/script, frontend verification/transaction boundaries and existing USDG pool integration. Existing lending campaigns are regression-tested but are a separate system. This is not a re-audit of USDG, TURRET, Robinhood Chain or the full lending engine.

The router deploys the staking contract. Both have immutable counterparties, no upgrade mechanism, no owner withdrawal, no admin sweep and no mutable fee share. Stake belongs to the depositing account; rewards can be claimed only by their owner. No parameter lets an external caller choose a reward recipient or debit an arbitrary treasury. Changing a stake checkpoints its prior allocation. USDG transfer failure must not prevent TURRET withdrawal.

Only successful funding allocates rewards. For gross fees processed by the router, cumulative funding is floor(gross / 2). All allowed-pool collection, treasury pull and staking funding steps must commit or revert together. There is no guarantee that *every* fee paid to the existing treasury is processed by the router.

## Findings and remediation

### STK-01 — RPC and contract block clocks differed (medium, fixed)

The original frontend compared RPC `blockNumber` with `lastStakeBlock` recorded by Solidity `block.number`. On this Arbitrum L2 those values are different clocks. A read-only production probe at RPC block 58,825,974 returned EVM NUMBER 25,942,149. The frontend could offer an ineligible withdrawal, which the contract would reject.

Added `canUnstake(account)` so the eligibility check and withdrawal share the contract's clock. The frontend uses the result, including immediately before sending a transaction. Regression tests reproduce a high RPC height with an ineligible contract clock, then verify recovery when the contract permits withdrawal. The UI explains that the delay can span multiple Robinhood blocks and is not a fixed countdown.

The delay prevents withdrawing a newly increased stake in the same contract-observed block. It does not guarantee fair ordering, prevent short-term funded positions around distributions, or make the sequencer's clock an exact wall-clock timer. Anvil's fork environment does not reproduce Nitro's dual-clock behavior; the separate production RPC probe is essential evidence. See [Arbitrum's block-number semantics](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time).

### STK-02 — Sender-side transfer surcharge was not checked (low, hardened)

Incoming transfers originally checked the amount received by staking, but not the sender's debit. An adversarial token could deliver the requested amount and separately burn an extra unit from the sender. A regression test demonstrated successful over-debit before the change. The incoming-transfer helper now checks both sides; stake and reward funding revert atomically for such tokens. This is defensive compatibility hardening, not an assertion that the deployed tokens currently charge such a fee.

### STK-03 — Existing pools cannot enforce fee forwarding (high-impact trust dependency, unresolved by this architecture)

Anyone can call an existing pool's `claimRevenue()` directly, including before a pending router collection. The pool always pays the immutable treasury. A third party can therefore prevent that collection from being the transaction that forwards the staking share. Treasury-only `forwardClaimedFees(gross)` provides a recovery path, but requires treasury participation and accounting outside the router. The treasury may revoke allowance, retain funds, or report a gross amount more than once. The reported counter is explicitly separate from measured pool receipts.

Neither tests nor the allowance can turn this into unconditional protocol-enforced revenue sharing. Such a guarantee requires changing the revenue destination in future pools or a separate migration of the existing architecture. Reviewers and users must interpret “50/50” as the split of fees successfully processed by this router. This dependency is disclosed in the product and deployment handoff.

### STK-04 — External token controls remain outside staking (trust dependency)

The live USDG runtime is an EIP-1967 proxy. The review snapshot records its implementation and implementation runtime hash, issuer owner and an observed 86,400-second owner timelock. Proxy runtime pins alone do not detect implementation changes. The staking contract cannot prevent issuer upgrades, account restrictions, token confiscation or negative rebases. Exact-transfer checks reject incompatible movements; they cannot reconstruct value removed externally.

TURRET's standard implementation and beacon slots were zero, and owner/paused getters were unavailable in the snapshot. This does not prove absence of custom privileged behavior. The explorer source endpoint returned HTTP 403 and Sourcify full/partial metadata endpoints returned HTTP 404 during this review. The independent auditor should obtain and reconcile the token's source and deployment provenance. No claim that TURRET is administratively immutable is made here.

## Accounting argument

Let S = 10^36. Each funded distribution increases the global index by floor(amount × S / total stake). Accounts checkpoint before their stake changes. Each checkpoint carries the sub-base-unit remainder forward, including across a full exit and re-entry. Thus claims cannot exceed each account's accumulated allocation, and the sum of allocations cannot exceed funding. Index rounding is always downward. Transfers into the contract outside `distribute` are not funding and cannot be captured as new rewards.

Both lifetime funding and total stake are bounded by 2^128 − 1. Even at a one-base-unit stake, index growth is bounded by (2^128 − 1) × 10^36 < 2^256. Account multiplication uses full-precision `Math.mulDiv`; `mulmod` computes the remainder without a 256-bit intermediate multiplication. The sum of two remainders is less than 2 × 10^36. Maximum-bound tests exercise claims and exits after this extreme index growth.

For each gross fee f, the router carries its half-base-unit remainder. The cumulative distributed amount is floor(total measured plus treasury-reported gross / 2), independently of splitting collections into odd micro-fees. An individual collection may allocate the carried base unit to a different staking set than the preceding collection. This rounding convention is intentional and bounded to one USDG base unit across the boundary.

Unsolicited donations and conservative index dust remain locked because there is no privileged sweep. Filling the lifetime funding cap stops future funding, but preserves existing claims and principal exits. It is a numerical safety bound far beyond USDG supply, not a renewable reward cap.

## Test strategy and boundaries

- Public stake/unstake/claim/funding actions: conservation, staggered balances, fractional carry, re-entry, limits, blocked and taxed token transfers, exact reentrancy failures and contract-clock eligibility.
- Real pool integration: paid interest, 90/5/5 economics, missing allowance rollback, failed funding rollback, unknown/changed pools, odd fees, donations and direct-claim recovery.
- Stateful staking model: compare public claims plus earned USDG with an independent per-distribution account ledger, not another implementation of the global index/checkpoints.
- Stateful router model: vary two pools, four stakers, fee accrual, external pool claims, treasury remittance, allowance revocation, donations and withdrawals. Check gross conservation, treasury balances, the exact cumulative split, individual entitlements and principal backing after every operation.
- Wallet boundary: bytecode/identity checks, review amount, exact approval, lost responses, receipt mismatch, rejection, replacement, network/account changes and contract-derived withdrawal eligibility.

A fork test uses real token and pool bytecode but funded test balances and a mocked engine-availability response. It is not a full production borrower lifecycle. No production transaction or token approval is evidence from these tests.

## Compiler and static analysis

Pinned compiler: Solidity 0.8.24, optimizer 200 runs, Cancun, legacy pipeline. The upstream known-bug registry was fetched and preserved in the evidence directory. Its matching entries were reviewed against actual code and settings: the IR recursion bugs do not apply with viaIR disabled; no memory-bytes element delete is present; the bounded pool array and ordinary storage layout cannot intentionally straddle the storage boundary. The registry snapshot includes entries linked to future-dated announcements, so this is a conservative applicability check, not a claim about their release date. Reference: [Solidity known-bug registry](https://github.com/ethereum/solidity/blob/develop/docs/bugs.json).

Slither's raw results are preserved rather than suppressed. Findings involving immutable treasury transfers and pre/post transfer balance checks require manual context: immutable allowlisting, observed receipts, treasury-only remittance and nonReentrant entry points constrain those paths. The callback tests verify the exact reentrancy-guard rejection at each transfer stage. A bounded constructor loop makes a deployment fail atomically if a pool is invalid; it does not grow with the number of stakers. The final Slither run completed with 24 raw detections: 11 affecting the new staking/router and 13 affecting the separate lender-campaign contract. The 11 in scope were reviewed and classified with reasons and test references in `slither-triage.json`; no in-scope detector remains untriaged. This does not claim the analyzer found zero issues.

## Final verification and reproducibility

- 44 non-invariant contract checks passed, including the live staking/token/pool fork test. One existing lender-campaign fork test was skipped because its separate RPC variable was unset.
- Staking reference-ledger invariant: 1,000 runs, 500,000 operations, zero unexpected reverts. Router invariant: 256 runs, 65,536 operations, zero unexpected reverts. Future invariant runs fail on unexpected handler reverts.
- Five isolated mutations were all caught by behavior tests: omitted entry checkpoint, lost fractional credit, wrong fee split, same-block exit, and sender surcharge. The mutation runner never edits reviewed workspace sources.
- 52 frontend checks passed, including 18 staking checks and 34 existing lender-reward checks. Production build verification is recorded in the evidence manifest.
- The corrected contracts were deployed only to a local fork. The full deployed runtime including metadata, token/router immutables and all 13 pool identities passed the inspection script.

Run contract verification from `contracts/rewards`:

```sh
forge build --force
STAKING_FORK_RPC=https://turret.capital/api/rpc forge test --no-match-contract '.*InvariantTest'
forge test --match-contract TurretStakingInvariantTest
FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=256 forge test --match-contract TurretFeeRouterInvariantTest
```

The pinned library commits are OpenZeppelin `bd325d56b4c62c9c5c1aff048c37c6bb18ac0290` and forge-std `726a6ee5fc8427a0013d6f624e486c9130c0e336`; both library worktrees were clean during the review. Tool versions: Foundry 1.7.1 and Slither 0.11.6. The evidence manifest hashes the final source and artifacts because the surrounding repository already contains unrelated uncommitted work; a repository HEAD alone does not identify this audit target.

The evidence directory is `output/turret-staking-audit-20260909`. It includes regression failures before the fixes, passing runs, analyzer output and dispositions, mutation results, the live clock probe, upstream snapshots, the local-only deployment check and a standalone Solidity source/test bundle. The earlier `turret-staking-20260909` logs describe the pre-review revision and must not be used as the current artifact fingerprint.

## Deployment position

No production deployment, treasury approval, fee withdrawal or frontend publication has occurred. The pre-review local candidate is obsolete because contract bytecode changed. Rebuild, re-test and verify the final artifact; never reuse the earlier local addresses. All production activation remains subject to the unresolved trust assumptions above and the independent audit's findings.
