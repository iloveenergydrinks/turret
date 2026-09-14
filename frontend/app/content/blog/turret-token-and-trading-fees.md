---
title: "TURRET: lender rewards, USDG staking rewards and buybacks"
description: "How TURRET lender incentives, USDG staking rewards and dev-wallet buybacks connect to Turret lending."
date: "2026-09-02"
author: "Turret"
category: "Token design"
cover: "/blog/fee-allocation-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of a mechanical coin sorter distributing coins into three separate trays"
draft: false
---

*Updated September 11, 2026. Staking rewards and the buyback module are deployed. Public borrower cashback opens September 11 at 17:00 UTC with a separate 1,000 USDG budget.*

Turret needs USDG in its lending pools before borrowers can use them. TURRET's first live role is to reward the lenders who supply that capital. A funded campaign now distributes TURRET to eligible lenders who stake their pool shares.

TURRET holders can separately stake their tokens to earn USDG released from a funded staking reserve. That reserve receives forwarded protocol fees and separately recorded treasury subsidies. Holding TURRET in a wallet does not activate these rewards.

## What is live and what is proposed

| Role | Status as of September 11, 2026 |
| --- | --- |
| TURRET rewards for eligible pool lenders | Live: a funded 20 million TURRET campaign across 12 pools |
| Staking pool shares to earn TURRET | Live through participating pools in Earn |
| Staking TURRET to receive USDG reserve rewards | Live through Stake |
| Token-holder governance | No finalized governance program announced |
| Dev-wallet-funded purchases and burns | Deployed; subject to wallet funds, allowance and execution checks |
| Cashback on eligible borrower interest | Public enrollment from September 11, 17:00 UTC; 50% rebate, capped at 25 USDG per wallet |

Staking pool shares earns TURRET under the lender campaign. Staking TURRET earns USDG under the separate staking reserve. Borrower cashback is a third program, based on eligible interest paid.

## How lenders earn TURRET today

The current campaign has a funded budget of **20 million TURRET across 12 pools**, running from **September 9 to September 23, 2026**. The exact start and end times are 04:34:08 UTC on those dates. Participating pools and current campaign status are shown in [Earn](https://turret.capital/earn).

The lender flow is:

1. Deposit USDG into a participating lending pool and receive its pool shares.
2. Approve and stake those shares in that pool's rewards contract.
3. Earn a proportional share of that pool's TURRET allocation while your shares are staked during the campaign.
4. Claim accrued TURRET, or unstake your pool shares.

Depositing USDG alone does not activate TURRET rewards. The shares must be staked. Your allocation depends on your share of the pool's total stake and how long you participate.

There is no staking lockup. Unstaking returns pool shares, not USDG: withdrawing dollars still depends on the pool's available cash and withdrawal rules. The shares keep their lending interest and loss exposure while staked.

You can verify the [TURRET token](https://robinhoodchain.blockscout.com/token/0x99d70a25bd7e95a30e14bcbb64752c92227de9d7) and, for example, the [AAPL pool's rewards contract](https://robinhoodchain.blockscout.com/address/0x04Db6782471a32b0edB6c88975F0a53c28C61eF2) on Robinhood Chain. This campaign applies to participating lending pools; it does not establish rewards for P2P token or NFT loans.

## Where lender returns come from

Borrowers pay USDG interest. After the protocol's fee, that interest contributes to the lending pool's assets. Lenders participate through their pool shares, which also bear losses.

TURRET rewards are a separate, temporary incentive. They can encourage lenders to make USDG available while borrowing demand grows, but they do not create borrower interest. A pool with no active loans does not generate lending interest just because its lenders receive tokens.

The campaign has a fixed budget and an end date. Its token rewards are not a guaranteed dollar return, and their value can fall. Any later campaign needs its own funded budget and published terms.

## How TURRET staking receives USDG

The fee router forwards **50% of collected protocol fees** to the TURRET staking reserve. At a pool fee of 10% of received borrower interest, 100 USDG interest allocates 90 USDG to lenders, 5 USDG to the staker reserve and 5 USDG to the treasury. The 50% share applies to the protocol fee, not the borrower's entire interest payment.

Existing pools pay their treasury first. Routing requires treasury allowance and collection; fees claimed directly from a pool need a separate treasury remittance. Paid borrower interest therefore does not necessarily become staker funding immediately.

The reserve releases approximately **1% of its remaining balance per active day**, shared among TURRET stakers. Release pauses when nobody is staked. This is reserve decay, not a 1% daily return on the value of a person's stake. Actual rewards depend on reserve funding, total stake and participation time.

Stake, withdraw TURRET and claim USDG are separate actions. Withdrawal requires a later observed parent-chain block than the latest stake or top-up. Earned rewards and protocol-fee funding are protected from treasury recovery; only unreleased subsidy can be recovered.

Use [Stake](https://turret.capital/stake) to check the current reserve and your rewards. The [staking contract](https://robinhoodchain.blockscout.com/address/0xd13A10798a7604Ae69433be8e50750264cf4d52C) and [fee router](https://robinhoodchain.blockscout.com/address/0xe4D13090207bf06a6C17B340292E320afe720144) identify the deployed mechanism.

## Buybacks and borrower cashback

The [buyback module](https://robinhoodchain.blockscout.com/address/0x3adA2ce3c417f2991557C7412Ce910ec0454C8E9) spends USDG from the dev wallet to purchase and burn TURRET. Its hourly budget is configured as 6.7% of the wallet balance above a 100 USDG reserve, subject to allowance and execution limits. Wallet funding is not necessarily identifiable lending profit. A budget or an elapsed hour does not itself prove that a purchase executed.

The public borrower campaign returns 50% of eligible interest paid in USDG, up to one shared 25 USDG cap per wallet across its 13 supported markets. Its 1,000 USDG escrow supports 40 reservations, first come, first served. Join before borrowing; eligible accrual ends October 11 at 17:00 UTC. See the [campaign terms](/borrow/cashback-terms) for settlement and claim deadlines. This uses separate escrow funding: retaining 5 USDG from 100 USDG of interest does not fund a 50 USDG rebate. Lender returns, staker routing and already earned rewards are unchanged. No borrower rebate is promised before a funded enrollment is confirmed.

Earlier token trading-fee and 60/25/15 allocation proposals do not describe the current lending fee split. Token-holder governance is not established by staking, lender rewards or buybacks.

## Borrowing stays independent of TURRET

Users do not need to hold TURRET to borrow, supply USDG, repay debt or recover their remaining collateral under the loan's rules. Holding or staking TURRET does not grant access to lenders' principal or borrower collateral.
