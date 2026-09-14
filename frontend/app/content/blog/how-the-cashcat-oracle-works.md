---
title: "How Turret values your CASHCAT"
description: "Where your CASHCAT borrowing price comes from, why it can differ from an exchange, and what it means for your loan."
date: "2026-09-05"
author: "Turret"
category: "How it works"
cover: "/blog/cashcat-valuation-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of a cat-emblem coin on an assay balance with several reference weights"
draft: false
---

*Updated September 9, 2026.*

You can use your CASHCAT as collateral to borrow USDG on Turret. You keep exposure to CASHCAT's price while accessing funds, but your tokens secure the loan and can be sold if it becomes unsafe.

The price Turret gives your CASHCAT matters. It helps determine how much you can borrow and how much room your loan has before liquidation. Here is what you need to know about that price.

## Where does the price come from?

Turret compares CASHCAT prices across several exchanges, including Gate, MEXC and KuCoin. It also checks prices in the onchain markets used to sell CASHCAT if a loan needs to be liquidated.

These checks look for a recent price that the different markets broadly agree on. Turret also accounts for the market value of USDG, because that is the currency you are borrowing.

CASHCAT now uses Turret's central pricing backend. It checks the evidence and signs a short-lived approval for your requested action. The contract verifies that approval and enforces collateral coverage, accounting and caps; it does not fetch exchange prices itself.

The pricing signer is trusted. A valid signature does not independently establish that its price is correct. Incorrect or compromised signed prices can cause losses.

## Why might it differ from the price I see elsewhere?

An exchange or price-tracking app may show the price of the last trade. Turret compares several markets and recent price history, then uses a cautious valuation for your collateral.

For example, you might see CASHCAT at 0.20 USDG elsewhere while Turret values it at 0.195 USDG. Your borrowing limit would use Turret's price. This is an illustration, not a current quote.

That approach helps avoid offering a larger loan based on a price that other markets do not support.

## What happens if CASHCAT falls?

Your debt does not shrink when CASHCAT's price falls. The same loan is then backed by less collateral value, bringing it closer to liquidation.

When both exchange prices and the onchain market confirm a fall, Turret can reflect it promptly. An older, higher price should not be treated as extra time to repay.

Check your position's risk meter and estimated liquidation price. Repaying part of your debt or adding collateral can give your loan more room. Borrowing below the maximum also leaves a larger buffer, though it cannot remove liquidation risk.

## Why does borrowing sometimes show as unavailable?

Turret may be unable to accept a price because a source is delayed, markets disagree or there is too little trading liquidity. New borrowing then stops until the required checks pass again.

A fresh displayed reference does not mean every borrowing check passed. The source's update time and the time Turret last checked it are different: checking an old observation again does not make it fresh. Operator pauses, pool capacity and service readiness can also block borrowing.

A quote can also expire while you are confirming it in your wallet. If that happens, return to the borrowing page and get a fresh quote before trying again.

For an existing loan, an unavailable price does not cancel your debt or stop interest. You can still repay and close the loan as long as the network and tokens are working. Price interruptions can also delay liquidations; they do not make an unsafe loan safe.

## Who runs the price service?

Turret runs it. We use several price sources and onchain checks, but the service still depends on Turret and its data providers. The CASHCAT system has not had an independent audit, and these checks cannot guarantee against losses.

Before borrowing, review the amount you will owe and the estimated liquidation price shown for your position. Choose an amount that leaves you room for CASHCAT to move.

This guide describes pooled CASHCAT borrowing. [P2P loans](https://blog.turret.capital/how-turret-p2p-loans-work) use lender-agreed terms and default after a repayment deadline, without price-triggered liquidation. CASHCAT is a fungible token. The separate [NFT lending page](https://turret.capital/borrow/nfts) supports Cash Cats NFTs through P2P loans; the stock Chainlink policy does not replace the multi-source CASHCAT pricing described here.

[See your CASHCAT borrowing options](https://turret.capital/borrow?engine=0xC29907317d8e78E9f6455F22577361b5184b449e).
