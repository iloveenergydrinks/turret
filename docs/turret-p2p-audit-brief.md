# External P2P review brief

Prepared for an independent reviewer. No vendor has been contacted or booked by this task.

## Objective

Review the current fixed-term bilateral lending contracts and their hardened integration before materially increasing deposits. Identify exploitable state transitions, custody/accounting failures, token dependency assumptions and operational failure modes. Distinguish public attacks, privileged-token behavior and deliberate economic terms.

## Package

- `contracts/p2p/src/TurretP2PLendingV2.sol`: current permissionless funded public/private offers; SHA-256 `d810c558c5b124824ee8a2f62dabe4b56ee0cafbf86a6e1237b1260e3caaee34`.
- `contracts/p2p/src/TurretP2PLending.sol`: legacy restricted SLV; SHA-256 `7fd41df273e10e9bfdcc3fff81c60d819654c09927ff9957b5c0637df3df903a`.
- `contracts/p2p/src/TurretP2PBatchDeployerV2.sol`: constructor-only helper; SHA-256 `03e345da925d43eb3d1b728a2141821298babbe919dce65160302b3f2fe4e0f2`.
- `contracts/p2p/foundry.toml`, used OpenZeppelin dependencies, all unit/invariant/fork tests, and production deployment records.
- `frontend/app/public/p2p-markets.json`: 19 V2 markets plus legacy SLV; chain 4663. Reconcile addresses and runtime hashes at the review block.
- `frontend/app/public/p2p-token-baseline.json`: 20 observed token identities, standard proxy dependencies and supported restriction probes. This is not complete token qualification.
- `frontend/app/src/p2p/`, current P2P/portfolio screens, and `frontend/app/scripts/p2p-loan-index.mjs`: transaction identity, health guards, accepted-loan discovery, reorgs, failed reads and recovery.
- `output/p2p-contract-review-20260907/REPORT.md`: prior findings and execution evidence. The permanent-history spam scenario is now addressed through active-event discovery; validate the actual integration independently.

## Required focus

Verify exact token deltas and credit ownership, state-machine terminality, deadline boundaries, callbacks, unauthorized callers, arithmetic bounds, and aggregate backing. Include alternate recipients, externally changed token behavior, paused recovery, public offer races and untrusted discovery results. Evaluate whether the frontend can hide an accepted obligation or enable fresh exposure after required checks fail.

Complete exact-source reproduction and role/power mapping for USDG, the Robinhood token/beacon implementation, CASHCAT, PONS and INDEX. Assess source availability, upgrades, pauses, freezes, burns, multipliers and who can trigger them. Unsupported getters are not evidence of absent permissions. Actual-token fork compatibility alone does not satisfy this scope.

Use an independent state model and stateful/differential tests. Re-review every material fix and bind findings to exact source revisions. Do not include optional V3 extensions, credit repayment, guardian rotation or deficit policy as silently approved scope; those require separate review when implemented.

## Acceptance and handoff

Deliver a severity-ranked report with prerequisites, affected code, reproducible local evidence, remediation and explicit unresolved assumptions. Reproduce the final deployment bytecode/bindings and validate any migration path. No critical/high unresolved public fund-loss finding is acceptable for scale-up; residual economic/issuer risks need clear acceptance and user disclosure.

Before commissioning, the owner must select the reviewer, budget and engagement scope. No spending or disclosure of private RPC credentials, wallet keys or unpublished operational credentials is needed to share the public source package.
