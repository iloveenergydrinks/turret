---
title: "How Turret prices silver, memecoins and stocks"
description: "How backend-managed prices, signed approvals and liquidity checks work for pooled loans, and why P2P follows different rules."
date: "2026-09-06"
author: "Turret"
category: "How it works"
cover: "/blog/oracle-instruments-engraving-v1.webp"
coverType: "artwork"
coverAlt: "Engraving of a precision measuring instrument connected to silver bars, a cat-emblem coin and a stock certificate"
draft: false
---

*Updated September 9, 2026.*

A pooled loan needs a usable collateral price and a credible way to recover its debt. A stock reference, a memecoin exchange price and an executable sale quote answer different questions. Turret checks them separately.

As of this update, Turret's 13 configured pooled markets use backend-managed pricing and borrowing approvals: nine individual stocks, SPY, QQQ, SLV and CASHCAT. Configured does not mean continuously available. In the pool directory, Open means the operator has enabled the pool and Closed means it is paused. Open the market to check whether a proposed loan can currently proceed.

## What the backend and contracts each do

Turret's backend gathers price evidence, applies each asset's policy, checks liquidity and monitors liquidation readiness. When the required checks pass, it signs a short-lived approval for the requested action.

The contracts hold collateral and USDG. They verify the approved signer, the action and amounts, expiry and replay protection, then enforce collateral coverage, accounting and market caps. A valid signature proves that the authorized service approved the data; it does not independently prove that the price is correct.

**The pricing signer is trusted.** Incorrect or compromised signed prices can cause losses. Shared backend services reduce duplicated checks, but introduce shared operational dependencies. Borrowing still depends on Turret, its data providers and Robinhood Chain.

Each pool remains separate. USDG supplied to AAPL funds that pool's loans; it does not automatically fund SLV, CASHCAT or P2P. Borrowers owe principal and accrued interest under their pool's terms.

## Different assets need different evidence

| Collateral | Price evidence | Additional borrowing checks |
| --- | --- | --- |
| Nine individual stocks | Configured Chainlink token-price feeds with a 24-hour freshness limit; Alpaca as a supplemental comparison | Trading calendar, fresh-price disagreement, corporate actions, sale capacity and operational readiness |
| SPY and QQQ | Stock references, with a bounded historical-reference policy outside the reference session | Live market and sale checks; a 20% weekend borrowing haircut |
| SLV | Onchain trading prices and recent price history | Enough executable liquidity to support the proposed exposure, plus operational readiness |
| CASHCAT | Multiple exchange sources checked against onchain spot and recent price history | Source agreement, fresh evidence and a usable collateral-sale route |

A reference price alone is not an approval to borrow. Nor does a small successful sale establish enough liquidity for a pool's full borrowing cap.

## Stocks use Chainlink as the primary reference

For AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU and TSLA, the configured Chainlink token-price observation must be valid and less than 24 hours old. Checking a feed again does not extend its observation's lifetime. The reference already reflects the token's scaling; Turret also accounts for USDG's value when calculating borrowing value.

Alpaca provides supplemental comparisons for the current trading session. Missing, stale or temporarily unreachable Alpaca data no longer automatically rejects borrowing. Fresh validated disagreement still blocks: a difference above 1% stops new borrowing, and above 2% also blocks liquidation-price authorization under that check. Corporate-action, issuer-pause and liquidation checks remain mandatory.

The service does not wait for a fixed qualification period. A current healthy collection can restore readiness immediately, while each requested action still needs fresh evidence and a short-lived approval. [The stock borrowing guide](https://blog.turret.capital/stock-token-borrowing-24-5) explains sessions and the full policy.

## SPY and QQQ over the weekend

A weekend stock reference is historical evidence. It is not a newly published price from an open U.S. stock market.

SPY and QQQ have a specific policy that permits conditional weekend borrowing using bounded historical references, live market checks and a 20% borrowing haircut. The haircut lowers the eligible borrowing valuation; it is not an extra interest charge or a guarantee against a market gap.

The policy does not promise uninterrupted weekend availability, and it does not automatically extend to the nine individual stocks. Missing evidence, insufficient sale capacity or failed operational checks can still block a new loan.

## Silver: price and liquidity are separate

SLV can have a recent displayed price while borrowing is unavailable. A price estimates value; a liquidation route must actually recover enough USDG from the required amount of collateral.

Extra USDG in the lending pool supplies money for borrowers. It does not create buyers for SLV. A sale aggregator may find a better route, but cannot create liquidity that is absent.

The market can also be paused by its operator. When the UI says “Paused by operator,” that is the immediate block; the label alone does not establish whether a separate liquidity check would pass. Use the reason shown on the market page rather than inferring the cause from its price.

## CASHCAT uses the central pricing service too

CASHCAT has moved to the backend-managed credit system. The service compares exchange evidence with the onchain market, accounts for USDG's value and uses a cautious borrowing valuation. It also checks whether the collateral can be sold to cover the tested exposure.

This changes where price policy runs. It does not remove price risk, liquidation risk or dependence on data providers. The [CASHCAT pricing guide](https://blog.turret.capital/how-the-cashcat-oracle-works) explains what borrowers see and what happens when evidence expires.

## Why a price and its timestamp can look different

“Reference updated” identifies the source observation. “Checked” identifies a later service check. Checking an unchanged reference again does not make the original observation newer.

A live sale estimate, a stock reference and the valuation used for borrowing may differ. They measure different things, can use different units and must be read with their timestamps. A sale estimate is not guaranteed execution.

Availability also depends on the operator's pause setting, remaining borrowing cap, available USDG, data quality, RPC access and liquidation readiness. A current price does not override those requirements.

## What a pause means for existing borrowers

A pause blocks new borrowing; it does not cancel existing debt or stop interest. Full repayment and recovery of the remaining collateral do not require a fresh borrowing approval, subject to the chain and token transfers working.

A service interruption can prevent new approvals until current checks pass again. There is no separate qualification or recovery timer. Stored history does not permit borrowing on expired evidence.

Liquidation has its own checks. A borrowing pause does not protect an unsafe position from liquidation, and data or liquidity failures can delay a necessary sale. Lenders can lose money if collateral proceeds do not cover debt.

## P2P uses a different rule

Turret P2P loans have agreed collateral quantities, fixed interest and repayment deadlines. They do not use a falling price to trigger an early liquidation. Price panels help people evaluate an offer; they do not replace the lender's decision.

After an unpaid loan's final deadline, the lender can receive the collateral under the contract's default rules. That exposes the lender to its value and transferability. NFT lending uses a separate P2P contract. Cash Cats is enabled in the current app; PYO and OnChainHoodies remain disabled because their transfer rules prevent loan escrow. See [how Turret P2P loans work](https://blog.turret.capital/how-turret-p2p-loans-work).

Before borrowing or supplying USDG, check the current [market page](https://turret.capital) and transaction terms. Older positions remain governed by their original contracts; this update does not change their terms.
