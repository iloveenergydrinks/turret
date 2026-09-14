---
description: "Use supported tokens as collateral to borrow USDG, manage your debt and recover your collateral."
---

# Borrow USDG

Turret lets you deposit a supported token as collateral and borrow USDG from that token's lending pool. You keep exposure to the collateral's price while the tokens are held in the loan contract.

**Borrow** contains three loan types: **Pool loans**, **P2P stocks & tokens** and **P2P NFTs**. This guide covers [Pool loans](https://turret.capital/borrow/pools). For individual lender offers, requests and negotiations, use the [token P2P guide](p2p.md); for NFT collateral, use the [NFT guide](nft-loans.md).

Each pool market has its own borrowing limit, liquidation threshold, APR and available USDG. Open a market to see its current terms and availability.

Prepare the exact collateral token and ETH for fees on Robinhood Chain. If your assets are elsewhere, follow [wallet funding and network setup](../getting-started.md#get-the-assets-onto-robinhood-chain) first. Before opening a loan, decide how you will use the USDG and [bring it back for repayment](../getting-started.md#using-usdg-and-preparing-repayment).

## Open a loan

1. Connect your wallet on Robinhood Chain and select your collateral market.
2. Enter the collateral amount and the USDG you want to borrow. Review the resulting loan-to-value ratio, interest rate and liquidation threshold.
3. Approve the collateral token if the app requests it. Approval allows the contract to use the specified tokens; it does not open the loan.
4. Review and sign your loan limits. Turret submits the loan with fresh market checks, within those signed limits.
5. Wait for confirmation. Your loan appears in the market page and [Portfolio](portfolio.md), and the borrowed USDG arrives in your wallet.

A signed request can wait for prices, liquidity or market checks to meet your limits. Use **Check borrowing request** to follow an existing request. If you cancel, the signature remains usable until the cancellation is confirmed or the request expires.

## Understand your borrowing limit

Loan-to-value, or LTV, is your USDG debt divided by the collateral value used by the market. A loan of 400 USDG backed by collateral valued at 1,000 USDG has a 40% LTV.

The maximum borrowing LTV limits new debt and collateral withdrawals. The liquidation threshold is a separate, higher limit. The space between them is your buffer against falling collateral prices and accumulating interest.

Your available borrowing amount also depends on the USDG in the pool and the market's total borrowing cap. Depositing more collateral does not create additional pool liquidity.

## Manage an existing loan

| Action | What changes |
| --- | --- |
| Borrow more | Receive additional USDG and increase your debt, subject to the market's limits. |
| Add collateral | Deposit more of the same token. Your debt stays the same. |
| Withdraw collateral | Return some collateral to your wallet, provided the remaining position meets the withdrawal limit. |
| Repay part | Pay accrued interest first, then reduce principal. Collateral stays deposited. |
| Repay all and close | Clear the outstanding debt and return the remaining collateral to your wallet. |

Pooled loans have no scheduled maturity. Interest accrues while principal remains outstanding, including when new borrowing is unavailable. A partial repayment must leave at least the market's minimum debt, or repay the loan in full.

The closing quote includes a small allowance for interest accruing before confirmation. The contract takes the debt actually owed, up to the maximum you approve.

## Liquidation

If your LTV rises above the market's liquidation threshold, the position becomes eligible for liquidation. This can happen because the collateral price falls, interest increases the debt, or both.

During liquidation, collateral is taken from your position to repay debt. Turret's liquidation service sells that collateral for USDG. The collateral amount includes a liquidation bonus, so you can lose more collateral value than the debt repaid. Liquidation can remove part or all of your collateral. Any remaining loan still needs monitoring.

Repaying USDG or adding collateral can reduce LTV. A borrowing pause does not pause interest or remove liquidation risk, and a sharp price move may leave little time to act. Read [Risks](../platform/risks.md) before borrowing.

For loans with a fixed repayment amount and due date, see [P2P loans](p2p.md).
