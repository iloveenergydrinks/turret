---
description: "Request, fund and repay USDG loans secured by one supported NFT, with separate asset withdrawals."
---

# P2P NFT loans

Open [Borrow → P2P NFTs](https://turret.capital/borrow/nfts) to borrow or lend USDG against one specific NFT. Review its collection contract and token ID, the USDG received, total repayment and deadlines. A similar image or name does not identify the same NFT.

The lender deposits USDG before a loan starts. The NFT owner must then accept the offer and transfer that NFT into escrow to receive the USDG. A request or an offer awaiting acceptance is not an active loan.

## Supported collections

As of September 9, 2026, **Cash Cats** is enabled. PYO and OnChainHoodies appear as unavailable because their transfer rules prevent loan escrow. Check the live **Collections** view before preparing a loan; collection approval checks compatibility, not value or a guaranteed ability to sell.

## Borrow against your NFT

1. Connect the wallet holding the NFT and open **My NFTs**.
2. Choose **Request a loan**, enter the USDG you want, total repayment, whole-day duration and listing expiry.
3. Review and sign to list the request. This message signature moves no NFT or USDG.
4. Review a lender's deposited offer from **People looking to borrow** or **Deposited offers**. Check the exact NFT, repayment and acceptance expiry.
5. Approve the NFT if requested and confirm acceptance. Only after confirmation does the loan start and USDG arrive in your wallet.

Removing your listing does not cancel any deposited offer or active loan. An offer can have borrower restrictions, and only the current owner of its specified NFT can accept when the contract's checks pass.

## Lend USDG

Browse **People looking to borrow** or **Collections**, choose an NFT and make a loan offer. Enter the principal, total repayment, duration and acceptance expiry.

After reviewing, choose **Approve and deposit USDG**. Approve the exact amount if needed, then confirm the deposit transaction. The current direct funding flow does not require a separate agreement-message signature from the lender. USDG goes to the NFT owner only when they accept.

Until acceptance, you can cancel the offer and then withdraw its USDG. Expired offers also require release and withdrawal. After acceptance, your funds remain committed until repayment or default settlement. No interest is earned on an unaccepted offer.

If your wallet or the page loses confirmation, check the recent deposit and its transaction link before retrying. A submitted transaction may have succeeded even if the interface did not receive its result.

## Repayment and withdrawal

The repayment period starts at acceptance. The borrower owes the full principal plus fixed interest, including for early repayment; there is no partial repayment. The final deadline includes **24 hours of grace** after the due date. NFT loans do not support deadline extensions.

Open the loan from **My loans** or [Portfolio](portfolio.md), approve USDG if necessary and repay before the final deadline. Repayment settles the debt but does not automatically send the NFT back to the wallet.

After settlement, the page shows the next withdrawal action:

- After repayment, the borrower chooses **Withdraw NFT** and the lender withdraws the USDG repayment.
- After default, the lender withdraws the entire NFT instead of receiving the promised USDG repayment.
- After cancellation or expiry of an unused offer, the lender withdraws the deposited USDG.

Check and confirm the recipient wallet before withdrawing. A withdrawal is a separate transaction; leaving it unfinished does not undo repayment or settlement.

## Default and NFT risks

After the final deadline, repayment is closed and default can be settled. The entire NFT goes to the lender; no surplus is refunded if it is worth more than the debt. There is no price-triggered liquidation or automatic sale.

An NFT may be illiquid or lose all value. Transfer restrictions can affect recovery. While the NFT is held in escrow, ownership benefits and access to a wallet controlled by NFT ownership may be unavailable. Do not assume a loan covers other assets or rights associated with the NFT. The NFT lending contract has not received an independent external audit.

## Alerts

NFT loan alerts have their own wallet verification and email or Telegram subscriptions, separate from token P2P alerts. When available, they cover acceptance, repayment, default and reminders one day and one hour before the final deadline. Settlement cancels outstanding automatic reminders. Delivery can fail or be delayed; it never changes the deadline.
