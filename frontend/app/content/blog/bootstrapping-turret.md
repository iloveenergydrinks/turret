---
title: "How Turret will bootstrap its lending markets"
description: "Our plan to supply USDG across the first Stock Token pools and use fixed Turret token rewards without disguising them as lender yield."
date: "2026-09-04"
author: "Turret"
category: "Protocol"
cover: "/blog/seed-liquidity-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of a hand planting a coin beside three seedlings in separate pots"
draft: false
---

Turret’s pooled loans use USDG deposited into the relevant collateral market. An AAPL borrower draws from the AAPL pool; an NVDA borrower draws from the NVDA pool. Interest and losses remain inside that market.

This gives lenders control over their collateral exposure, but it creates a launch problem. Borrowers need USDG before they can borrow. Lenders need active loans before they earn interest.

Turret will bridge the gap with its own USDG, small debt limits and a staged launch. A fixed Turret token reward program may support early lenders once its contracts and terms are ready. Over time, borrower interest must support lender returns.

**Scope update — September 9, 2026.** This funding plan concerns pooled Borrow and Earn. P2P offers reserve the individual lender's USDG separately; they do not draw on pool deposits. NFT lending is available through a separate P2P contract, with Cash Cats enabled in the current app. It does not draw on pool deposits. The proposed token rewards and larger funding allocation below are plans, not a statement that they have launched. A borrowing cap is a limit, not a funded balance.

## Why Turret needs seed liquidity

Liquity created LUSD when a borrower opened a collateralised position, so each loan did not require pre-funded dollars. Its Stability Pool backed liquidations, while a fixed LQTY schedule attracted early Stability Providers and LUSD liquidity providers. [Liquity published the allocations and schedule before launch](https://www.liquity.org/blog/liquity-launch-details).

Turret lends existing USDG. Each dollar available to a borrower must enter the relevant pool first. Deposits provide cash, while the market's debt cap limits its use. Turret will provide the initial capital.

## Turret goes first

We have supplied a small amount of USDG for canary testing. It supports small production transactions and lets us test the loan lifecycle with live contracts.

After those tests pass, Turret will supply 10,000 USDG across the initial Stock Token pools. We will publish the allocation before funding them. Market readiness, demand and liquidation capacity will determine the split.

Turret receives pool shares under the same rules as other lenders. Our capital is not a first-loss tranche. A liquidation shortfall can reduce every share's value.

Before larger public deposits open, we will publish Turret's allocation, the address holding its shares, each debt cap and the withdrawal terms for our seed liquidity. Users will be able to verify them onchain.

## Fund every initial pool without spreading capital blindly

Each initial pool will receive part of the 10,000 USDG commitment. We expect AAPL to receive a larger allocation because it has Turret's longest operating history. Other limits will reflect their market data, liquidation capacity and demand.

We will raise a market's debt cap and its supplied USDG together. Four checks govern each increase:

1. Borrowers have used and repaid the current capacity.
2. The oracle and liquidation worker have stayed healthy through the relevant trading sessions.
3. Liquidation, collateral sale and recovery work at the new position size.
4. The debt cap remains within Turret's launch loss budget.

We can move new Turret funding toward pools that borrowers use while keeping the risks isolated. Existing lender deposits remain in the market they selected. We will not move user funds between pools.

## Where lender returns come from

Borrowers pay the rate displayed for their market. The pool sends Turret its protocol fee and adds the remaining interest to pool assets. Lender shares represent a fraction of those assets.

Utilisation determines the lender rate. A pool with no loans produces no borrower interest. The displayed rate remains an estimate because utilisation changes and liquidation shortfalls can reduce share value.

The Earn interface will show the figures needed to judge a pool:

- USDG available to borrow
- outstanding debt and utilisation
- the borrower interest rate and protocol fee
- estimated lender rate at current utilisation
- market debt cap and remaining capacity
- Turret's own supplied liquidity

We will show the rate produced by current utilisation instead of advertising a theoretical maximum APY.

## A limited role for the Turret token

Turret tokens can compensate early lenders while borrowing develops. Borrower revenue must sustain the market after incentives end.

The proposed program will use a fixed allocation and a separate distribution contract. The contract will define its dates, maximum allocation and pool weights. Lenders will accrue rewards from time-weighted shares and claim them from the contract. Turret will not calculate rewards in a spreadsheet or send discretionary payments.

If we launch through Pons V2, the developer buy goes to the creator wallet. We will transfer the published reward allocation into the distributor before rewards begin and publish that transaction. Pons V2 fixes important terms at creation, so we must verify the fee, supply, recipient and buyback settings before launch. [Pons V2 documents these mechanics](https://docs.ponsfamily.com/v2).

Turret token rewards carry price and liquidity risk. Their dollar value can fall, and a lender can lose money through a pool shortfall despite receiving tokens. The interface will separate USDG interest from Turret token rewards.

The program ends on its published schedule. Any later allocation will need its own budget and public terms.

## The launch sequence

Turret is in open beta with small pool limits. Testing and monitoring cover borrowing, repayments, closures, withdrawals, price failures, alerts and liquidation recovery. The 10,000 USDG allocation described here remains a funding plan; this update does not report that it has been deposited. We will publish the allocation and funding transactions before treating that commitment as supplied capital. We will increase a market's cap only after its transactions and monitoring match the onchain state.

Public access is available with market limits enforced by the contracts. We will publish incidents and contract changes. Turret token incentives begin after review of the distribution contract, allocation and token terms.

The bootstrap succeeds when active loans attract lenders through borrower interest without new Turret token issuance. Until then, our USDG funds the first loans and debt caps contain the risk.
