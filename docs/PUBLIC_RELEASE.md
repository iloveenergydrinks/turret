# Public source release — September 14, 2026

This release collects Turret application, contracts, workers and public documentation into one repository. Operational journals, credentials, private signing pages, release archives and temporary build output are excluded.

## Validation

- Workspace installation from the frozen pnpm lockfile passed.
- Next.js application compilation and application TypeScript checks passed. Video assets, social metadata and the design-note release check passed.
- Frontend server tests: 52 passed.
- Focused wallet recovery, cashback, swap and token-admission tests: 49 passed.
- P2P contracts: 209 passed.
- Rewards contracts: 150 passed, four skipped.
- The broader frontend suite is **not all green**. The initial clean-checkout run after test alias/environment repair had 110 passing test files and 13 failing test files (1,104 passing tests, 36 failures). Failures include outdated catalog and navigation expectations, incomplete browser mocks and service-dependent fixtures. The release does not claim these are resolved. Run the full suite when changing those areas.

Local validation used Node.js 26.5.0 with experimental web storage disabled for frontend tests. The development and CI configuration targets Node.js 22. CI results are separate from these local results.

## Publication checks

The selected source, existing remote branch history and available GitHub Actions logs were scanned before publication. Findings were reviewed against their source context. The secret-scanner exceptions cover public addresses, specific reviewed code/policy hashes and the inherited public Hardhat test-account fixture. Do not use those test accounts for real funds. New keys and unexplained high-entropy strings must not be added to the exceptions.

```sh
gitleaks dir . --config .gitleaks.toml --redact
```

The existing public test-account fixture matches the upstream Git blob `226a1a90cfdb5e148948c34721cae81a1452137e`.

## Scope

Publishing the repository is not a new contract deployment or a statement that every checked-in market is enabled. Production services and frontend exports have separate release histories. The public environment template contains no operator credentials and enables no isolated pools; populate it with your own verified deployment configuration.

The repository has mixed licenses. See [LICENSING.md](../LICENSING.md). The inherited core's BUSL license and original copyright notices remain in force.
