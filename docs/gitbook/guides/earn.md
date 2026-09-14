---
description: "Deposit USDG into a collateral market, earn borrower interest and understand withdrawals."
---

# Earn with USDG

Choose a collateral market and deposit USDG into its lending pool. Your funds supply loans backed by that market's token. For example, USDG deposited in the AAPL pool funds AAPL-backed loans.

You receive pool shares that represent your portion of the pool. Their value reflects the pool's assets, accrued interest after protocol fees, and any recognized losses.

You need USDG and ETH for fees on Robinhood Chain; you do not need to own the pool's collateral token. Follow [wallet funding and network setup](../getting-started.md#get-the-assets-onto-robinhood-chain) if your assets are on another network.

## Deposit USDG

1. Open **Earn**, choose a pool and review its collateral, borrower APR, estimated lender APR and available cash.
2. Connect your wallet on Robinhood Chain and enter the USDG amount to deposit.
3. Approve USDG if requested, then review and confirm the deposit transaction.
4. After confirmation, check your shares and position value on the pool page or in [Portfolio](portfolio.md).

Use the deposit action in the app. Sending USDG directly to a pool address does not issue shares to you.

## Where the return comes from

Borrowers pay interest on the USDG they use. The protocol receives a share of that interest; the remainder belongs to lenders through their pool shares.

The lender rate depends on how much of the pool is borrowed. A pool with no active borrowing earns no borrower interest, even when it has a displayed borrower APR. The estimated lender APR is a current estimate, not a guaranteed return.

Interest does not require a separate claim. It is reflected in the value of your shares. See [Rates and fees](../platform/rates-and-fees.md) for the calculation.

## Withdraw USDG

Open your pool position, choose the withdrawal action and review the amount before confirming in your wallet. Withdrawal exchanges your pool shares for USDG.

**Estimated position value** and **Withdrawable now** answer different questions. Position value can include funds out on loan and interest borrowers have not yet paid. Withdrawable now is the USDG the pool can currently return to you.

If available cash is lower than your position value, you may need to withdraw a smaller amount or wait for more USDG to become available. Pooled loans have no fixed repayment deadline, so there is no guaranteed date for a full exit.

Repayments and new deposits can increase available cash. Market checks can also restrict withdrawal even when the pool holds cash. Refresh the current limit before reviewing a withdrawal; a displayed amount is not reserved for you and may change before the transaction confirms.

The current pools do not offer a withdrawal queue. Entering an amount in the app does not create a withdrawal request or secure priority over other lenders.

## Understand the pool's risk

Your deposit is exposed to the borrowers and collateral in the pool you select. If liquidation cannot recover what a borrower owes, the loss reduces the pool's assets and can reduce your share value.

Separate pools do not remove shared risks such as USDG, the network and smart contracts. Read [Risks](../platform/risks.md) before depositing.
