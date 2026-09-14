# TURRET staking deployment handoff

Implementation status: live at https://turret.capital/stake. Router `0x74E55d09077feb5B6a747AB3E06002ef12E547b4` and staking `0xc9E76653ff39eB1083581480480571c3Bc6A108F` are deployed and strictly verified. The treasury approved 100 USDG, and the deployer funded the collector with 0.0002 ETH. The collector is running in execute mode; the verified manifest is published. See `output/turret-staking-live-20260909/activation-status.json`.

## What this version does

Users approve an exact amount of TURRET, stake it, withdraw any portion after the contract observes a later Ethereum parent block than their latest stake or top-up, and claim earned USDG separately. A cumulative reward-per-token index allocates actually funded fees to balances staked at distribution. Repeated claims and stake changes retain fractional USDG entitlements. The contract cannot mint rewards, slash stake, redirect claims, or let an administrator sweep deposited TURRET or allocated USDG.

The immutable router covers the 13 pools in `contracts/rewards/config/staking-pools.json`. `collect(pool)` measures the pool's USDG payment to its fixed treasury and pulls half of that payment into staking. The treasury keeps the other half. Odd USDG base units carry across collections so the cumulative staking share equals floor(total gross fees / 2). Treasury allowance is required. If funding fails, the entire pool collection reverts.

At the current pool fee, 100 USDG of paid borrower interest yields 90 USDG to lenders, 5 USDG to TURRET stakers, and 5 USDG retained by the treasury.

## Existing-pool constraints

`claimRevenue()` on existing pools is permissionless and always pays the immutable treasury. Anyone can invoke it outside the router, including by front-running a collection. Those externally claimed fees require the treasury to call `forwardClaimedFees(grossFees)` with a reconciled gross amount and sufficient allowance. That function also forwards half and retains half. Its gross amount is treasury-reported, not an on-chain proof of historical fee revenue; the router records it separately from directly measured pool receipts.

The treasury can revoke allowance or decline forwarding. This implementation cannot remove that dependency from existing immutable pools. The user accepted automated collection for the current pools on 9 September 2026. A dedicated collector is active with a persistent journal and bounded gas spending; see [operations.md](operations.md) and `output/turret-staking-live-20260909` for its activation status. Collection can also be called by any keeper, operator or user after approval. New pools require a separately reviewed router/staking deployment because this allowlist is fixed.

With no stake, router collection and forwarding revert without moving funds. Fees stay in pools or treasury until a distribution can occur. Stakes present then receive the distribution, even if the borrower paid interest earlier. Instantaneous allocation permits short-lived stakes around distributions; withdrawals wait until a later observed Ethereum parent block than the latest stake or top-up. This prevents same-block stake/collect/exit round trips but does not prevent all short-term fee capture. There is no ongoing lockup, warmup or time weighting.

Directly transferring tokens to the staking contract is not staking or reward funding. Unsolicited donations and conservative global rounding dust have no sweep function. Reward-token failures do not block TURRET withdrawals, but TURRET's own transfer restrictions still apply.

## Known identities

- Network: Robinhood Chain, 4663.
- TURRET: `0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7`, 18 decimals.
- USDG: `0x5fc5360d0400a0fd4f2af552add042d716f1d168`, 6 decimals.
- Pool treasury: `0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086`.
- The lender campaign administrator is a different wallet and is not the pool treasury.

The initial live context snapshot is `output/turret-staking-20260909/context-snapshot.json`. It includes block/hash, token runtime hashes and all pool identities/fees. It must not be confused with current revenue or a deployment manifest.

## Reproduce verification

Run Foundry commands from `contracts/rewards` consistently and preserve the resulting artifacts for deployment verification. Automatic discovery of unrelated library remappings is disabled so compiler metadata uses this package’s explicit imports. The verifier rejects mismatched artifacts, including metadata, rather than relaxing its bytecode comparison.

```sh
cd contracts/rewards
forge build --force
forge test --match-contract 'Turret(StakingSafety|FeeRouter|Staking)Test'
forge test --match-contract TurretStakingInvariantTest
STAKING_FORK_RPC=https://turret.capital/api/rpc forge test --match-contract TurretStakingForkTest
```

The live-pool fork test uses real deployed token and pool code. It funds balances and impersonates accounts on the local fork, and substitutes the engine's market-availability response to isolate the pool accounting boundary. It is not a production borrower-lifecycle test and sends no production transactions.

From `frontend/app`:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm exec vitest run src/staking src/lending/rewards
NODE_OPTIONS=--no-experimental-webstorage pnpm exec next build
```

The Node option avoids Node 26's experimental global Web Storage interfering with jsdom; it does not change browser behavior. Wallet-flow tests use the real staking client and transaction coordinator against external RPC/wallet fixtures, not production signatures.

## Final local evidence

The subsequent pre-audit review found and fixed the chain-clock UI bug and sender-surcharge gap. Use [audit-readiness.md](audit-readiness.md) and `output/turret-staking-audit-20260909` for the current source fingerprints, 44 contract checks, two stateful invariants, 52 frontend checks, and corrected local deployment verification. The earlier counts below record the initial implementation revision.

- 33 contract checks passed, including the staking fork test and a 1,000-run invariant with 500,000 operations and zero unexpected reverts. One existing lender-rewards fork test was skipped because its separate RPC variable was unset.
- 51 frontend checks passed: 17 staking checks and 34 existing lender-reward checks. The production build completed with 102 generated pages.
- A deployment on local Anvil passed strict runtime/metadata, immutable identity and all-13-pool verification. A forced rebuild resolved stale artifacts; no bytecode comparison was weakened.
- Desktop/mobile UI finish review passed. Preview balances are illustrative.

The final logs, source hashes, local-only candidate and preserved deployment artifacts are in `output/turret-staking-20260909`. `verification-summary.json` indexes the results. Local addresses must never be promoted to the production manifest.

## Deployment and activation

1. Review the final contract source, pool list and evidence. These tests and the UI finish review do not constitute an independent smart-contract audit.
2. Run `forge build --force` from `contracts/rewards` to remove stale artifacts from earlier compiler settings. Choose the deploying wallet. Set `STAKING_DEPLOYER` to its public address. From `contracts/rewards`, run `forge script script/DeployTurretStaking.s.sol:DeployTurretStaking --rpc-url YOUR_RPC` without broadcast. The script checks chain, token code/decimals, pool code and current pool fee before constructing the router and staking contract.
3. For an authorized production deployment, use the selected encrypted Foundry account with the same reviewed command and `--broadcast`. Keep private keys out of source, environment logs and command arguments. The script does not grant treasury approval or move stake/rewards.
4. Preserve the compiled artifacts from that deployment. From `frontend/app`, run `pnpm exec tsx scripts/staking-inspect.ts ROUTER_ADDRESS DEPLOYMENT_BLOCK OUTPUT_JSON`. It verifies deployed runtime including metadata, immutable token/router identities, all 13 pools and the 50/50 split. It only writes a candidate manifest and unsigned call data.
5. Have the pool treasury approve USDG to the verified router with an explicitly chosen operating cap. The inspection output includes a snapshot-sized allowance; if fees are zero it is zero and must not be mistaken for an enabled distribution allowance. The router can spend only the calculated share of observed receipts, or a remittance explicitly initiated by the treasury. Allowance can be revoked.
6. Copy only the verified `manifest` object into `frontend/app/src/staking/deployment.json`, rebuild and publish the frontend through the normal release process. A local-fork manifest is never valid for this step, even though the fork reports chain ID 4663.
7. Verify the published staking page's wallet connection, exact-amount approval, stake, claim and unstake against the final deployed addresses. Monitor `RevenueDistributed`, `ClaimedFeesForwarded`, `FeesDistributed`, and treasury allowance. Reconcile direct pool revenue claims separately so their gross fees are not counted twice.

Production activation completed on 9 September 2026. The user signed contract deployment, the 100 USDG treasury allowance, and 0.0002 ETH collector funding. All three receipts were verified against exact intended transaction contents and canonical blocks before activation. The frontend release is `75f97263-ce16-4292-8a95-1142c037a792`; collector release is `4f0040be-1e29-47df-9ba0-be4210b9272c`. The frontend runtime files and public assets match the curated release manifest, with the existing /data mount retained. Live staking reads and navigation passed; wallet transaction paths were verified using fixtures, without submitting a user stake as a smoke test. The initial state is zero stake and zero funded USDG, and the collector reports `no_stakers`.

Evidence: `output/turret-staking-live-20260909/activation-status.json`. The original pre-audit archive remains unchanged; activation is additional deployment evidence, not an independent audit. Local Anvil receipts also report chain ID 4663 and remain explicitly local-only.

## Current frontend release

The platform consistency correction is live in deployment `79aa8467-afd3-49b9-b925-fbbe12b9771a`. Staking now reuses Earn’s page frame, illustrated header, shared controls and footer. All 20,418 packaged runtime files and 103 public assets were verified; 18 staking interaction tests passed. Contracts, fee routing and collector configuration are unchanged. Evidence: `output/turret-staking-ui-20260909/release.json`.

Staking’s vault engraving is live in deployment `5ca0caa1-bd3b-4144-91ad-8d08dc91020b`. The source uses a staking-scoped artwork override; Earn retains its tree. All 20,596 runtime files, four staking routes, the new image and stylesheet were verified. Evidence: `output/turret-staking-art-20260909/release.json`.

The recorded USDG counter is live in deployment `390bb7e7-fefa-49fb-bfb6-68c52103063e`. It distinguishes pending paid-interest fees from claimable rewards and refreshes every 20 seconds. Contract and collector behavior are unchanged. Runtime files and 103 public assets were verified; 28 staking checks passed. Dev-wallet balances and funding budgets are not published in the staking UI. Evidence: `output/turret-staking-counter-20260909/release.json`.
