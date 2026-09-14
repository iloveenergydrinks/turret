---
title: "Introducing Turret"
description: "Borrowing against Stock Tokens, the ideas we take from Liquity, and the limits of our first USDG credit vault."
date: "2026-09-02"
author: "Turret"
category: "Protocol"
cover: "/blog/collateral-loan-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of a locked coffer holding certificates, with coins and a key beside it"
draft: false
---

**Historical launch article — status note added September 8, 2026.** This article describes Turret's original September 2 vault. Current pooled borrowing uses separate interest-accruing pools with backend-managed pricing and signed approvals. P2P is a separate product with lender-funded offers and fixed repayment deadlines. Use the [current pricing guide](https://blog.turret.capital/how-turret-prices-silver-memecoins-and-stocks) and [P2P guide](https://blog.turret.capital/how-turret-p2p-loans-work) for today's model. Legacy positions remain governed by their original contracts; the historical terms and addresses below are not the current market directory.

You hold a Stock Token and want dollar liquidity without selling that position. We are building Turret for that use: deposit a supported token as collateral, borrow USDG, and repay the debt to recover your collateral. You keep exposure to the token's price while you borrow. You take on the risk of losing collateral through liquidation.

Liquity is our main inspiration. Its approach to borrowing against collateral gave us a starting point for Turret, and its straightforward borrower experience remains a reference for our interface. We have chosen owner-funded lending for the first implementation.

## The loan, from deposit to repayment

The vault owner supplies USDG before anyone can borrow it. You choose a supported Stock Token market on Robinhood Chain and deposit that token into the vault. The contract records your collateral and debt for that market under your wallet address.

You can deposit collateral and borrow in one transaction. The contract checks the available USDG, the market's debt ceiling, and the value of your collateral against its loan-to-value limit. If a check fails, the whole transaction reverts. You pay the network fee for a failed transaction, but you do not leave a deposit or a new debt behind through this combined operation.

Turret transfers existing USDG from the vault to your wallet. We do not issue or mint USDG. The owner must fund the balance that borrowers draw from, so unused borrowing capacity on your collateral does not guarantee available cash in the vault.

Your debt includes the amount you draw and an origination fee on that draw. The current contract does not accrue interest over time. Check the fee in the transaction quote; borrowing has a cost even without ongoing interest.

To close the position, you repay the full USDG debt and withdraw your remaining Stock Tokens. We provide a combined repayment-and-withdrawal operation. You can use that exit during a Turret pause without a fresh oracle price, because you clear the debt in full. You need the USDG, token approval, and network gas to complete it, and the underlying tokens must permit transfers.

## The ideas we take from Liquity

With [Liquity V1](https://docs.liquity.org/liquity-v1), you deposit ETH into a position called a Trove and borrow LUSD against it. You can see the collateral and debt in one place and manage that position without selling the ETH at the outset. That direct relationship between a position, its debt, and its liquidation conditions is the part we want Turret borrowers to understand with the same clarity.

Liquity's team made a strong commitment to [immutable, governance-free contracts](https://www.liquity.org/features/governance-free). A borrower can inspect the rules without having to follow token votes that might change the core protocol. We respect that design choice. Turret's current owner-funded vault has a different trust model: the owner can pause new activity, enable or disable markets, change debt ceilings, and withdraw unused USDG liquidity.

We build on a repository derived from Liquity's codebase, including its frontend, but our current credit vault uses a standalone lending contract. We do not deploy the inherited Liquity lending contracts for this USDG implementation. We are developing Turret as an independent project; citing Liquity as our inspiration does not imply its team's endorsement or a shared security review.

## Stock-specific limits, shared liquidity

We keep each Stock Token position separate. You cannot combine several different Stock Tokens as collateral for one loan in this implementation. We give each market its own borrowing limit, liquidation threshold, and debt ceiling.

Those controls limit exposure to a particular collateral token. They do not create separate pools of USDG. Borrowers across the supported markets draw from the same vault balance, and the owner bears losses if liquidators cannot recover enough USDG from a position's collateral. A loss in one market can reduce the capital available to lend across the vault.

The initial market configuration covers AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, ORCL, MU, and TSLA Stock Tokens. A ticker identifies the exposure; it does not establish direct ownership of company shares. You need to review the Stock Token issuer's terms and the rights attached to the token. We do not claim Robinhood endorsement.

## Borrowing leaves you exposed to price falls

Suppose you owe 4,000 USDG against collateral worth $10,000. Your loan-to-value ratio is 40%, treating USDG at its dollar denomination for this example. A fall in the collateral value to $8,000 raises the ratio to 50% without any further borrowing. These figures illustrate the arithmetic, not a recommended loan size or a particular market's limits.

If your position exceeds its liquidation threshold, a liquidator can repay some or all of your debt and receive collateral with a configured bonus. You can lose collateral even if you intended to hold the token for years. An opening limit leaves a buffer below the liquidation threshold, but it cannot protect you from a price gap.

Equity-linked tokens bring market hours and corporate actions into the borrowing process. In the vault, we validate oracle prices and reject stale or inconsistent data under the configured rules. We use two price feeds per market, allow a valid feed to serve as a fallback, and use the lower price when both feeds are valid and agree within the allowed deviation. A Stock Token oracle pause blocks price-dependent operations, including liquidation. These checks reduce reliance on bad prices; they cannot guarantee an exit during a disruption.

You retain exposure to the Stock Token issuer and to USDG, as well as to contract and network failures. Separate collateral accounting does not remove those dependencies.

## The scope of the first vault

We have kept the first implementation to owner-funded lending and collateral management. We have not implemented public liquidity-provider shares or a yield product. Liquity's Stability Pool, redemption mechanism, and governance staking are outside this vault's scope.

This article describes the implementation, not an audit result or a statement that the system is ready for unrestricted use. Before using Turret, check the deployed contract, its owner permissions, and the risk parameters for the market you choose. Our team needs an independent review of Turret's contract and deployment.
