---
title: "Pool and P2P loans, explained simply"
description: "How Turret pool and P2P loans differ on interest, repayment and collateral, and why P2P lenders should expect their money to stay locked up."
date: "2026-09-09"
author: "Turret"
category: "Lending basics"
cover: "/blog/pool-vs-p2p-loans.png"
coverType: "artwork"
coverAlt: "Turret editorial cover with the words Pool or P2P? Know your loan. beside an engraved stone tower with two entrances."
draft: false
---

Turret offers two ways to borrow USDG against assets you own. A pool loan draws money from a shared pool of lenders. A P2P loan comes from a lender who agrees to specific terms with you.

Both require collateral: tokens or an NFT you lock in a contract to secure the money you borrow. The differences are how you pay interest, when you must repay and how you can lose that collateral.

For lenders, there is another difference worth understanding before depositing anything: **P2P loans are extremely illiquid. Once the borrower accepts, you cannot withdraw your principal on demand.** You must wait for repayment or receive collateral after default, which you may then struggle to sell.

## Borrowing from a pool

Several lenders deposit USDG into a pool. You borrow from the available balance under that market's rules, without negotiating with an individual lender.

Interest builds while you owe money. You have no fixed repayment date, but you need to keep enough collateral behind your debt. Repaying sooner reduces the time you pay interest.

The loan screen shows your loan-to-value ratio, or LTV: your debt compared with the value assigned to your collateral. A fall in the collateral's price pushes that ratio up. Interest adds to your debt and can push it up too.

If you reach the market's liquidation threshold, you can lose collateral to cover your debt. Having no due date does not mean you can leave the loan unattended.

New borrowing depends on the pool having USDG available and passing the market's checks. Stock-market hours and pricing conditions can affect availability. A pause in new borrowing does not stop interest on existing loans or protect them from liquidation. The [stock-pool availability guide](https://blog.turret.capital/stock-token-borrowing-24-5) explains those checks.

## Borrowing from a P2P lender

P2P means peer-to-peer. You take a loan on terms a particular lender is willing to fund: an exact collateral amount, a USDG loan amount, fixed interest and a repayment deadline.

For example, a lender might offer you **100 USDG for 30 days, with 5 USDG interest**. You receive 100 USDG and must repay 105 USDG. You also lock the collateral specified in the offer. This is an illustration, not a live quote.

The 5 USDG covers the whole loan. It is not a yearly rate, and repaying early does not reduce it. Network fees are separate.

The clock starts when you accept the funded offer onchain. Turret P2P includes a 24-hour grace period after the due date. Repay in full by the final deadline and you can withdraw your collateral; the lender can withdraw the principal and interest. Each withdrawal requires a separate transaction.

A fall in the collateral's price does not trigger an early liquidation. But if you miss the final repayment deadline, the lender can take **all the pledged collateral** after default settlement. Turret does not sell it and return any excess value to you. You can lose an asset worth more than your debt. The lender can receive an asset worth less than the money they lent.

## Compare the terms

| | Pool loan | P2P loan |
| --- | --- | --- |
| Source of USDG | Lenders' deposits in that pool | A lender funding a specific offer |
| Terms | The market's configured rules | The lender's terms, accepted by the borrower |
| Interest | Builds over time | A fixed amount for the whole loan |
| Repayment | No fixed date | An agreed deadline, including the grace period |
| Risk to collateral | Liquidation when debt reaches the market's threshold | Forfeiture after a missed final deadline |
| Early repayment | Reduces the time interest accrues | Full agreed interest still due |
| Lender's access to money | Withdrawal depends on available pool cash | No on-demand withdrawal during an active loan |

## P2P lenders should expect their money to stay locked up

If you lend the 100 USDG in the example, you give up access to that money when you fund the offer. Before acceptance, you can cancel and withdraw the released funds. An unused offer earns no interest.

Once the borrower accepts, you cannot cancel the loan to get your money back. You cannot count on the borrower repaying early, and the due date is not a guaranteed cash-out date.

If the borrower repays, you can withdraw your USDG. If they default, you receive the collateral instead. To turn it into USDG, you would need to find a buyer at a price you accept. That could take time, require a steep discount or prove impossible. An NFT or a thinly traded token can leave you holding an asset long after the loan's deadline has passed.

This is why P2P lending is extremely illiquid: you first commit your cash to the loan, then risk receiving collateral you cannot sell. A high interest amount does not make either problem disappear. Fund a loan only if you can leave the money committed and are willing to own the exact collateral after default.

Pool lending also has withdrawal limits. Your deposit buys shares in that pool, and you can withdraw only against available USDG. If borrowers have taken most of the cash, you may have to wait. Interest contributes to your position's value; losses can reduce it. The balance shown in Portfolio is not a promise that you can withdraw it all today.

Your pool deposits and P2P loans remain separate. Depositing in a pool does not fund P2P offers.

## Requests, offers and active loans

A **borrowing request** means: “I want to borrow this much against these assets.” It helps a borrower find a willing lender. Posting a request or agreeing to terms does not move loan money.

A **funded offer** means: “The lender has deposited the USDG for this deal.” The money is reserved, but the borrower has not taken the loan yet. The offer's expiry tells the borrower how long they have to accept it.

An **active loan** begins when the borrower accepts onchain. The contract locks the collateral and sends USDG to the borrower. Only then does the repayment clock start.

## NFT loans follow the P2P model

For an NFT loan, you pledge one exact NFT, identified by its collection and token ID. Full repayment lets you withdraw it. Missing the final deadline lets the lender claim it after default settlement. A change in its estimated price does not trigger early liquidation.

As a lender, assess that specific NFT. A collection's advertised price does not guarantee someone will buy yours at that price, or buy it at all.

NFT loans use a separate contract. Features available for some token loans, such as mutually agreed deadline extensions, do not carry over to NFTs.

You can inspect current terms on the [pool markets page](https://turret.capital/borrow/pools) and the [P2P offers page](https://turret.capital/borrow/p2p). For the steps involved in funding, repayment and default, read the [full P2P guide](https://blog.turret.capital/how-turret-p2p-loans-work).
