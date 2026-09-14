# Standing P2P offers

14 September 2026. Active implementation scope: build, test, fit Turret's existing UX and release to production. Supersedes the deferral in turret-p2p-facility-spec.md for reusable lending. That document remains the detailed custody/quote contract specification.

A lender chooses an admitted stock or memecoin, creates a personal lending balance, deposits USDG and signs reusable terms. Multiple borrowers can accept partial amounts until the signed capacity or shared cash runs out. Every loan has isolated collateral, fixed full interest and a repayment deadline plus 24-hour grace. Lenders can withdraw idle cash; active principal cannot be withdrawn on demand. No oracle or treasury liquidity is involved.

The factory creates one immutable facility per lender/token pair with the caller as lender. The factory has no administrator, custody or upgrade path. Initial collateral is the current qualified P2P stock/token set. Future token expansion requires a separately verified factory or registry release. Facilities use zero protocol fee, preserving current individual P2P economics. No buyback automation, signer service, protocol funding or fee-router change is part of this release.

Public onboarding must be permissionless for supported tokens. Do not substitute pre-created dev-funded balances or an operator-only registry for lender setup. The website verifies factory origin, code, token bindings and quote authority. Directory registration must persist across restarts. Availability is checked against shared backed cash and exposure, never the sum of duplicated offer capacities. Failures must show unavailable rather than an empty book.

## Acceptance evidence required

- Factory caller binding, immutable identity, unique lender/token mapping, no custody/fee changes, invalid configuration and multiple-borrower accounting tests.
- Existing facility lifecycle/fuzz tests; actual USDG and admitted collateral fork checks covering entry, repayment/recycling, default/withdrawal and transfer restrictions.
- Durable public facility discovery, bounded quote publication/listing, accurate partial fill and expiry, restart/reorg handling, and spoofed identity rejection.
- Lender wallet setup, exact approvals/deposit, understandable signed terms, publish/retry/cancel, pause/resume and idle withdrawal. No disabled confirmation caused by a missing client; visible errors adjacent to actions; pending transaction recovery.
- Borrower comparison across lenders/assets, exact collateral and repayment review, fresh checks after approval, acceptance and loan discovery. No false guaranteed funding or instant wallet-transfer wording.
- Existing individual P2P and NFT loans, pool loans, Earn, staking, portfolio and repayment/recovery remain accessible and unchanged unless a targeted integration is tested.
- Real browser lifecycle on local chain plus mobile/desktop inspection in the current Turret visual system. Keep standing offers within P2P stocks and memes; no new top-level Borrow product tab. Reuse searchable logo collateral picker.
- Production deployment, verified factory bytecode/config, durable service storage, published frontend, route/API checks and runtime verification. Document any real mainnet transaction separately from fork tests; do not claim external audit.

This document is not proof of delivery. Evidence belongs in output/standing-offers-20260914. Current implementation is not yet deployed.
