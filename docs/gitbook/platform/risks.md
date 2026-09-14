---
description: "Understand collateral liquidation, P2P default, lender losses and the dependencies of using Turret."
---

# Risks and liquidation

Borrowing and lending on Turret put assets at risk. Collateral protects a lender's claim, but its value can fall and its sale may recover less than the debt.

## Pooled borrowing: watch your LTV

**Loan-to-value (LTV)** compares your debt with the value of the collateral securing it. For example, 400 USDG of debt against collateral valued at 1,000 USDG is 40% LTV. If that collateral falls to 800 USDG, the same debt becomes 50% LTV.

Interest also increases debt over time. A position can move toward liquidation even if you do not borrow more.

The borrowing limit and liquidation threshold are separate. Check both in your market and leave room for price changes. Adding collateral or repaying debt lowers LTV. Borrowing more or withdrawing collateral raises it.

### What happens in a liquidation

When the position's LTV rises above the market's liquidation threshold, its collateral can be used to repay debt. The collateral taken includes a liquidation bonus, so its value can exceed the debt repaid. Liquidation may happen before you can react. A price gap or limited trading liquidity can make the outcome worse than the last displayed estimate.

Notifications are a convenience. Keep track of the position itself and do not rely on an alert arriving before liquidation.

## P2P: watch the final deadline

Token and NFT P2P collateral is not liquidated when its price falls. The borrower owes the full agreed repayment by the final deadline: the due time plus a **24-hour grace period**.

After that deadline, the loan can be settled as a default and **all of its collateral goes to the lender**. There is no collateral sale or surplus refund. Early repayment still includes the full fixed interest.

A proposed extension does not change the deadline: on current token loans both parties must accept it on chain before settlement. NFT loans do not support extensions.

A token freeze, failed transaction or network outage does not extend the deadline. Arrange repayment with time to confirm it. See [P2P loans](../guides/p2p.md).

## Lending: returns and withdrawals can vary

In Earn, interest depends on borrowing activity and the pool's terms. Deposits can lose value if the pool incurs losses. You can withdraw only the amount supported by available liquidity; supplied funds may already be lent out.

In P2P, you commit the principal to an individual loan. If the borrower defaults, you receive collateral instead of the promised USDG repayment. That collateral may be difficult to sell or worth less than the principal you lent.

## Negotiation and recovery risks

Agreeing replacement terms does not reserve, cancel or edit the original funded offer. It may still be accepted before cancellation confirms. Cancellation, USDG withdrawal, replacement funding and borrower acceptance are separate steps, and an interruption does not recreate the original offer. Public borrowing requests and private negotiations are not loan guarantees.

A recorded token credit can exceed what remains in its loan vault. Available withdrawals and unpaid credits are different amounts. Writing off a credit permanently gives up its unpaid remainder. Separate loan vaults do not remove token-wide restrictions or make other loans cover a shortfall.

## NFT-specific risks

An NFT’s image, name or collection listing does not establish its value or liquidity. Check the collection address and token ID. Default transfers the entire NFT to the lender without refunding any excess value. Escrow can also affect ownership benefits and access to wallets controlled by the NFT. Collection transfer restrictions can prevent recovery. The NFT lending contract has not received an independent external audit.

## Asset, contract and network risks

USDG and collateral tokens depend on their issuers and token contracts. Restrictions, freezes, upgrades or changes in value can affect transfers and recovery. Holding a stock token as collateral does not by itself give you direct ownership of the underlying share.

Smart contract faults, inaccurate or unavailable prices, limited trading liquidity and network disruptions can affect lending and settlement. Market controls can pause new borrowing or other actions. A pause does not erase debt or stop a P2P deadline from passing.

Review the current terms and status in the app before committing funds, and keep enough gas available to manage your position.
