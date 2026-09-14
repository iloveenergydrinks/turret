# TURRET staking implementation context

Status: deployed, strictly verified and activated on production on 9 September 2026. The treasury approved a bounded 100 USDG allowance; the gas-funded collector runs automatically in execute mode. The active frontend is https://turret.capital/stake. See [deployment-handoff.md](deployment-handoff.md) and `output/turret-staking-live-20260909/activation-status.json` for exact deployments and verification evidence.

## Confirmed direction

The user selected Liquity V1-style staking of TURRET with USDG fee rewards, with 50% of protocol fees distributed to stakers and 50% retained by the treasury. Current listed pools charge 1,000 bps of received interest. Thus 100 USDG interest produces 90 USDG lender entitlement, 5 USDG staking allocation, and 5 USDG treasury allocation. No new loan fee or TURRET emission is introduced.

## Existing system

- Chain: Robinhood Chain, 4663.
- TURRET: 0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7 (18 decimals).
- USDG: 0x5fc5360d0400A0FD4f2aF552AdD042d716F1d168 (6 decimals; verify at deployment).
- Pool revenue recipient: 0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086.
- Lender campaign administrator is a different address: 0xD6Db8d5d228f8D381F2D1bBbFb41fDE73696735C. It must not be substituted for the revenue recipient.
- Production /borrow-pools.json lists 13 pools. All reported revenueFeeBps=1000 and protocolFees=0 at block 58,805,764 in this task. This is not a lifetime-revenue measurement.
- DockyardIsolatedCapitalPool.repay sets aside fees only after receipt of USDG. claimRevenue sends accumulated protocolFees to immutable feeRecipient. Existing pools cannot be retargeted.
- Existing TurretLenderRewards contracts hold pool shares and emit TURRET during fixed campaigns. They do not stake TURRET and must remain separate.
- Inherited StakeScreen implements Liquity V2 governance and LQTY/LUSD/ETH assumptions. Interfaces and mocks do not provide TURRET staking.

## Architecture

A new immutable fee router deploys a dedicated TURRET staking contract. Its fixed allowlist consists of verified pools whose asset is USDG and feeRecipient is the confirmed treasury. Anyone may collect an allowed pool's revenue; the router measures the exact increase in treasury USDG, then pulls only the staking half using treasury allowance. The retained half never leaves the treasury. All steps revert together if collection, approval, or reward funding fails. External callers cannot choose a recipient or pull arbitrary treasury balances.

The router requires a nonzero stake before collection. With no stake, it leaves fees unclaimed in the pool; it does not create an unallocated reward pot or change the 50/50 split. Rewards belong to stakes present at distribution, including fees received by a pool earlier. This follows instantaneous fee allocation, not weekly time weighting. Short-lived stakes can participate in a distribution; a stake or top-up delays withdrawal until the next observed Ethereum parent block to prevent same-block stake/collect/exit round trips. There is no ongoing lockup, warmup or time weighting.

The staking contract checkpoints balances before stake changes, accepts rewards only from its router, and transfers USDG in before allocating a reward. Claims and TURRET withdrawals are independent; a USDG transfer failure must not block withdrawal of TURRET. No administrator may seize stake or accrued rewards. Rounding is conservative and funded reward liabilities remain backed.

The treasury can still call existing pool.claimRevenue directly and can revoke the router's allowance. Existing pool contracts do not enforce forwarding. Fees claimed outside the router can be forwarded through treasury-only forwardClaimedFees(grossFees). Its amount is treasury-reported, not proven historical revenue; separate counters/events distinguish it from measured pool collection. This dependency must be explicit in the app and deployment handoff; a permissionless router is not autonomous control of an EOA treasury.

## Frontend

Extend the existing /stake surface using Turret's established warm-paper, charcoal, Caslon heading, system-sans controls and flat financial panels. Provide stake, partial unstake and USDG claim, with balances, proportion of stake, actual funded distributions, exact amount approval, transaction review, receipt verification, persistent recovery, wrong-chain/account invalidation, and no fixed APY. Keep TURRET lender campaigns separate. No deployed manifest means an explicit not-active state and no wallet transaction controls.

## Verification boundaries

1. Public stake, unstake, earned, claim and funding interfaces, including rounding and adversarial tokens.
2. Real pool -> treasury -> router -> staking distribution, including unauthorized pool rejection and atomic allowance failure.
3. Browser wallet approval, staking, withdrawal, claim and recovery boundaries with exact transaction checks and account/network changes.

The completed pre-audit review is recorded in [audit-readiness.md](audit-readiness.md). Withdrawal eligibility is now read through canUnstake, using the contract clock on Robinhood Chain; incoming transfers check both sender debit and recipient credit.

## Reference

Liquity V1 source: https://github.com/liquity/dev/blob/main/packages/contracts/contracts/LQTY/LQTYStaking.sol
Liquity V1 staking behavior: https://docs.liquity.org/liquity-v1/faq/staking

We reuse the reward-per-token mechanism, not Liquity's LQTY token-specific transfer function, automatic reward transfer on unstake, governance, or ETH rewards.
