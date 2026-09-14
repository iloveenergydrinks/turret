---
description: "How collateral, USDG, lending pools and fixed-term P2P loans fit together on Turret."
---

# How Turret works

Turret connects people who hold supported tokens with people who want to lend USDG. Borrowers lock collateral in a smart contract and receive USDG. Lenders provide the USDG and earn interest when loans are repaid.

USDG is the asset used for lending and repayment. Borrowing transfers existing USDG from a pool or funded offer to your wallet.

## Pool loans and Earn

Each lending pool serves one collateral market. Lenders deposit USDG through **Earn**. Borrowers use **Borrow → Pool loans** to lock that market's collateral and draw USDG from the pool.

A pool has its own available liquidity, borrowing limits and interest rate. Supplying to one pool gives you exposure to that pool's borrowers and collateral.

For a borrower, the key measure is **loan-to-value**, or **LTV**: the value of your debt divided by the value of your collateral. LTV rises when collateral loses value or interest increases your debt. A position can be liquidated when its LTV rises above the market's liquidation threshold.

For a lender, the deposit is represented by pool shares. Their value reflects the pool's accounting, including earned interest and any recognized losses. Withdrawals depend on the USDG available in the pool.

Read [Borrow USDG](../guides/borrow.md) and [Earn with USDG](../guides/earn.md) for the steps.

## P2P loans

P2P connects a lender and borrower through a funded offer. The lender chooses the USDG principal, collateral quantity, fixed interest and loan duration. Accepting locks the borrower's collateral and transfers the principal to them.

The borrower must repay the full principal and agreed interest by the final deadline. If they do, the lender receives a USDG credit and the borrower receives a collateral credit to withdraw. After default, the lender receives a credit for all of the loan's collateral.

Borrowers can also publish public requests. For an existing eligible funded token offer, private negotiations let the parties agree different terms before the lender cancels, withdraws and funds a replacement. Neither a request nor a signed negotiation starts a loan. See [P2P stocks and tokens](../guides/p2p.md).

## NFT loans

**Borrow → P2P NFTs** uses one supported NFT as collateral for an individual USDG loan. Lenders deposit USDG directly; the NFT owner separately accepts to start the loan. Repayment releases the NFT for the borrower to withdraw. Default releases the entire NFT for the lender to withdraw, without a surplus refund. See [P2P NFT loans](../guides/nft-loans.md).

## Choosing a product

| | Borrow / Earn pools | P2P loans |
| --- | --- | --- |
| Funding | USDG supplied by a pool's lenders | USDG committed to an individual offer |
| Interest | Accrues over time at the market's borrowing rate | A fixed USDG amount agreed before acceptance |
| Repayment | Flexible repayments against an ongoing position | Full repayment by a fixed deadline |
| Collateral enforcement | Liquidation based on the position's LTV | Default after the repayment deadline and grace period |
| Lender exit | Withdraw available pool liquidity | Cancel an unaccepted offer and withdraw; after acceptance, wait for repayment or default settlement |

Current token loans support mutually agreed on-chain deadline extensions with unchanged repayment. NFT loans do not. P2P lending has no guaranteed early exit after acceptance.

Pool positions, token P2P loans and NFT loans are separate obligations. [Portfolio](../guides/portfolio.md) brings them into one view so you can track both.

Before committing funds, read [interest and fees](rates-and-fees.md) and [risks and liquidation](risks.md).
