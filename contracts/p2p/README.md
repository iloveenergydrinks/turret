# Turret direct loans

This is a separate fixed-term P2P lending implementation. It has no access to Turret's existing Borrow or Earn pools. The wallet-connected interface performs real approvals and transactions; balances and loan state come from the configured contract. It has automated contract tests, browser transaction tests and an internal code review, but **no external audit**.

As of the repository registry reviewed on 7 September 2026, Robinhood chain 4663 has **19 configured V2 markets plus the original V1 SLV pilot**. The current market identities, deployment blocks, token pairs and expected runtime hashes are recorded in [`frontend/app/public/p2p-markets.json`](../../frontend/app/public/p2p-markets.json). V2 permits any funded lender to create a public offer or an offer for one named borrower, with custom whole-day terms and no economic principal, interest or shared commitment caps. Registry entries identify configured contracts; they are not an external audit or a statement about current balances.

The legacy V1 market is `0xc79e3d2a66265c92e721def2162efdc21bdacfa7`, created in transaction `0xba893a8161db67e1f2263c5acf390d9ad40530dcb222902ba4f06772c819895e`, block 56327886. It retains its approved-lender restriction, named borrowers, 100 USDG per-loan cap and 1,000 USDG commitment cap. Its existing loans and withdrawal credits remain in that immutable contract. Historical pilot deployment evidence is under `output/p2p-loans/production/`; the pilot website evidence and verification report are under `output/p2p-loans/frontend-wallet-receipts/` and `output/p2p-loans/VERIFICATION.md`. Those artifacts describe the pilot, not the complete current V2 release. The website route is `/p2p`.

In both versions, the borrower either repays the exact agreed amount by the final deadline or forfeits the entire agreed collateral. Each deployed contract has one immutable loan token and collateral token. There is no price-triggered liquidation or sale. Public V2 offers bind their borrower when accepted; private V2 offers and V1 offers name the borrower when created.

## Run the checks

From the repository root, using the existing Foundry and frontend dependencies:

```sh
forge test --root contracts/p2p
node contracts/p2p/scripts/local-lifecycle.mjs
```

The second command starts a fresh Anvil on a local port, deploys mock tokens and the escrow, executes actual local transactions, verifies balances and liabilities, and stops Anvil. It accepts no external RPC or wallet key. Its mock token refuses deployment outside chain 31337. Test addresses and synthetic money are not real users or assets.

Optional production-token compatibility tests live in `fork-test/RealTokenFork.t.sol`. The task-specific runner `output/p2p-loans/run-real-token-fork.mjs` uses the existing private read-only RPC abstraction, pins a canonical block, and writes sanitized evidence. The new escrow exists only inside the local fork. No balances are minted or token storage altered; account impersonation and deadline time travel are local only. This is point-in-time compatibility evidence, not certification of token issuers or future upgrades.

The current public registry is checked in at `frontend/app/public/p2p-markets.json`; `frontend/app/public/p2p-deployment.json` retains the legacy pilot fallback. Local E2E servers supply their own guarded chain-31337 configuration.

The UI route `/p2p` uses `frontend/app/src/p2p/client.ts` to verify chain identity, deployed runtime hash, token addresses and decimals. It reads chain state, requests exact approvals, simulates actions, sends wallet transactions and checks canonical receipts. It retains known pending hashes for reconciliation and clears displayed positions when the connected account or network changes. RPC errors disable further writes until state can be refreshed. The earlier simulated UI is archived and is not routed or included in the production bundle.

For browser E2E, `output/p2p-loans/e2e/fixture-server.mjs` starts a fresh local Anvil and deploys real test escrow/token contracts. `browser-results.json` records 15 checks, 22 successful browser-submitted transactions and their receipts, plus source and served-build hashes. A test-only EIP-1193 bridge signs for unlocked Anvil accounts; it is not shipped with the product. The tests cover rejected wallet requests, funding, acceptance, repayment, default, withdrawals, cancellation, expiry, pauses, wrong networks, invalid deployment configuration and RPC failure states on desktop/mobile. Three further browser regressions mine actual same-nonce cancellation, different-call and gas-repricing replacements. Twenty-five client tests and four UI tests also cover originating-account changes, receipt identity, pending-state retention and exact approvals.

## Current V2 behavior

| Step | Behavior |
| --- | --- |
| Fund offer | Any funded lender deposits the entire USDG principal for a public offer or one named borrower. |
| Terms | Exact raw token collateral, principal, fixed interest, duration and offer expiry. No later amendments. |
| Offer expiry | A future timestamp within the contract's numeric deadline bounds. Acceptance requires a timestamp strictly before expiry. |
| Cancel or expire | Unaccepted principal becomes a withdrawal credit for its lender. Anyone may expire an expired offer; only its lender may cancel, including after expiry. |
| Accept | A public offer's first eligible taker, or the private offer's named borrower, deposits exact collateral and receives principal atomically. The lender cannot accept their own offer. The loan term starts now. |
| Duration | Any positive whole number of days within the numeric deadline bounds, followed by an explicit 24-hour grace period. |
| Repay | Full principal plus the fixed interest, including for early repayment. Allowed through the inclusive final deadline. Anyone may pay using their own funds. |
| Repayment settlement | Lender receives a USDG withdrawal credit; borrower receives their collateral credit. Recipient transfers are separate from debt settlement. |
| Default | Strictly after the final deadline, anyone may settle. All collateral is credited to the fixed lender; no further USDG debt remains. |
| Withdraw | Only the credit owner may withdraw their credits, to a valid chosen recipient. Active principal is not withdrawable. |
| Pause | Guardian may stop new offers and acceptances. Repayments, refunds, default settlements and withdrawals remain callable. Token issuer restrictions may still prevent transfers. |

V2 enforces numeric overflow and representable-timestamp bounds, rather than economic size or interest caps. V1 retains its original 7/14/30-day durations, at-most-one-hour offer expiry, 100 USDG per-loan cap, 1,000 USDG commitment cap and 10% maximum total fixed interest relative to principal. The V1 interest limit is not an APR, recommendation or safety guarantee. V2 does not inherit these pilot limits, and neither version guarantees the collateral's value.

## Contract boundary

- Loan token, collateral token and guardian are fixed at deployment. V1 additionally fixes an approved lender list and principal limits; V2 has neither. No proxy, upgrade, asset rescue, arbitrary call, pool adapter or administrator custody powers.
- Accepted loan terms cannot be changed. No refinancing, partial fills, partial repayment, transferable loan NFTs, auto-renewal, swaps, shared loss allocation or borrowing from existing pools.
- Both versions track funded open offers plus active loans in `committedPrincipal`. Only V1 limits that total. Settled withdrawal credits are excluded from committed principal but remain custody liabilities, so a V1 commitment cap does not cap every token held by the contract.
- V1 lender admission remains restricted; V2 admits funded lenders without a shared capacity limit. Permissionless default settlement assigns collateral to the recorded lender even if that lender does not return to settle the loan.
- Exact sender and recipient balance checks reject transfer-fee or unexpected-transfer behavior. All state-changing entry points are reentrancy guarded. Accounting changes and failed transfers revert atomically.
- Repayment pulls funds only from the caller, never silently from the named borrower. Separate withdrawal credits prevent a blocked lender recipient from preventing debt settlement.
- Collateral uses raw ERC20 units. SLV's displayed underlying-share multiplier must not be used as the transfer amount. Unqualified rebasing, fee, callback or externally mutable tokens are not automatically supported merely because they expose ERC20 methods.

## Economic limits users must understand

A collateral claim is not USDG repayment. If collateral loses value, a borrower can choose to default and the lender may lose principal. Illiquid collateral can be difficult to sell even after a successful claim. No oracle dependence removes one operational dependency; it does not remove credit or market risk. A borrower who misses the final deadline forfeits **all** collateral, even when it is worth much more than the debt. Any surplus-return auction would be a different, more complex product.

Funds are committed for the term and may be recovered as collateral instead of cash. There is no guaranteed return, withdrawal date in USDG, instant lender exit or pooled backstop. Display the exact repayment amount, fixed fee, due date, final deadline and collateral forfeiture before acceptance. Reminders are helpful but do not change the contract deadline. Network outages can prevent timely repayment and require consideration before selecting a live grace period.

An immutable escrow cannot neutralize an underlying token issuer's freeze, pause, burn or upgrade powers. A successful current fork test does not resolve these future risks. Contracts on the same chain still share chain outages; shared code can repeat a bug across deployments even when accounting is separate.

## Wider rollout

1. Compare a pinned PWN release against this smaller direct-loan model. Prefer an existing reviewed deployment where it actually exists and fits the token/chain requirements. PWN's published deployment list currently does not include Robinhood 4663. A new deployment or fork requires reviewing its bytecode, dependencies, configuration and administrative permissions; it does not inherit blanket audit approval.
2. Choose and qualify the exact loan and collateral tokens, issuer privileges, transfer units and intended borrower/lender addresses. Select collateral and term limits from loss/default scenarios. Begin with collateral lenders are willing to own; do not label SLV safe just because no sale occurs at default.
3. Freeze the chosen contract implementation, independently review it, resolve findings, and rerun unit/fuzz/invariant, real-token fork and browser transaction tests against the exact release artifacts.
4. Retain the implemented wallet interface's explicit chain/address/runtime-hash binding, exact approvals, receipt reconciliation, canonical receipt checks, chain-time deadlines and stale-read protection. Offers are scanned in bounded pages from the contract; loading older offers is explicit. A future indexer must be verified against contract state. Preserve a direct repayment/withdrawal path if the hosted site is unavailable or gated.
5. Run a small restricted pilot, validate actual repayment/default/withdrawal transactions, monitor outstanding escrow liabilities and token changes, and publish the precise risk terms. Expand funded loans and lender admission only after the pilot and economic review justify it. Funding alone does not create borrower demand or make collateral safer.

No token launch, pooled liquidity migration or existing pool cap change is needed for this feature.

## References checked for this design

- [PWN protocol and published deployments](https://github.com/PWNDAO/pwn_protocol): bilateral lending reference; not a certified Robinhood deployment.
- [PWN audit index](https://dev-docs.pwn.xyz/audits/): audit assurance applies to reviewed versions and scope.
- [Ackee's PWN review](https://ackee.xyz/blog/pwn-audit-summary/): refinancing complexity produced serious bugs in earlier code; those findings were mitigated.
- [Robinhood stock-token integration](https://docs.robinhood.com/chain/building-with-stock-tokens/): raw balances stay fixed when the displayed multiplier changes.
- [OpenZeppelin security utilities](https://docs.openzeppelin.com/contracts/4.x/api/security): reentrancy protection and separate withdrawal patterns.

The implementation is newly written and uses the repository's existing OpenZeppelin dependencies. It does not copy PWN contract source or claim PWN audit coverage. PWN reuse would require a separate license and dependency review.
