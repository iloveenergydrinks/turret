# P2P UX and offer negotiations

Implemented locally on 9 September 2026. Not deployed. Existing contracts are unchanged.

## User flow

The stock/token P2P workspace starts with Borrow USDG, Lend USDG and Manage my loans. Borrowing shows funded offers and borrowing requests; lending shows requests and offer creation; management contains loans, withdrawal credits, negotiations, activity and alerts. The existing Borrow hero, videos and loan-type navigation are retained.

Offer comparisons lead with USDG received, total repayment, collateral at risk and duration from acceptance. Sorting and additional filters are disclosed on demand. Empty borrowing results lead to requesting a loan, rather than creating a lending offer. Borrower requests retain their existing public signatures, API and funding flow. Proposal details are collapsed until needed.

A borrower opens an eligible current V3 offer and selects Propose different terms. Wallet authentication unlocks participant-only conversations. Both parties may propose exact principal, collateral, fixed interest, duration and offer expiry. The editor compares the old and new terms and uses a separate respond-by deadline. The other party agrees to the latest proposal. Signed actions include the parties, source digest, proposal identity, exact displayed terms, revision, origin, chain and replay-protected nonce.

Agreement does not reserve the onchain offer. The original can still be accepted until cancellation confirms. One negotiated replacement can be selected per source offer. The lender starts replacement, cancels the original, withdraws its USDG credit and funds the exact private replacement. The borrower then reviews and accepts through the incumbent loan screen. Early repayment, defaults, V3 extensions, old loans and normal withdrawals retain their contract rules.

## Recovery and privacy

- SQLite persists separate conversations, signed events, source selection, sessions and idempotency results. The public V1 request board is unchanged.
- Private GETs require a wallet-authenticated bearer session. Account query parameters do not confer access. Responses use `private, no-store`; wallet changes hide private state. Visible conversations poll every 15 seconds. The inbox labels whose turn it is and new revisions.
- New actions are rejected on stale revisions, expired deadlines, unexpected fields, wrong parties or source identity, shortfalls and unconfirmed chain evidence. RPC-dependent reads verify the registry runtime and token identities at a canonical block.
- A replacement checks the original cancellation transaction and zero remaining nominal USDG credit. Its funded-offer ID comes from the verified creation receipt. The client rechecks replacement consent after approvals and simulation, immediately before the funding wallet request.
- A server-recorded funding attempt, local recovery journal and Web Locks prevent ordinary reload/multi-tab retries from silently creating another offer. Known rejection or failure before submission may retry. Unknown submissions require transaction reconciliation or the confirmed transaction hash; no automatic second funding occurs. A different browser/device can recover with the transaction hash.
- Cancellation, repayment and credits are not represented as money received until withdrawal occurs. The replacement UI refuses an unavailable or deficient original credit; it does not write off a shortfall.
- Conversations are private through the application, not end-to-end encrypted. Operators can access stored records. Onchain offer terms remain public.

## Operation

The server uses `P2P_REQUESTS_ORIGIN` (falling back to `NEXT_PUBLIC_APP_URL`, then the canonical public origin) and stores `negotiations.sqlite` under `P2P_REQUESTS_DIRECTORY`, alongside the existing request-board data. Use a persistent directory and a single server writer. The implementation uses `node:sqlite`; the configured Node 22 image must resolve to a version with that module. Do not substitute the existing public request JSON store for this database.

For backup, use SQLite's online backup facility or stop the process and copy the database consistently with its WAL. Preserve the existing V1 request file too. Test restoring the database and keep the same canonical origin. Rolling back the UI must retain the SQLite data and pending transaction records; outstanding onchain loans remain accessible through their direct offer links. Horizontal scaling has not been qualified.

The checkout's older V2-only registry was replaced with the live `/p2p-markets.json`: 19 current V3 markets and 20 retained markets. All 19 current manager runtime hashes were checked against chain 4663 at block 58457923. This read-only comparison does not constitute an audit or authorize a production deployment. The prior local registry and fetched live registry are retained in the evidence directory.

## Verification

Evidence: `output/p2p-ux-negotiations-20260909/` from the repository root.

- 271 frontend/client tests passed, including the existing P2P lifecycle and new negotiation UI tests.
- 21 server/integration tests passed, including privacy headers, participant authorization, signed exact terms, idempotency, stale revisions, simultaneous actions, source selection and receipt validation.
- A disposable local Anvil chain exercised real V3 transactions: create original offer, exchange counteroffers, agree, cancel, withdraw, create replacement, link its receipt, accept, repay and withdraw both parties' assets. The original request-board integration lifecycle also passed.
- TypeScript checking and the Next production build passed.
- Browser checks at 1440px and 390px passed: intent navigation, keyboard tabs, exact comparison, no horizontal overflow and no page errors. Browser preview amounts are explicitly illustrative and wallet submission is disabled.
- The design detector found only advisory font-size differences; these sizes follow the incumbent financial workspace and are recorded in the surface brief.

The local preview is at `http://127.0.0.1:18649/`; `/negotiation` shows the comparison editor. It is a design preview, not the production deployment or an enabled wallet session. No production listings, loan transactions, notifications or deployments were performed.

## Production release

Deployed with user approval on 2026-09-09 to https://turret.capital/borrow/p2p.

- Railway deployment: `ee36b53f-c66a-469f-8c7c-b98e1ebb0e7a` (`SUCCESS`).
- Baseline: `3e0ab2c5-5ee5-4242-8e40-a90ee8945446`; current NFT fixes, quote refresh behavior, and published lending guide preserved.
- Isolated package: `/private/tmp/turret-p2p-ux-negotiations-20260909/stage`. The existing server bundle was retained with only negotiation initialization/routing added and a separately bundled negotiation module.
- All 15,546 runtime files matched the release manifest on the running service.
- Existing request storage backed up under `/data/release-backups/p2p-ux-negotiations-20260909`. Negotiations SQLite runs on the existing `/data` volume; live read-only integrity check passed.
- Exact packaged backend passed six negotiation tests. Live desktop (1440px) and mobile (390px) intent/navigation checks passed without page errors or horizontal overflow. Eight public routes passed; unauthenticated negotiation reads return 401 with private/no-store caching and cross-origin writes return 403.
- No production wallet transactions were sent. Financial lifecycle verification remains the prior disposable-chain integration test.
- Evidence: `output/p2p-ux-negotiations-20260909/package-manifest.json`, `production-runtime-verification.json`, `live-storage-verification.json`, and `live-smoke.json`.
