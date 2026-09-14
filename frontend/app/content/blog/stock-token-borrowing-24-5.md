---
title: "Extending Stock Token borrowing to 24/5"
description: "Nine Stock Token markets now support extended sessions, with fresh price checks, collateral-sale checks and small initial borrowing caps."
date: "2026-09-05"
author: "Turret"
category: "Product update"
cover: "/blog/extended-sessions-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of an astronomical clock with sun and moon marking day and night"
draft: false
---

*Updated September 9, 2026. This article covers the nine individual stocks; SPY and QQQ have a separate weekend policy.*

Turret supports conditional 24/5 pooled borrowing against AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU and TSLA Stock Tokens. New loans can qualify during overnight, premarket, regular and after-hours sessions when the market's safety checks pass.

On September 9, we changed the stock-price policy to use the existing Chainlink token-price feeds as the primary reference, with a 24-hour freshness limit. Missing or stale Alpaca trades no longer reject an otherwise valid loan. Fresh price disagreement, corporate-action checks and liquidation readiness remain enforced.

Borrowing lets you retain exposure to a Stock Token while accessing USDG. The deposited tokens secure the loan and can be lost through liquidation.

## Which price determines borrowing value?

The primary reference comes from the stock's configured Chainlink token-price feed. Its observation must be valid and less than 24 hours old. Reading the feed again does not make its timestamp newer. Turret also accounts for USDG's market value and applies the market's remaining valuation and collateral-sale checks.

A token-price feed already reflects the token's scaling. Turret does not apply that scaling a second time to the primary price. When comparing a raw stock-market price with the token reference, it converts that stock price using the issuer's current multiplier.

Chainlink feeds can update when prices move enough or when their heartbeat is reached. A reference need not change every few seconds to remain valid. Off-hours updates can be limited; the 24-hour cutoff still applies. [Chainlink explains the Robinhood tokenized-equity feeds](https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).

## How Alpaca comparisons are used

Turret checks supplemental stock-market data through Alpaca in a separate polling loop. A slow request cannot hold up the primary oracle and liquidation checks.

Fresh, validated comparisons still matter. A difference above the existing 1% threshold blocks new borrowing. A disagreement above 2% also prevents the service from authorizing a liquidation price under that check. Spread and trade-versus-quote validation remain in place for usable supplemental evidence.

If the supplemental data is missing, stale or temporarily unreachable, Turret can continue using a valid primary reference when all other required checks pass. It does not turn an old trade into a fresh one or extend the Chainlink observation's lifetime.

## Following the trading day

Stock Tokens move onchain, while their underlying markets have trading sessions, holidays and periods of thin trading. The nine stock pools retain their trading calendar:

| Session | New York time | Supplemental comparison feed |
| --- | --- | --- |
| Overnight | 20:00–04:00 | Blue Ocean data through Alpaca |
| Premarket | 04:00–09:30 | Alpaca SIP |
| Regular | 09:30–16:00 | Alpaca SIP |
| After-hours | 16:00–20:00 | Alpaca SIP |

These are comparison feeds; the configured Chainlink token-price feed remains the primary reference in every session. Alpaca documents the [four-session trading schedule](https://docs.alpaca.markets/us/docs/245-trading-for-trading-api).

In a normal week, the schedule runs from Sunday evening through Friday evening in New York. Weekends and U.S. market holidays close new pooled borrowing for these nine stocks. Turret also excludes after-hours borrowing on shortened trading days under its current calendar policy.

## What else must pass before you can borrow?

Each stock has a separate pool and approval decision. AAPL passing its checks does not approve a loan against MSFT.

The backend checks the primary price, chain state, issuer pause status and corporate-action information. The liquidation keeper must be operational. Turret also simulates selling collateral through the market's onchain route. The sale must cover the tested exposure and keeper profit requirement after an additional 2% haircut. A simulation describes the state at that moment; execution can still change afterward.

A current healthy collection can make the market ready immediately. There is no 15-minute qualification period or minimum observation count. Failed checks block new risk, and fresh passing checks allow recovery without a separate waiting period.

For a proposed loan, the service verifies the requested amounts and signs a short-lived approval. The contract checks the authorized signer, action, amounts, expiry and replay protection, then enforces collateral coverage and market limits. Neither a cached market status nor an expired approval can authorize a new loan.

Turret operates the backend and signing keys. The pricing signer is trusted: a signature does not independently prove that the price is correct. Collateral and pool funds remain in the contracts, but incorrect signed prices or service failures can cause losses or interruptions.

## What Open and Closed mean

In the pool directory, **Open** means the operator has enabled the pool. **Closed** means it is paused. These labels do not promise that a particular loan can be issued or that the stock's borrowing session is open.

Open the market to check your proposed loan against the current session, price, collateral, market limits and liquidation readiness. A pool can remain enabled while one of those checks prevents new borrowing.

## Existing loans continue through closures

A borrowing pause does not cancel an existing loan or stop interest accruing. Repayment and collateral top-ups do not require an open trading session. Full repayment can also release the remaining collateral without a fresh borrowing approval, subject to the chain and tokens being operational.

Liquidation follows its own price, token and liveness checks. A market closure does not by itself disable it, and a borrowing pause does not protect a position from liquidation. Feed failures, token restrictions and insufficient sale liquidity can still delay execution.

## The limits remain small

This update expands eligible borrowing hours. The rollout retains a 30% maximum borrowing loan-to-value ratio and a 40% liquidation threshold across these nine markets.

The total outstanding principal caps at publication are:

| Markets | Cap per market |
| --- | --- |
| AAPL | 50 USDG |
| MSFT, GOOGL, AMZN, META, NVDA, AMD, MU and TSLA | 10 USDG each |

These are aggregate market limits shared by borrowers. Actual capacity also depends on the pool's available USDG, existing debt and the collateral position. Borrowers should check the current market page and transaction quote.

## What we have verified

The September 9 release passed tests for missing and stale supplemental prices, fresh price disagreement, expired primary prices, corporate-action changes and failed liquidation coverage. Read-only production checks passed for all nine stocks. Follow-up monitoring found all nine ready across 19 checks over just over three minutes, including checks with stale Alpaca data.

That is a short observation window. It does not establish uninterrupted availability across every session, holiday or market disruption. The remaining safety checks can still prevent a loan.

## SPY, QQQ and P2P follow different weekend rules

SPY and QQQ have separate pools with conditional weekend borrowing. They use bounded historical stock references, live market and sale checks, and a 20% borrowing haircut. This does not create a fresh weekend stock-market price or guarantee that a loan will be available.

P2P loans use the terms chosen by their lenders. They do not require an open pooled borrowing window or use prices to trigger early liquidation. A usable funded offer may be accepted outside stock-market hours if the contracts, network and token transfers permit it. [Read the P2P guide](https://blog.turret.capital/how-turret-p2p-loans-work).

[Open a stock market](https://turret.capital/borrow/pools) to review its terms and check whether your proposed loan can proceed.
