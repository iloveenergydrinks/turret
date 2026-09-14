---
description: "Connect a wallet, prepare your assets and review approvals and signatures before using Turret."
---

# Getting started

Open [turret.capital](https://turret.capital) and connect the wallet you want to use. Your positions belong to that wallet address.

## Prepare your wallet

Turret uses **Robinhood Chain**, chain ID **4663**. Switch to the network requested by the app and keep enough ETH to pay transaction fees.

The assets you need depend on the action:

| Action | What you need in your wallet |
| --- | --- |
| Borrow from a pool | A supported collateral token |
| Supply to Earn | USDG |
| Create a P2P lending offer | USDG for the full principal |
| Accept a token P2P offer | The exact collateral token and quantity required by the offer |
| Accept an NFT loan offer | Ownership of the specified NFT from an enabled collection |
| Repay a loan | USDG sufficient for the repayment |

Tokens must be on the network used by Turret. A matching symbol on another network does not make a balance available here. See [markets and assets](platform/markets.md) for the USDG token address.

## Get the assets onto Robinhood Chain

Check the market's current borrowing capacity and availability before moving funds. Bringing collateral to the network does not reserve a loan or add USDG to its lending pool.

### ETH for transaction fees

Follow [Robinhood's network setup instructions](https://docs.robinhood.com/chain/add-network-to-wallet/) to select Robinhood Chain, chain ID **4663**. Keep ETH on that network for approvals, repayments and withdrawals. ETH on Ethereum or another network cannot pay Robinhood Chain fees.

If your ETH is on Ethereum, the [official bridging guide](https://docs.robinhood.com/chain/bridging/) links the Arbitrum canonical bridge and describes other available routes. Check the destination network, fees and received asset before confirming. The amount of ETH needed varies with the transaction; a positive wallet balance does not establish that it covers the next fee.

### USDG for lending and repayment

If your provider supports **USDG withdrawals on Robinhood Chain**, send it to the wallet address you connect to Turret. [Robinhood's transfer instructions](https://robinhood.com/us/en/support/articles/crypto-transfers/) list supported assets and networks; availability and account eligibility can vary.

For funds on another chain, consult the [official bridging guide](https://docs.robinhood.com/chain/bridging/) for supported token routes. Check the token you will receive: Turret uses USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, as listed in [Robinhood's canonical token registry](https://docs.robinhood.com/chain/contracts/). A different token carrying the USDG symbol is not accepted by these markets.

### Collateral for borrowing

Use the exact collateral contract shown in the selected Turret market. For Robinhood Stock Tokens, start with the issuer's [Stock Token information and eligibility](https://robinhood.com/rhj/stocktokens/) and compare the token with its [canonical registry](https://docs.robinhood.com/chain/contracts/). Stock Tokens provide economic exposure under their issuer's terms; they are not brokerage shares that can be deposited directly into Turret.

For other collateral, check that the provider supports that exact token on Robinhood Chain. A listing on Turret does not establish that a particular exchange or bridge can deliver it.

After a transfer confirms, reconnect or refresh the Turret market and verify your wallet's token and ETH balances. Send funds to your wallet first, then use the app's deposit action; a direct transfer to a lending contract does not perform that action.

## Approvals, signatures and confirmation

Using a token in a lending contract may first require an **approval**, which allows the contract to transfer it. Review the token, amount and contract in your wallet before approving.

An approval alone does not supply funds, open a loan or repay debt. Continue through the action shown in the app. Some actions require a wallet transaction; pooled borrowing uses a signed instruction that Turret's borrowing service submits to the network. Public loan requests and private token-offer negotiations use message signatures without moving assets. NFT lenders deposit USDG directly with wallet transactions; the NFT owner accepts separately to start the loan.

A signature or pending request is not a completed loan. Wait for confirmation and check the updated position in the app.

## Using USDG and preparing repayment

Borrowed USDG arrives in your connected wallet on Robinhood Chain. To transfer it to another wallet, app or exchange, confirm that the recipient supports **USDG on Robinhood Chain** and obtain the destination address from that recipient. [Robinhood Wallet's send and receive instructions](https://robinhood.com/us/en/support/articles/send-receive-and-swap-crypto/) explain its transfer flow and network checks.

If you want funds in a bank account, check your exchange or payment provider's supported deposit network, conversion service, eligibility, fees and withdrawal timing before borrowing. Turret transfers USDG to a wallet; it does not provide a bank withdrawal service.

Plan how you will return USDG before moving borrowed funds elsewhere:

1. Bring the required USDG back to the connected wallet on Robinhood Chain. Pooled debt includes interest accrued while it remains outstanding; a P2P loan requires its full agreed principal and interest.
2. Keep ETH on Robinhood Chain for approvals and the repayment transaction.
3. Open the loan from [Portfolio](guides/portfolio.md), refresh its repayment quote and use the app's repayment action. Sending USDG directly to the contract is not repayment.
4. Wait for confirmation, then check the remaining debt and collateral. P2P settlement credits collateral for a separate withdrawal; a pooled **Repay all and close** action returns collateral as part of closing.

Allow time for the entire transfer route. The [canonical bridge's withdrawal to Ethereum](https://docs.robinhood.com/chain/bridging/) includes a seven-day challenge period and a separate claim transaction. Other routes have their own availability and timing. Moving funds off the network does not pause loan interest or extend a P2P repayment deadline.

## Choose your next step

- Open **Borrow** and choose **Pool loans**, **P2P stocks & tokens** or **P2P NFTs**. The [pool borrowing guide](guides/borrow.md) explains the first option.
- [Earn with USDG](guides/earn.md) by supplying a lending pool.
- [Use token P2P](guides/p2p.md) to request, negotiate, fund or accept a fixed-term loan.
- [Use NFT loans](guides/nft-loans.md) to borrow or lend against one supported NFT.
- [Open your portfolio](guides/portfolio.md) to manage existing positions.

The app shows current balances, terms and availability. Refresh those values before signing, especially if your wallet, network or loan amounts have changed.
