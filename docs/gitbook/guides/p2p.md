---
description: "Borrow or lend USDG through funded token offers, public borrowing requests and private negotiations."
---

# P2P stocks and tokens

Turret P2P matches a lender and borrower for a loan with an exact collateral quantity, fixed USDG repayment and deadline. The lender deposits USDG first. The borrower receives it only after accepting the funded offer and locking collateral.

Open [Borrow → P2P stocks & tokens](https://turret.capital/borrow/p2p), then choose your task:

| Task | Where to start |
| --- | --- |
| Borrow USDG | Compare **Funded offers**, publish **Borrowing requests**, or open **Negotiations**. |
| Lend USDG | Browse **Borrowing requests**, choose **Create lending offer**, or open **Negotiations**. |
| Manage my loans | Open **My loans**, **Withdrawals**, **Negotiations**, **Activity** or **Alerts**. |

These loans are separate from [pool loans](borrow.md) and [NFT loans](nft-loans.md).

## Borrow from a funded offer

1. Choose **Borrow USDG → Funded offers**. Browse without connecting a wallet; use the filters to narrow collateral, amount and duration.
2. Review **USDG received**, **total repayment**, **repay within** and **collateral at risk**. The duration begins when you accept; the offer expiry is the last time an unused offer can be accepted.
3. Connect the wallet holding the required collateral on Robinhood Chain. Review the exact terms, approve the collateral transfer if requested, then confirm acceptance.
4. After confirmation, the USDG is in your wallet and the collateral is locked. Save the loan link and final repayment deadline.

Each offer is accepted in full, once. Opening its details does not reserve it. A restricted offer can only be accepted by its designated borrower.

Collateral pricing shows a reference value and, when available, estimated sale proceeds for the selected amount. A reference in USD is different from a sale quote in USDG. Quotes expire, exclude gas and do not guarantee a sale or a suitable loan amount. Missing price estimates do not change the agreed loan terms.

## Ask lenders for a loan

Choose **Borrow USDG → Borrowing requests → Request a loan**. Set your collateral, USDG amount, interest, duration and request expiry, then sign to publish.

A lender can propose terms. Review the proposal before agreeing. The lender must then fund an offer and link it to the request; you must review and accept that funded offer to receive USDG.

**A request, proposal or agreement moves no funds and creates no debt.** Requests and their proposals are public. Cancelling a request removes that request from the workflow; it does not cancel an on-chain offer or active loan.

## Create a lending offer

Choose **Lend USDG → Create lending offer**, or respond to a borrowing request. Set the collateral token and quantity, USDG principal, fixed interest, whole-day duration, offer expiry and any designated borrower.

Review the terms, approve USDG if requested and confirm **Fund offer**. The full principal moves into the contract. It remains reserved until acceptance, cancellation or release after expiry. Unaccepted offers earn no interest.

You can cancel an unaccepted offer, then withdraw its USDG. Once accepted, lending funds remain committed until repayment or default settlement. Pooled Earn deposits do not fund P2P offers automatically.

## Negotiate a funded offer

On an eligible current offer, choose **Propose different terms**. Unlock **Negotiations** with a wallet signature to view conversations belonging to that wallet. Either participant can counter; the other must agree to the latest revision. Compare the original and proposed collateral, USDG amount, total repayment and duration before signing.

The response deadline limits agreement to the proposal. The replacement offer has its own acceptance expiry. Neither is the repayment deadline of a loan that has not started.

Agreement does not edit the original offer. The lender completes separate steps:

1. Start replacement and cancel the original offer on chain.
2. Withdraw its released USDG to the lender's wallet.
3. Fund the agreed replacement, restricted to the negotiating borrower.
4. The borrower reviews and accepts the replacement to start the loan.

Until cancellation confirms, the original offer can still be accepted under its existing terms. Only one conversation can be selected to replace that source offer at a time. Closing a conversation before replacement starts does not cancel the funded offer.

If confirmation is uncertain, return to the conversation and use transaction recovery to check the submitted hash. Do not assume a missing confirmation means funding failed. Once the original is cancelled, it is not automatically restored if replacement is interrupted.

Conversation access is limited to the participating wallets in the app. Funded offers, transactions and accepted loan terms remain public on chain. This private negotiation flow applies to current token markets; NFT lending uses its [own workflow](nft-loans.md).

## Repay and recover collateral

The borrower owes the principal plus the full fixed interest, even when repaying early. Partial repayments are not supported. For example, 1,000 USDG principal with 20 USDG interest requires 1,020 USDG in one repayment.

The initial final deadline includes a **24-hour grace period after the due date**. Repayment must confirm by the displayed final deadline. Transfers, failed transactions and network delays do not extend it.

Open the loan from **Manage my loans → My loans** or [Portfolio](portfolio.md). The guided flow has two transactions: **Repay USDG**, then withdraw the collateral to your wallet. Token approval may also be required. Cancelling the withdrawal leaves the loan repaid and its collateral available for later withdrawal.

Current token markets also offer **Repay using your USDG credits**. Review the credits you own in that same market and any remainder paid from your wallet. Only loaded credits are included, up to 16 source loans per repayment. This still repays the full debt in one transaction; credits from other markets or NFT loans are not included.

## Agree a deadline extension

On a current active token loan, either participant can choose **Agree a deadline extension**. Both parties must confirm the extension on chain. It changes the final deadline without adding interest or changing the repayment amount.

A pending proposal does not pause the existing deadline or prevent default settlement. An overdue loan can be extended only while it remains unsettled. Review the proposed **final deadline** exactly; do not add another grace period to that displayed time. Older retained markets and NFT loans do not offer this extension flow.

## If the deadline is missed

After the final deadline, repayment is no longer accepted unless both parties complete a permitted extension before settlement. Default settlement assigns the loan's remaining collateral to the lender. No further USDG is then owed.

P2P has no price-triggered liquidation, collateral sale or surplus refund. Borrowers can lose collateral worth more than the debt; lenders can receive collateral worth less than the USDG lent.

## Withdraw settled funds

Choose **Manage my loans → Withdrawals**, or **Ready to withdraw** in Portfolio. Repayment, default settlement, cancellation and expiry release assets into credits first. A separate transaction transfers them to the chosen recipient wallet.

Current markets keep credits with each loan. Review **Recorded credit**, **Available in this vault** and any **Token shortfall**. If less than the recorded amount remains, **Withdraw available, keep unpaid credit** preserves the unpaid claim. **Withdraw available and write off rest**, or **Write off this credit**, permanently gives up the unpaid balance and requires explicit acknowledgement. Other loans do not cover that shortfall.

Older markets remain accessible for existing loans and withdrawals. Their credits and available actions can differ from current markets.

## Track activity and reminders

**Activity** shows loan events. Under **Alerts**, verify your wallet and confirm an email address or Telegram subscription when those channels are available. Alerts cover deadline reminders and loan updates; they do not repay or extend a loan.

**Download calendar reminders** adds reminders one day and one hour before the final deadline. Replace the file after an agreed extension and remove reminders after settlement; imported calendar events do not update automatically. Automatic alerts can be delayed or missed, so keep track of the loan itself.
