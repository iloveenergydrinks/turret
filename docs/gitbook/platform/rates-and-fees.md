---
description: "How pooled loan interest, lender returns, P2P interest and transaction costs work."
---

# Rates and fees

## Pooled borrowing interest

Each pooled market has a set borrower APR. It does not change with pool utilization. Check the rate on the market page before borrowing; different markets can have different terms.

Interest accrues on outstanding principal for the time it is borrowed, using a 365-day year. Accrued interest is added to the debt you owe but does not itself earn interest. Repayments pay accrued interest first and then reduce principal.

For example, 1,000 USDG borrowed at 10% APR for 30 days accrues approximately 8.22 USDG in interest, assuming the principal stays unchanged. This is an illustration, not a current market quote.

Pooled loans do not have a fixed due date or a separate early repayment penalty. Repaying sooner reduces the time over which interest accrues.

## Lender returns and protocol fees

Lenders earn from the portion of the pool that borrowers actually use. Turret takes the market's protocol fee from received interest, rather than from the lender principal being repaid.

The app estimates lender APR as:

```text
Borrower APR × pool utilization × (1 − protocol share of interest)
```

At a 10% borrower APR, 50% utilization and a 10% protocol share of interest, the estimated lender APR would be 4.5%. These are example inputs, not current rates.

The estimate excludes losses and does not guarantee an APY. Actual results depend on borrowing activity, interest received, deposit and withdrawal timing, and loan recoveries.

## P2P loan interest

[P2P offers](../guides/p2p.md) specify a principal amount and a fixed interest amount in USDG. The repayment total is principal plus that interest. It is agreed when the offer is accepted and does not change with a pool's APR.

Early repayment still requires the full agreed amount. Compare the total repayment and the loan duration when evaluating an offer. This applies to token and NFT P2P loans.

On current token loans, a mutually accepted deadline extension does not add interest. Pre-loan negotiations can instead propose a different repayment amount; the lender must fund a replacement and the borrower must accept it. An unused funded offer earns no interest.

## Network costs

Robinhood Chain uses ETH for network fees. Wallet transactions such as token approvals, deposits, repayments and withdrawals can require ETH. Your wallet displays the fee before confirmation. See [Robinhood's network documentation](https://docs.robinhood.com/chain/add-network-to-wallet/) for network details.

Signing a pooled borrowing instruction has no network fee. Turret's borrowing service submits that instruction on chain. Token approvals and cancellation are separate wallet transactions.

Public request and private negotiation message signatures do not transfer funds and have no network fee. Cancelling an offer, withdrawing its USDG and funding a replacement are separate on-chain transactions. NFT offer funding uses approval and deposit transactions without a separate lender agreement-message signature.

## Liquidation cost

Pooled liquidation uses your collateral to repay debt. The collateral amount includes the market's liquidation bonus, so liquidation can cost you more collateral than the value of debt repaid. Read [Borrow USDG](../guides/borrow.md) for how liquidation works.
