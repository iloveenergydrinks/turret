---
title: "How Turret P2P loans work"
description: "Borrow USDG against supported tokens, or fund a loan on terms you choose. How offers, repayment and default work, and where Turret differs from other lending protocols."
date: "2026-09-07"
author: "Turret"
category: "P2P lending"
cover: "/blog/collateral-loan-engraving-v2.webp"
coverType: "artwork"
coverAlt: "Engraving of a chest holding certificates, with coins, a padlock and a key"
draft: false
---

*Updated September 9, 2026.*

Turret P2P connects people who want to borrow USDG against their tokens with people willing to fund those loans. A lender chooses the amount, collateral, interest and duration. A borrower reviews the offer and accepts its terms. The contract holds the collateral and enforces the agreed repayment and default rules.

This gives holders of supported Robinhood stock and ETF tokens, along with Turret's other eligible assets, another way to borrow without selling their tokens at the outset. It also gives lenders a specific decision: how much USDG would you lend against this collateral, for how long, and at what price?

P2P sits alongside Turret's pooled Borrow and Earn products. Both appear in Portfolio, but their funding and settlement rules are separate.

## Start with an offer or a borrowing request

You can browse funded lending offers or publish a borrowing request. A request specifies the collateral, the USDG you want to borrow, fixed interest, duration and listing expiry. Lenders can propose different terms, and you can review and agree to a proposal.

Requests, proposals and agreement use signed messages. They do not transfer collateral, reserve USDG or start a loan. After agreement, the lender must fund an onchain offer matching the agreed terms and restricted to that borrower. The borrower then accepts that funded offer onchain. Until both steps complete, there is no active loan.

Read each wallet prompt: signing a proposal is different from approving a token or accepting a funded loan. The loan clock starts at successful onchain acceptance, not when a request is published or a proposal is agreed.

## An offer comes with money behind it

Any wallet can create a lending offer using its own USDG. The lender chooses the collateral token and exact quantity, the USDG principal, a fixed interest amount, the loan duration and when the unused offer expires.

Publishing an offer deposits the full principal into the contract. An open offer therefore has funding reserved for it. The same USDG cannot back several open Turret P2P offers at once.

Public offers are available for other eligible wallets to accept. A lender can also restrict acceptance to one borrower address. That restriction does not make the terms confidential: they remain visible on the blockchain.

Borrowers can browse, filter and sort public offers before connecting a wallet. Each offer is taken in full, once. Opening its review page does not reserve it; the first successful acceptance receives the loan.

Until acceptance, the lender can cancel the offer. Cancellation or expiry settlement releases the reserved principal into a withdrawal balance. An unused offer earns no interest.

## What happens when a borrower accepts

Consider this illustrative offer. It is not a live quote or a recommendation about collateral value.

| Loan term | Agreed amount |
| --- | --- |
| Borrower receives | 1,000 USDG |
| Collateral locked | 20 NVDA tokens |
| Interest for the entire loan | 20 USDG |
| Total repayment | 1,020 USDG |
| Duration | 30 days from acceptance |
| Repayment grace period | 24 hours after the due date |

The borrower approves the required collateral and accepts the offer. Acceptance locks the collateral and transfers the funded USDG to the borrower in one transaction. If acceptance fails, that transaction does not create a loan or complete those transfers. A token approval confirmed earlier may still remain.

The duration starts when the loan is accepted. The offer's expiry only controls how long an unused offer can be taken; it does not shorten an accepted loan.

The fixed interest amount is the cost for the whole loan. Any annualized equivalent displayed for comparison is not an additional charge or a promise of compounded yield. Network transaction fees are separate.

## Repayment and default have different outcomes

Repaying the example loan requires the full 1,020 USDG, including if the borrower repays early. The current version does not support partial repayment or automatic refinancing.

Repayment is allowed through the final deadline, including the 24-hour grace period. Successful repayment credits the lender with principal and interest and credits the borrower with the collateral. Each recipient then withdraws their assets to a wallet in a separate transaction.

In current V3 markets, either party can propose a later final repayment deadline and the other party must accept it onchain. A proposal alone changes nothing. An accepted extension leaves principal and fixed interest unchanged; the new final deadline includes the grace time. Older loan versions may not support extensions.

V3 also lets a borrower repay in full using their available USDG credits in the same market, plus any remainder from their wallet. This does not make partial repayment available.

After the applicable final deadline, an unpaid loan can be settled as a default. All of its collateral becomes withdrawable by the lender, and the loan's USDG debt closes. The lender does not receive both full repayment and the collateral.

There is no automatic collateral sale or surplus refund. A borrower who misses the deadline can lose tokens worth more than the debt. A lender can receive tokens worth less than the money lent.

## Why a price fall does not trigger a P2P liquidation

Turret P2P does not use a price feed to decide when to liquidate a loan. Its terms specify a token quantity and a repayment deadline. A market price change does not alter those terms or trigger an early collateral sale.

That matters for assets with thin trading liquidity. A pooled lending market needs a credible way to recover value when collateral becomes insufficient. A direct lender can instead agree to receive the collateral after default, without requiring an immediate sale into USDG.

The economic risk remains. If the tokens fall sharply, the borrower may choose to default and the lender may lose principal. Receiving collateral does not mean it will be easy to sell. Lenders need to assess both what the asset may be worth and whether they are willing to own it.

Token issuer restrictions also still apply. An issuer freeze or transfer restriction can affect collateral even when Turret's loan contract is functioning.

## What the collateral price panel tells you

The collateral panel helps both parties assess terms. For supported stock tokens, it can show a Chainlink reference value in USD and an estimated sale value from a Kyber quote in USDG. Each has its own timestamp. A reference can be older than the latest check because the feed has not published another observation.

USD and USDG are different units. A sale quote excludes gas and can change before execution; it is neither guaranteed proceeds nor a recommended loan amount. Missing or stale pricing should be treated as missing evidence, not a zero valuation or a promise that the collateral retains its previous value.

These estimates do not set a P2P liquidation threshold. Lenders choose the terms and bear the risk of receiving the collateral after default. The pooled Borrow market being closed does not, by itself, close P2P: a funded offer can still be accepted outside stock-market hours if the offer, contracts, network and token transfers permit it.

## NFT loans use a separate P2P contract

NFT lending is available through the [P2P NFTs page](https://turret.capital/borrow/nfts). The current configuration enables Cash Cats. PYO and OnChainHoodies are listed but disabled because their collection transfer rules prevent loan escrow. The fungible CASHCAT token market is separate from Cash Cats NFTs.

An NFT offer identifies one collection and one exact token ID, together with USDG principal, fixed interest, duration and offer expiry. The lender funds the offer before acceptance. A borrower can also publish a request and discuss terms; a request or signed agreement alone does not fund a loan or move the NFT.

Acceptance transfers that NFT into the loan's vault and releases USDG to the borrower. Full repayment, including the agreed interest even when repaying early, makes the NFT withdrawable by the borrower and the repayment withdrawable by the lender. After the due date and 24-hour grace period, an unpaid loan can be settled as a default and the lender can withdraw the NFT. There is no price-triggered liquidation, automatic sale or surplus refund.

The NFT contract has its own rules. It does not inherit the fungible V3 market's deadline-extension or credit-assisted repayment features. Collection permissions and new-loan pauses control admission; settlement and owned withdrawals remain available under the contract, subject to token transfers and the network working.

An enabled collection does not guarantee a funded offer, a particular valuation or an executable transfer forever. Lenders should assess the specific NFT and be willing to receive it after default. Collection restrictions, contract bugs and network failures can still prevent an expected outcome.

## More funded offers mean more borrowing capacity

P2P capacity grows when lenders commit more USDG to offers that borrowers can use. If lenders publish ten open offers of 1,000 USDG each, those offers reserve 10,000 USDG in total. Borrowers still need the required collateral and must accept each offer's full terms.

Adding another supported collateral asset creates a place for offers. It does not put money there. Better terms and reliable funding are what make a marketplace useful.

Pooled Earn deposits fund their respective pools. They do not automatically enter P2P, and P2P funds do not backstop the pools. Portfolio brings both products into one view without combining their balances or risks.

## How this compares with other lending protocols

PWN is the closest comparison. It already supports lender-selected terms and loans that default based on time rather than a falling collateral price. Its documented custom offers leave the lending asset in the lender's wallet until acceptance. Turret reserves the principal when an offer is published. That gives borrowers committed funding while making lenders give up use of that money during the offer period. [PWN's lending-offer guide](https://docs.pwn.xyz/guides/lending-on-pwn/creating-a-lending-proposal)

Morpho's variable-rate markets pair a loan asset with collateral, an oracle and a liquidation threshold. Its fixed-rate Midnight markets also allow liquidation when a position becomes unhealthy, as well as after unpaid maturity. Fixed interest alone is therefore not a unique feature of Turret. Our direct loans instead settle through repayment or collateral forfeiture after the deadline. [Morpho variable-rate markets](https://docs.morpho.org/learn/concepts/blue/) and [Midnight](https://docs.morpho.org/learn/concepts/midnight/)

Liquity V2 lets borrowers mint BOLD against ETH, wstETH or rETH, without a scheduled repayment date. Turret P2P lends existing USDG supplied by another wallet for a fixed term. It does not mint a new stablecoin when a borrower accepts. [Liquity's borrowing documentation](https://docs.liquity.org/v2-faq/borrowing-and-liquidations)

Turret's focus is lending against our supported assets on Robinhood Chain, including stock and ETF tokens, with direct loans and pooled positions managed in one application. The core P2P idea is established. The quality of Turret's marketplace will depend on useful collateral coverage, funded offers, clear terms and reliable execution.

## Before funding or accepting a loan

Borrowers should check the exact collateral quantity, total repayment and final deadline. Lenders should consider the outcome in which they receive the collateral rather than USDG. Active loan principal cannot be withdrawn on demand, and neither principal recovery nor interest is guaranteed.

Turret P2P has automated tests and internal review. It has not undergone an external audit. The current product is in beta, and token, contract and network risks remain.

[Browse public offers](https://turret.capital/borrow/p2p) to compare available terms. [Portfolio](https://turret.capital/portfolio) shows your pooled positions, direct loans and available withdrawals.
