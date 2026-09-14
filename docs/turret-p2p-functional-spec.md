# Turret P2P loans

Functional specification · Approved for implementation · 7 September 2026

**Implementation authorized on 7 September 2026.** The user instructed implementation and end-to-end tests after reviewing this document. The first-release defaults below are the implementation baseline; availability is established by release verification, not by this specification.

## 1. What users should be able to do

Turret connects people who want to borrow USDG against their tokens with people willing to fund those loans. Any wallet can lend. Lenders choose the collateral they accept, the amount they will lend, the interest and the duration. Borrowers browse offers, compare the obligations and accept an offer that suits them.

Public offers are the normal path. A lender does not need to know a borrower’s wallet address. A private offer remains available when a lender wants to lend to one specific wallet.

Each loan is backed by its own agreed collateral and funded principal. Available borrowing grows when lenders fund more offers. Unused offers do not earn interest. P2P remains a separate product from Turret’s pooled Borrow and Earn accounts.

### Confirmed requirements

| Requirement | Expected behavior |
| --- | --- |
| Multiple collateral assets | Support Turret’s Robinhood stock and metal tokens, plus CASHCAT and PONS, after checking escrow compatibility. |
| Open lender access | Any wallet can lend its own funds. No owner-only lender list. |
| Public offers | A borrower address is optional. Public offers appear in a browsable marketplace. |
| Lender-selected terms | Lenders choose principal, required collateral, interest and duration. |
| Capacity based on funding | Remove the pilot’s 100 USDG per-loan and 1,000 USDG shared economic ceilings. |
| Consistent interface | Keep Turret’s navigation and visual identity. Inputs and dropdowns have the same height. |
| Clear loan presentation | Show what moves now, what must be repaid later, when it is due and what happens after default. |
| Real functionality | Verify complete wallet and loan lifecycles, including public offers and each eligible token. |

## 2. Assets and eligibility

USDG remains the currency lent, received and repaid in this release. Supporting several collateral tokens does not require several loan currencies.

The initial inventory to qualify is:

| Category | Collateral |
| --- | --- |
| Stock tokens currently represented in the live app | AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU, TSLA |
| Existing metal collateral | SLV |
| Other Turret assets | CASHCAT, PONS |

This inventory comes from the current production market configuration and Turret’s registered non-stock assets. Other Robinhood tokens present in the wider catalog follow the same qualification process. Reconcile that catalog before implementation; older project documents and the current live list differ. A “Coming soon” listing does not by itself establish escrow compatibility.

Eligibility means the actual token can be deposited, held, returned after repayment and delivered to a lender after default. Token units and decimals must be correct. Issuer restrictions, freezes, transfer fees or balance changes must be assessed for the exact asset. An asset that fails a required check stays visibly unavailable with a specific reason; it must not silently disappear or look funded.

P2P eligibility is separate from pooled-loan eligibility. Missing liquidation liquidity or a stale price feed does not automatically prevent a direct loan, because the loan settles in the agreed collateral after default. Token transfers must still work. Lenders remain responsible for deciding whether they want that collateral and on what terms.

## 3. Public and private offers

### Public offer: default

The form starts with **Public · Anyone can borrow** selected. No borrower-address field is shown or required.

The offer appears in the marketplace after its funding transaction is confirmed. Any other wallet with the required collateral can review and accept it. The accepting wallet becomes the borrower.

Opening a review screen or approving collateral does not reserve the offer. For a single-use offer, the first successful acceptance receives the loan. Other attempts must end with a clear “This offer has already been accepted” state, with no loan created and no principal or collateral transfer from the failed attempt. A separately confirmed token approval may still exist; it is not a completed loan.

The lender cannot accept their own offer from the same wallet. This does not imply that Turret can identify two different wallets controlled by one person.

### Private offer: optional

Selecting **Private · Specific wallet** reveals the borrower-address field. Only that wallet can accept. The lender receives a shareable offer link, and the intended borrower sees the offer when connected.

“Private” describes who may accept. It does not mean the terms, address or transaction are confidential on a public blockchain. Private offers are excluded from the general marketplace, but are not secret.

### Funding model

For the first release, use **funded offers**: the lender deposits the full USDG amount when publishing. That amount is reserved for the offer until it is accepted, cancelled or expires.

This makes “Available to borrow” mean confirmed funding exists. The same principal cannot be advertised as available in several offers at once. It also means lenders temporarily give up use of the money while an offer is open. This is the first-release funding model; signed offers that leave funds in the lender’s wallet would need different availability rules.

After cancellation or expiry, reserved funds become withdrawable by the lender. The UI must distinguish “Available to withdraw” from “Returned to your wallet.”

## 4. Choosing and reviewing terms

| Field | Functional behavior |
| --- | --- |
| Offer visibility | Public by default; Private reveals one borrower wallet field. |
| Collateral asset | Searchable selector with token symbol, name and verified identity. |
| Loan amount | Exact USDG amount the borrower receives. Must be positive and fully funded by the lender. |
| Required collateral | Exact quantity of the selected token. Must be positive. |
| Interest for this loan | A fixed USDG amount, including zero. Show total repayment immediately. |
| Loan duration | Presets plus custom duration. Positive whole days, starting when the offer is accepted. |
| Offer expiry | Lender-selected date and time after which an unaccepted offer cannot be taken. Separate from the loan duration. |
| Borrower wallet | Required only for a private offer. |

The old 10% interest ceiling, 7/14/30-day-only choices and one-hour offer-expiry ceiling are not carried forward as hidden rules. Validation covers meaningful amounts, supported token precision, valid dates, representable terms and available funds. Any business limit introduced later must be explicit in this specification and explained in the UI.

Interest is shown as an amount for the entire loan. An annualized comparison may be displayed secondarily, labelled **Annualized equivalent**, with its calculation explained. It must not be confused with the actual fee owed or compound yield.

Before acceptance, show duration and explain that the exact due date starts from confirmation. After acceptance, show the confirmed due date, final repayment deadline and timezone. Offer expiry no longer affects an accepted loan.

### Illustrative loan summary

These are example terms, not a price recommendation or a live offer.

| When accepted | Agreed amount |
| --- | ---: |
| Borrower receives | **1,000 USDG** |
| Collateral locked | **20 NVDA tokens** |

| Repayment terms | Agreed obligation |
| --- | ---: |
| Duration | **30 days from acceptance** |
| Interest for this loan | **20 USDG** |
| Total repayment | **1,020 USDG** |
| Grace period | **24 hours after the due date** |

The visual summary should make both outcomes clear: repay the agreed amount and recover the collateral, or miss the final deadline and forfeit the collateral. Do not turn an estimated collateral price into a guarantee that the loan is safe.

## 5. Main screens and user journeys

### Marketplace

Anyone can browse public offers without connecting a wallet. Each offer shows collateral asset and quantity, USDG principal, total fixed interest, total repayment, duration, offer expiry and confirmed funding status.

Filters cover collateral, loan amount and duration. Sorting supports newest, loan amount, duration and interest. A default “Best offer” ranking is not proposed: different collateral and durations make that claim ambiguous.

The primary action is **Review loan**. Connecting a wallet enables eligibility checks; it is not required just to inspect the terms. A private-offer link shows its terms and acceptance restriction without falsely suggesting that every visitor can borrow.

### Create offer

The lender selects visibility, collateral and terms. A live summary updates as they type. The lender reviews the exact USDG funding amount, risk of receiving collateral instead of repayment, and offer expiry before proceeding.

The transaction flow identifies token approval, offer funding, waiting for confirmation and confirmed publication separately. Only confirmed offers enter the available marketplace. The finished view provides **View offer**, **Copy link** and **Create another offer**.

### Accept an offer

The borrower reviews the collateral locked now and the repayment obligation later. Turret checks that the offer remains open, the wallet is eligible and has sufficient collateral, and the selected network is correct.

The borrower acknowledges the default consequence, approves the required collateral and confirms acceptance. A successful acceptance locks collateral and transfers USDG as one loan action. The resulting view shows the confirmed amount received and repayment timeline.

If the lender cancels, the offer expires or another borrower accepts first, the interface explains what changed and returns the borrower to available offers. It never presents a failed acceptance as a loan.

### My loans and offers

Use **Borrowing**, **Lending** and **History** views. Active obligations and approaching deadlines appear before settled history.

Borrowers see amount received, repayment due, collateral, due date, final deadline and repayment action. Lenders see open offers, reserved funding, active principal, expected interest conditional on repayment, maturity and any claimable collateral. Public/private visibility is explicit.

Lenders can cancel an open offer. To change its terms, they cancel and create another offer; accepted terms never change. A clear withdrawal area groups available USDG and collateral by asset and records successful withdrawals.

## 6. Repayment, default and available funds

The first release uses these settlement rules:

| State or action | Result |
| --- | --- |
| Open offer cancelled or expired | No loan exists. Reserved USDG becomes withdrawable by the lender. |
| Loan accepted | Collateral is locked, principal reaches the borrower and the loan duration starts. |
| Early repayment | Full agreed principal and fixed interest are owed. No extra early-repayment charge is added. |
| Partial repayment | Not supported in the first release. The repayment action clearly requests the full remaining agreed amount. |
| Repayment by the final deadline | Lender receives a withdrawal credit for principal and interest; borrower receives a credit for all collateral. |
| Grace period | Borrower may still repay the same agreed total during the 24-hour grace period. No automatic late fee. |
| Final deadline missed | The entire agreed collateral becomes claimable for the lender. Settlement closes the USDG debt. |
| Withdrawal | The asset reaches the recipient wallet only after its withdrawal transaction confirms. |

The final deadline is inclusive for repayment. Default settlement becomes available only after it has passed. Repayment and default cannot both settle the same loan.

There is no price-triggered liquidation in this model. A price fall can make the collateral worth less than the principal, leaving the lender with a loss. Conversely, a borrower who misses the final deadline can lose collateral worth more than the debt. There is no automatic sale, surplus refund or guaranteed USDG recovery.

A lender may have to wait through the loan term and ultimately receive collateral. Neither funded offers nor active loans are an instant-withdrawal savings product. Direct-loan balances and returns must remain distinct from pooled Earn balances and rates.

## 7. Interface requirements

Keep the full Turret header and Borrow, Earn, P2P and Portfolio navigation on every P2P screen. Use the existing warm background, charcoal text, Caslon headings, system-font controls, bordered panels and rounded buttons.

**All text, amount, date and duration fields, and all dropdowns, use the same 48px control height.** Labels align above the control. Helper text and errors sit below and do not change the control height. No 60px amount input next to a 48px dropdown.

Offer cards and loan details should have three clear visual groups:

1. **Exchange:** “Receive [amount] USDG” and “Lock [quantity] [token].” Token marks and an exchange connector reinforce the relationship; text remains sufficient on its own.
2. **Cost:** principal, fixed interest and a larger total repayment amount.
3. **Time:** acceptance, due date and final deadline, with the current stage identified. Before acceptance, show a relative duration rather than a falsely fixed due date.

Status appears in words as well as color. Avoid a green “safe” badge or an invented health score. Optional price estimates must include their source and update time, and unavailable prices must not be substituted with zero. Controls have accessible labels, keyboard operation and visible focus; larger text and zoom must not clip values or hide actions.

On phones, the order is exchange, cost, timeline, main action, then secondary details. Keep the repayment obligation and acknowledgment before the confirmation action. Wallet balances and long risk explanations must not push the primary loan facts out of view.

Suggested copy:

| Location | Copy |
| --- | --- |
| Public-offer helper | Anyone with the required collateral can accept this offer. |
| Private-offer helper | Only this wallet can accept. The terms remain visible on-chain. |
| Funding explanation | Your USDG is reserved when the offer is published. Cancel an open offer to make it withdrawable. |
| Interest label | Interest for this loan |
| Before acceptance | Receive [principal] USDG when accepted. Repay [total] USDG to recover [collateral]. Loan term: [duration], followed by [grace] repayment grace. |
| Active loan | Repay [total] USDG by [final deadline and timezone] to recover [collateral]. |
| Race lost | This offer has already been accepted. No loan was opened for your wallet. |
| No public offers | No public offers for these filters. Change your filters or create an offer. |

## 8. Failure and recovery behavior

Every disabled action has a specific nearby reason and a useful next step. Distinguish wallet disconnected, wrong network, insufficient USDG, insufficient collateral, insufficient network-fee balance, unavailable asset, expired offer and already-accepted offer.

Failed reads show “Unable to load” or visibly stale data, never fabricated zero balances or “No loans.” An unknown transaction outcome stays pending until it can be reconciled. A wallet rejection, a cancellation and a successful loan are different outcomes. Wallet-account changes cannot submit a continuation on behalf of the previous wallet.

Refreshes, reopening the page and desktop/mobile navigation preserve access to pending operations and existing obligations. Public offer lists update after acceptance, cancellation and expiry. Activity from unrelated wallets must not make a user’s own loans effectively undiscoverable.

Any emergency stop applies to new offers and acceptance. Repayment, refunds, settlement and withdrawals remain accessible, subject to the underlying token’s own restrictions.

## 9. Existing loans and rollout

The current SLV pilot keeps its original terms. Its offers, loans and withdrawal credits remain accessible in the new interface until resolved. A new release cannot silently migrate collateral, change accepted obligations or hide the old repayment path.

New offers use the new product rules only once that asset’s escrow behavior and complete user flows have passed verification. Available capital totals distinguish public offers available to accept, private offers, active principal and funds awaiting withdrawal. None of these totals includes pooled Earn capital.

## 10. Acceptance criteria

Before this product is described as working:

1. A wallet other than the owner publishes and funds a public offer without entering a borrower address.
2. Another eligible wallet accepts it, receives the exact USDG principal and sees the correct collateral and confirmed deadlines.
3. Competing acceptance attempts create exactly one loan, with clear feedback for the unsuccessful borrower.
4. A private offer can only be accepted by its intended wallet; its terms are not described as confidential.
5. Each eligible collateral passes funding, acceptance, repayment, default and withdrawal compatibility checks using the actual token on a pinned chain fork.
6. Loans above 100 USDG and combined commitments above 1,000 USDG work when funded. Another lender cannot consume a shared artificial capacity limit and prevent others lending.
7. Custom duration, fixed interest and offer expiry behave as reviewed, including early repayment and exact deadline boundaries.
8. Cancellation, expiry and settlement return funds to the correct withdrawal owner. Funds cannot be withdrawn twice or double-committed.
9. Existing pilot loans remain discoverable, repayable and withdrawable under their original rules.
10. Wallet rejection, pending/replaced transactions, wrong networks and failed reads never produce false success or lost access to obligations.
11. Desktop and phone flows retain the full app navigation, equal-height controls and readable exchange, cost and timeline summaries.
12. Live deployment and reads are verified separately from local transaction tests. Reports identify which checks used local assets, actual-token forks or production transactions; test data never appears as customer activity.

## 11. First-release defaults

The following defaults were included in the document when the user instructed implementation:

| Decision | First-release choice | Consequence |
| --- | --- | --- |
| Funding | Reserve USDG when publishing. | Public available capital is backed by deposited funds; lenders cannot use it elsewhere while the offer is open. |
| Offer size | One offer funds one loan, taken in full. | Simple exact terms. Reusable budgets and partial fills are a separate extension, not a hidden per-loan ceiling. |
| Interest and early repayment | Fixed USDG fee, owed in full even if repaid early. | Easy to compare total cost; shorter actual borrowing does not reduce the fee. |
| Partial repayment | Full repayment only in the first release. | No partial debt reduction or proportional collateral release. |
| Duration input | Presets plus custom positive whole days. | Removes the old fixed choices; intraday loans are not part of the first-release form. |
| Grace period | Keep 24 hours, displayed before acceptance. | A clear final repayment deadline, with no automatic late fee. |
| Platform fee | Add no new fee in this release. | Total repayment is principal plus agreed lender interest; network fees are separate. |
| Borrower requests and negotiation | Defer request listings, counteroffers, extensions and refinancing. | Borrowers initially choose existing public offers or receive private offers. |
| More complex collateral | One selected token per loan; defer baskets and NFTs. | Broad asset choice without combining several collateral assets inside one loan. |
| Other loan currencies | Keep USDG first. | Additional loan currencies require their own review and interface rules. |

The reference is PWN’s flexible direct-lending model: broad collateral, lender-chosen terms and deadline-based default. PWN’s [current product documentation](https://docs.pwn.xyz/) and [protocol repository](https://github.com/PWNDAO/pwn_protocol) inform this specification. They do not establish audit coverage, deployed availability or feature parity for Turret.
