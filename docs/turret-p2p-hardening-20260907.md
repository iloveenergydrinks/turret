# P2P hardening implementation — 7 September 2026

Implemented, tested and deployed to the production website on 7 September 2026. Railway deployment `944552c7-73f8-409d-9214-5412ecd312be` reached `SUCCESS`; all 8,054 frontend runtime files match the tested release. This deployment did not change production contracts, send public-network transactions, or commission an external audit. See the [production release record](turret-p2p-production-release-20260907.md).

## Implemented

| Review recommendation | Result |
| --- | --- |
| M-01: unsolicited offers bury obligations | A server index discovers acceptance and settlement events independently of proposal history. It checks canonical blocks, handles reorgs, persists checkpoints atomically, and revalidates returned loans onchain. Both P2P and Portfolio retain known active loans when discovery is incomplete. |
| Recovery independent of the index | Market/loan-ID lookup and direct loan links remain available. An incomplete index is shown explicitly, including a recovery link from Portfolio. |
| Token and backing checks | The release baseline binds 20 token identities, standard proxy/beacon dependencies, and supported restriction probes. New offer creation and acceptance are guarded against changed identities, restrictions, backing deficits, stale data, and failed required reads. |
| Preserve existing recovery | Cancellation, expiry, repayment, default settlement and withdrawals bypass the new-exposure health gate. Escrow identity and exact transaction simulation remain required. Mutable decimal getters no longer block these recovery actions. Wallet/account/chain are checked again immediately before signing. |
| Deadline and credit usability | Exact UTC final deadlines, outage warnings, an importable calendar download, and a two-transaction withdraw-then-repay workflow. Withdrawal alone never reports the loan as settled. |
| Documentation and repeatable validation | Updated current/legacy contract README, monitoring and recovery policy, V3 functional specification, external review brief, event/recipient tests and CI coverage. |

The health gate is implemented in the website. It is **not a new onchain restriction or an automatic guardian pause**. Direct contract calls retain existing rules. The operator CLI performs one read-only monitoring run; no scheduled alert service was created. Standard-slot monitoring cannot identify every possible token privilege or proxy design.

## Validation

- **106 contract tests passed**, including the added V2 event payload and alternate withdrawal recipient coverage. Production Solidity source hashes remain unchanged from the review.
- **225 frontend tests passed** across P2P, Portfolio and the P2P screen, including wallet changes during verification, failed health checks, reorgs, unavailable discovery and calendar boundaries/escaping.
- **34 server tests passed**, including persistent indexing, bounded requests, old active loans surrounded by 80 cancelled offers, canonical-block checks and existing RPC proxy behavior.
- Full frontend TypeScript check passed. P2P and Portfolio Vite bundles built successfully; a complete Next.js production build was not run for this task.
- Browser tests used a fresh local Anvil chain with synthetic funds and the actual index/client/components. They verified discovery after 80 cancelled targeted offers, Portfolio retention during index failure, calendar download, repayment while new lending is paused, withdrawal followed by repayment with onchain settlement/credit assertions, and direct loan lookup with the index unavailable. Separate checks verified that paused lending and an unavailable token baseline disable offer review with an explanation. Desktop and mobile layouts were inspected.
- A fresh read-only health check passed for all **20 registered escrows** at Robinhood block **56,830,076**, observed **2026-09-07 12:22:35 UTC**. This is a point-in-time check of the implemented observations, not a complete token security assessment.

Run the checks from the repository root:

```sh
forge test --root contracts/p2p
pnpm --dir frontend/app exec vitest run src/p2p src/portfolio src/screens/P2PLoansScreen
pnpm --dir frontend/app test:server
pnpm --dir frontend/app exec tsc --noEmit
node frontend/app/scripts/p2p-health.mjs --output /tmp/p2p-health.json
```

Local execution logs, browser scripts, screenshots and the exact live-health observation are retained in `/tmp/turret-p2p-hardening-20260907/` for this session. Implemented regression tests are in the repository.

## Remaining work and limits

1. **D-01 remains open:** exact implementation reproduction and complete privileged-role/behavior qualification for the token families are not complete. Existing partial source and role observations are evidence inputs, not approval. The monitoring baseline does not close this finding.
2. **External review is not commissioned.** The [review brief](turret-p2p-audit-brief.md) defines the package; reviewer, budget and engagement scope remain to be selected.
3. **V3 is specified, not implemented or deployed.** [The specification](turret-p2p-v3-spec.md) covers mutual extensions, repayment using credits, guardian rotation and the unresolved insolvency policy. Existing V1/V2 contracts and accepted terms remain unchanged.
4. A token freeze or network outage can still cross an immutable repayment deadline. A token-induced escrow deficit can still cause unequal recovery through direct contract calls. Detection and clearer recovery access do not remove either underlying dependency.
5. Index completeness depends on RPC availability and configured capacity. No hundreds-of-concurrent-users load test was performed. Persisted checkpoints are a rebuildable cache; loss of the cache can require backfill.
6. The website rollout is complete. The deployed Node server bundles the index and its `viem` runtime dependency, the server can read its release-owned registry, and the browser export includes `p2p-token-baseline.json`. Ongoing operator alerting remains separate work; this deployment did not create a scheduled monitor.

See the [monitoring and recovery policy](turret-p2p-security-policy.md) for incident handling and baseline replacement rules.
