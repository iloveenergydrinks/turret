---
description: "The network, USDG token and collateral markets used by Turret."
---

# Markets and assets

Turret lends and settles loans in **USDG on Robinhood Chain**. Collateral options differ between pooled Borrow / Earn and P2P.

## Network and loan asset

| Detail | Value |
| --- | --- |
| Network | Robinhood Chain |
| Chain ID | 4663 |
| Network fee token | ETH |
| Loan and repayment asset | USDG |
| USDG contract | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| USDG decimals | 6 |

You can check the [USDG contract on the explorer](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) and use [Robinhood's network instructions](https://docs.robinhood.com/chain/add-network-to-wallet/) to configure your wallet.

## Collateral markets

The following collateral tokens are listed in Turret's current markets, as of September 9, 2026:

| Product | Collateral tokens |
| --- | --- |
| Pool loans / Earn | AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU, TSLA, CASHCAT, SLV, SPY, QQQ |
| P2P stocks & tokens | AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU, TSLA, CASHCAT, SLV, PONS, SPY, QQQ, GLD, COIN, PLTR, NFLX, INDEX |

In **Earn**, you deposit USDG into the pool associated with one of those collateral tokens. You do not need to own the collateral token to lend.

In **P2P**, each offer specifies the exact collateral token and quantity required. A listed collateral token may have no funded offers available.

## NFT collateral

[NFT loans](../guides/nft-loans.md) use a separate contract and one specific NFT per offer. Cash Cats is enabled as of September 9, 2026. PYO and OnChainHoodies are listed as unavailable because their transfer rules prevent escrow. NFT collection eligibility does not establish a valuation or a buyer for a defaulted NFT.

The CASHCAT token market and the Cash Cats NFT collection are different collateral products. Check the token or collection contract and, for NFTs, the token ID.

## Availability and market checks

Open the relevant market in the app for its current status. New pooled loans require available USDG, room under the market's borrowing cap and valid price and risk checks. Stock market hours and fresh price data can affect availability. A reopening time is a time to check again, not a guaranteed execution time.

P2P availability depends on funded offers, their expiry, any designated borrower and the market's status. The website checks token and escrow health before allowing new lending actions. Current token offers use separate loan vaults; older deployments remain available for their existing loans and credits, with their original rules.

Reference prices and estimated sale proceeds help compare token collateral but do not set P2P terms or trigger liquidation. Quotes can expire or be unavailable. A closed underlying market can leave a last-published reference that differs from the token’s current trading price.

If an action is unavailable, read the reason shown by the app. Existing debt and repayment deadlines continue to apply while a market is unavailable.

## Know the asset you use

A token symbol is a label; its network and contract address identify the asset. Review the selected token before approving it. Stock and fund tokens also depend on their issuer's terms and transfer rules.

See [risks and liquidation](risks.md) for how asset restrictions, price changes and trading liquidity can affect a position.
