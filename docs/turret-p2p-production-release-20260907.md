# P2P production release — 7 September 2026

The tested P2P safeguards are deployed at [turret.capital/p2p](https://turret.capital/p2p). Railway deployment `944552c7-73f8-409d-9214-5412ecd312be` reached `SUCCESS` and passed authenticated production checks on 7 September 2026 at 12:46 UTC.

## Scope

The release adds active-loan discovery, token and escrow health checks before new lending, direct loan recovery, exact deadline/calendar controls, and clearer credit repayment handling in P2P and Portfolio. The Node server bundles its new index and runtime dependencies. The token baseline and market registry are included in the deployment.

Existing V1/V2 contracts, addresses and accepted loan terms remain unchanged. All production verification was read-only. No funds were moved and no public-network transactions were sent. The password gate remains enabled with the same credentials and configuration.

The concurrent Documentation footer update was deployed first as `182ef6dc-e5f2-4596-8705-d6169897b952`. This release was rebuilt on that exact verified runtime. It preserves the updated homepage, blog, existing assets and signed-out Documentation link; P2P and Portfolio include the same link in their rebuilt entries.

## Validation

- The current implementation passed 106 contract tests, 225 frontend tests, 34 server tests and the frontend TypeScript check. Transactional browser scenarios ran on a local Anvil chain with synthetic funds before release.
- The exact compact production package was built and started in Node 24 Docker. All 8,054 frontend file hashes matched the manifest, and authenticated HTTP checks passed.
- After deployment, Railway SSH confirmed the exact 8,054 runtime files and unchanged public and private service configuration hashes. All 87 new browser assets matched the tested release over HTTPS.
- Authenticated page checks passed on `turret.capital`, `blog.turret.capital` and the Railway service domain. They covered P2P, Portfolio, Borrow, Earn, the P2P article and relevant public manifests. The blog's own route mapping was checked separately.
- Signed-out pages retain the password gate and Documentation link. Login/session cookie protections remain in place, and unauthenticated index requests are denied.
- The live index returned complete, canonical-block results for V2 and legacy V1 markets at Robinhood block 56,844,851. An unregistered market was rejected. These smoke requests used an account with no active loans; nonempty histories and failure recovery were covered in the local transactional tests.
- Production browser checks loaded all 20 markets, opened direct recovery controls, loaded Portfolio, Earn and the P2P article, and preserved the Documentation link. Desktop and mobile screenshots were inspected; no browser exceptions or horizontal overflow were observed.
- A read-only health run through the newly deployed RPC proxy passed for all 20 markets on chain 4663 at canonical block 56,844,845. It completed at 12:47:45 UTC with no failed observations and zero public transactions. This point-in-time result does not replace token qualification or an external audit.

## Release provenance

| Item | Value |
| --- | --- |
| Railway project | `edf06c48-4331-4fd1-bf0c-04619089a315` |
| Environment | `724dcf3f-d5c3-4507-97ee-8d78ce752e11` |
| Service | `06e265f8-21bd-4353-b466-9a74845daf40` |
| Deployment | `944552c7-73f8-409d-9214-5412ecd312be` |
| Previous verified deployment | `182ef6dc-e5f2-4596-8705-d6169897b952` |
| Release manifest SHA-256 | `da8ef056c4d39e39301d008c89367f180ab9acc2d7ab9dad9af5bc7ef6a47776` |
| Uploaded archive SHA-256 | `44ca9fa934659cef0caaf65568e912237fd442edc862e6a775be460477050b0c` |

The frozen release, compact-upload and deployment manifests are in `output/p2p-hardening-20260907/`. Session evidence and screenshots are retained in `/tmp/turret-p2p-prod-20260907/`. Future deployments must start from the current verified production release rather than an older article/footer package or the entire dirty workspace.

## Remaining limits

The health gate runs in the website; it does not change direct contract behavior or automatically pause contracts. The active-loan cache is rebuildable and is not a durable financial ledger. A scheduled operator monitor was not deployed.

Complete token implementation/admin qualification and an independent external audit remain outstanding. V3 is a specification, not a deployed contract upgrade. Existing token-freeze, backing-deficit and immutable-deadline risks remain as described in the [hardening report](turret-p2p-hardening-20260907.md).
