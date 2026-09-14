# Turret memecoin borrowing

Product and implementation specification · 12 September 2026 · Draft 1

**Direction approved:** make memecoin borrowing the primary Turret product on Robinhood Chain. Build around fixed-term, collateral-backed USDG loans. Begin with this specification, then implement the borrower experience and funded-offer infrastructure.

**Build status:** release A is deployed and verified on production (`d9cef3b3-2a65-43fc-bc5a-7e989524cbd8`, 12 September 2026). It uses existing V3 contracts and independent lender funding. The post-release CASHCAT read found one borrower request and zero funded offers. Automated seeding and reusable facilities remain later releases; no capital allocation or signing mandate is configured. Numbers explicitly marked as examples or proposals are not live offers. See the [implementation evidence](../output/memecoin-switch-20260912/implementation.md).

**Individual P2P completion check, 12 September:** the scoped follow-up deployment `82c5c2d0-05b0-4aa4-af5d-957c5f16867e` is successful. Its frozen source passes 156 tests; 13 live routes and all 87 new assets match the verified package. The UI correctly states that lenders can claim collateral after the final deadline. See the [requirement audit](../output/memecoin-switch-20260912/claim-copy/scope-audit.md). Lender-funded availability remains external market supply, not a Turret treasury requirement.

**Implementation steering, 12 September:** the owner chose to start with independent P2P lenders. Each lender supplies their own USDG and selects their terms. Treasury-funded automated seeding is optional; it is not a prerequisite for enabling independent lending. The operator remains a subsequent optional integration. No shared lending budget is assumed.

**Scope clarification, 12 September:** the owner reiterated that this build is individual P2P memecoin loans and questioned whether the reusable-balance preview required Turret liquidity. Active work returns to the existing V3 offer/request/accept/repay/withdraw flow. Reusable facilities (C), their new fees and treasury remittance integration are deferred local experiments, not release requirements or a reason to request treasury funding. The populated facility preview used illustrative values; its local browser fixture uses disposable test assets. Neither represents production lending capital. Do not resume B or C simply because an automated goal continuation arrives.

## 1. Product promise

**Borrow against memecoins, stocks and NFTs**

The owner restored this wider headline on 12 September. Memecoin discovery is an entry point within the full product, not a replacement for its stock and NFT messaging. The hero supporting copy is: “Borrow USDG against supported assets without selling them. Choose a pool loan or agree terms directly with a lender on Robinhood Chain.”

Supporting copy for fixed-term loans:

> Receive USDG against your memecoins. Repay the agreed amount by the final deadline to reclaim your collateral. Price changes alone do not trigger liquidation.

The repayment consequence belongs beside the terms and signing button:

> If you miss the final repayment deadline, the lender can claim all the collateral committed to this loan.

This promise applies to fixed-term loans. Pool borrowing retains its price-based liquidation rules and must be clearly labelled wherever offered. “Keep the upside” means the borrower can recover the deposited quantity by repaying; it does not promise profit, continued wallet custody or preservation of ownership benefits during escrow.

The user chooses a token, an available loan amount and a duration. Turret presents funded terms. The borrower approves collateral and accepts on chain. The lender supplies existing USDG; Turret does not mint it.

## 2. Why the option analogy matters

The borrower can repay to recover valuable collateral or allow a default when repayment is unattractive. This creates option-like economics inside the loan. The first release remains a lending interface: it introduces no separately tradable option, premium token or exercise transaction.

Consider an illustrative loan of 100 USDG against 1,000 tokens, with 10 USDG fixed interest. Repayment is 110 USDG. These are teaching numbers, not proposed lending terms.

| Collateral value at settlement | Economically rational choice, ignoring costs | Lender receives | Borrower retains at settlement |
| --- | --- | --- | --- |
| 200 USDG | Repay 110 USDG | 110 USDG | 1,000 tokens, worth 200 USDG, after paying 110 |
| 60 USDG | Allow default | 1,000 tokens, worth 60 USDG | No collateral; no additional payment in this contract |

The borrower received 100 USDG at loan opening in both cases. The lender initially supplied that 100 USDG. Ignoring timing, execution costs and transfer restrictions, the lender's terminal receipt is `min(collateral value, repayment)` and the borrower's residual collateral value is `max(collateral value − repayment, 0)`. These expressions assume economic exercise; actual users can miss deadlines or lack repayment funds.

Lenders therefore price duration, volatility, token restrictions and the possibility of deliberate default. The repayment threshold per token is `repayment / token quantity`; a lender's acquisition cost after default is `principal / token quantity`, before costs. These are different quantities. “No price liquidation” does not make the loan safe for lenders or guarantee collateral recovery for borrowers.

## 3. Verified starting point

The [read-only snapshot](../output/memecoin-switch-20260912/snapshot.json) was taken on 11 September 2026 at 23:56:07 UTC, block 60661327. It records a point in time, not continuing availability.

| Surface | Finding |
| --- | --- |
| CASHCAT pool | 200.000155 USDG available, 200 USDG debt limit, zero outstanding principal |
| CASHCAT pool terms | 30% maximum starting LTV, 50% liquidation threshold, 10% borrower APR, 10 USDG minimum debt |
| CASHCAT, PONS and INDEX V3 | Unpaused; zero offers created in each deployment; expected manager runtime hashes verified |
| Catalog | 13 pools and 19 current V3 token markets, plus legacy deployments |

CASHCAT was the initial collateral target. PONS passed renewed live identity checks and an actual-token V3 fork lifecycle on 12 September and is live in the memecoin selector in deployment `b1f2914c-afd8-4543-8a5b-403c90b2c946`. INDEX remains in the broader token marketplace; its stock-dividend positioning is not silently relabelled as a memecoin. Existing listings do not establish liquidity, fair pricing or demand. See [expansion evidence](../output/memecoin-expansion-20260912/README.md) for the current publication status.

The current [V3 contract](../contracts/p2p/src/TurretP2PLendingV3.sol) already provides funded public offers, per-offer custody, fixed interest, whole-day durations, a 24-hour grace period, bilateral extensions and separate withdrawal credits. Each offer is accepted in full. It has no partial fills, reusable lending facility, protocol fee or cross-lender refinance.

## 4. Release scope

| Release | Deliverable | Dependencies |
| --- | --- | --- |
| A: borrower experience | Memecoin-first discovery, exact funded terms, acceptance and loan management using V3 | Existing deployments and verified offer data |
| B: funded availability | Bounded lender operator that creates, expires, cancels and replenishes offers | Specified lender capital, signer mandate and per-token pricing policy |
| C: reusable lending | New contracts for reusable lender capital, partial draws and explicit fees | Accounting design, implementation, validation and new deployment |

A supports independent lenders funding their own offers and is the first launch. B can subsequently add automated lender supply under an explicit mandate. A can be built and reviewed with labelled local fixtures; live availability must always come from actual funded offers. C is a separate contract release, not a hidden dependency for delivering A.

Stocks, NFTs, existing pools and all existing loan management remain accessible. Existing agreements stay at their original contracts. The first release does not introduce perpetual loans, automated refinancing, new cashback eligibility or pooled exposure to arbitrary tokens.

## 5. Borrower experience

### Discovery

Owner correction (September 12): keep the existing three loan types: Pool loans, P2P stocks & tokens, and P2P NFTs. Memecoins are a subsection of the P2P marketplace, grouped in its existing collateral filter; they do not add a top-level tab. `/borrow` opens the broad pool directory with the established headline covering memecoins, stocks and NFTs. Preserve engine and market query routes, `/borrow/pools`, `/borrow/p2p`, `/borrow/nfts`, and legacy deep links.

Show supported wallet holdings first when connected. A disconnected visitor can browse real offers. A token row contains its verified identity, wallet balance when available, funded loan sizes and available durations. A dollar reference value is secondary and carries its source and timestamp.

Availability is explicit:

| State | What the user sees | Action |
| --- | --- | --- |
| Matching offer available | Exact USDG principal, token collateral and total repayment | Review loan |
| Offers exist at other amounts or durations | The actual alternatives | Choose an alternative |
| No funded offers | “No funded offers available” | Request a loan |
| Offer data unavailable or stale | “Unable to check loan availability” | Retry |
| Token unsupported | “This token is not supported” | Browse supported tokens |
| Market paused | New borrowing unavailable; existing management visible | Manage existing loans |

Do not turn a failed fetch into a zero balance or an empty market. A loan request is not an offer, reservation or guarantee of funding.

### Amount and term

For V3, present exact funded sizes and whole-day durations. An amount input may search for matching offers, but cannot resize a contract offer. If the user asks for 75 USDG and only a 100 USDG offer exists, show the 100 USDG terms as a separate choice; never silently increase the amount or imply a partial fill.

When multiple offers match principal and duration, compare full repayment and collateral required. The lowest interest offer is not necessarily best if it locks substantially more collateral. Show both values; do not use an unexplained “best” badge. Never combine two offers into a fictional single atomic loan.

### Review and acceptance

The review shows collateral quantity and contract identity, USDG received, fixed interest, total repayment, duration, acceptance expiry, and the repayment consequences. Before acceptance, show projected due and final dates as estimates. After confirmation, derive them from the accepted loan's on-chain `dueAt` and grace period.

Keep the main mobile flow compact: inputs, a short term summary, the primary action and local feedback. Put extended contract details in a disclosure. Do not recreate a tall preflight checklist above the form. The official icon is `public/brand/turret-mark.svg`; reuse the asset directly.

The transaction sequence is connect → switch network if required → approve exact collateral if needed → accept offer → confirmed loan. Check collateral balance, ETH for fees, allowance, offer status and actual vault backing. Approval alone does not start a loan or reserve an offer.

Show immediate local progress during preflight and wallet requests. Explain rejected signatures, insufficient balances, expired or already accepted offers, unavailable RPC and pending wallet requests beside the action. Keep transaction hashes visible after broadcast. Reconcile an uncertain result before asking for another send; an RPC timeout is not proof of transaction failure.

### Management

The portfolio shows total repayment, due date, final deadline, collateral and separate actions for repayment, extension and withdrawal. Early repayment still owes the full fixed interest in V3. There is no partial debt repayment.

Repayment creates collateral credit; the borrower must then withdraw it. The interface says “Repaid — withdraw collateral” until withdrawal confirms. Likewise, lender USDG credits and defaulted collateral claims are not wallet receipts. Nominal claims, available backing and any writeoff remain visibly distinct.

Extensions require both parties' on-chain agreement. A pending proposal leaves the deadline unchanged. Existing reminders remain a convenience, with dates visible in the portfolio regardless of notification delivery.

## 6. Loan states and time boundaries

| State | Allowed outcome in the existing V3 design |
| --- | --- |
| Open, before offer expiry | Eligible borrower accepts; lender may cancel; whichever confirms first determines the state |
| Open, at or after offer expiry | Acceptance fails; expiry settlement releases lender credit |
| Active, through the final deadline | Full repayment can settle the loan; a mutually accepted extension may change the deadline |
| Active, strictly after the final deadline | Repayment fails unless a valid extension is accepted first; default settlement creates lender collateral credit |
| Repaid | Borrower withdraws collateral; lender withdraws repayment credit |
| Defaulted | Lender withdraws collateral credit |
| Cancelled or expired | Lender withdraws principal credit |

Default is not an automatic asset transfer at the deadline. A transaction settles it, followed by withdrawal. An extension after the deadline can race with default settlement; the confirmed transition governs. The UI must not claim that repayment remains possible merely because default has not been claimed.

Pausing new lending does not extend deadlines or turn off recovery. Preserve the current contract's repayment and withdrawal behavior.

## 7. Lender funding and offer operator

Lenders explicitly choose which tokens they are willing to receive after default. The lender view shows USDG committed, open-offer reserves, active principal, recoverable USDG, collateral received and realized outcomes. Collateral inventory is displayed as tokens, not guaranteed USDG principal recovery.

The first operator works for one explicitly configured lender mandate. It is not a service that signs for every connected wallet. Reuse the existing signing pattern only after verifying that the account and authorization match this mandate; the historic buyback signer is not automatically a lending signer.

Required policy fields:

| Group | Fields |
| --- | --- |
| Identity | Chain, manager, token pair, runtime pins, lender and policy version |
| Capital | Total mandate, per-token exposure, active-plus-open commitment limits, gas budget |
| Terms | Allowed exact principals, durations, collateral quantities, fixed interest and offer lifetimes |
| Pricing | Sources, freshness, permitted movement, sale-size observations and quote rejection rules |
| Operations | Pending transaction limit, fee limits, nonce ownership, alert destination and stop controls |

The worker reserves capacity before sending, records transaction intent and hash durably, and reconciles receipts and chain state after interruption. Cancelled or expired offers release credits, not liquid wallet capital. Replenishment requires confirmed recovery of those credits; do not spend nominal credits as though they were in the wallet.

Active principal, live open offers and pending commitments consume the mandate. Received collateral consumes a separate inventory limit. A default must not reset exposure and allow unlimited lending while unsold tokens accumulate. Record realized loss separately from unsettled or unsold collateral.

Offers expire quickly enough for the selected pricing policy and refresh only from qualified data. A price move can still occur before expiry or before cancellation confirms. Stopping the worker stops new actions; already funded offers remain executable until expiry, cancellation or a contract pause takes effect. The stop procedure must report that residual exposure.

## 8. Token qualification and sizing

Qualification binds chain and exact contract address. Verify escrow entry, payout, repayment and both repayment/default withdrawals using actual token code on a local fork. V3 supports exact-transfer, non-rebasing tokens. Exclude incompatible taxes and rebasing behavior from this release.

Record upgrade, freeze and transfer controls; holder concentration; trading venues; liquidity ownership and removal rights; source freshness; and sell quotes at proposed exposure sizes. Lenders must price token-wide restrictions and correlated defaults. Report unsupported or unavailable observations rather than inventing values.

Fixed-term lenders select principal and collateral requirements from their own risk mandate. Pools require a separate liquidation and pricing qualification. No universal LTV or APR is specified by this document.

Capacity must be funded. For example, 100 concurrent loans averaging 100 USDG require 10,000 USDG of active principal, before open-offer reserves, gas and other liquidity. That example is not a capital request. The existing 1,000 USDG cashback campaign and staking reserves have their own obligations and are not this product's seed capital.

## 9. Fees, staking and incentives

Release A/B uses V3's actual economics: all fixed interest goes to the lender, and protocol fees are zero. The UI must not promise that this volume funds TURRET rewards or burns.

For release C, the proposed baseline is a 10% protocol share of interest actually collected, with 90% to the lender. This matches the observed CASHCAT pool fee basis, but is a design proposal requiring a commercial decision, not an approved new contract parameter. Principal is excluded. Do not book uncollected interest or defaulted collateral as USDG fee revenue.

Illustratively, a 100 USDG principal repaid with 10 USDG interest returns 109 USDG to the lender and creates 1 USDG of protocol fees. If routed under the existing 50/50 fee split, 0.50 USDG funds staker rewards and 0.50 USDG remains at treasury. Treasury retention does not itself buy or burn TURRET.

Release C needs explicit collection and routing, receipt deduplication, rounding rules and reconciliation of gross interest, lender proceeds and protocol fees. Keep subsidy accounting separate from earned fees.

The initial memecoin P2P release has no new cashback. The existing pool campaign continues under its own policy. Related wallets could manufacture P2P interest and reclaim it while extracting cashback; future incentives must be bounded by real non-refundable fees and a separate campaign budget. Loan volume and different wallet addresses alone do not establish genuine economic activity.

## 10. Reusable funding: next contract design

The preferred first design for release C is a facility per lender and collateral token, with individual lender accounting. This avoids introducing pooled lender shares and a new valuation model in the same release. The borrower can compare offers from multiple facilities.

A lender deposits USDG once, sets an enforceable allocation, and permits loans within explicit terms. Each draw atomically consumes available capacity. New pricing instructions cannot alter existing loan terms. Idle, uncommitted cash can be withdrawn; active loan principal cannot. Cancellation and draw races must resolve on chain without double spending the allocation.

Before coding, specify quote authorization, signer revocation, nonces, expiries, partial-fill rounding, interest calculation, fee collection, principal accounting, per-loan collateral custody and default recovery. The policy service may price a quote; only contract checks and borrower consent can authorize its execution. Choose quote freshness and maximum exposure together.

Preserve fixed-term repayment and default semantics unless a separate change is specified. Refinancing and pooled lender vaults are later work. Existing V3 loans remain manageable and do not migrate automatically.

The detailed [facility specification](turret-p2p-facility-spec.md) now defines these choices, and [TurretLenderFacility](../contracts/p2p/src/TurretLenderFacility.sol) implements a local candidate. Its 25 tests include 1,000 cases each for rounding, fee bounds and 32-step lifecycle sequences. Actual-token local-fork lifecycles passed for CASHCAT and PONS at block 60688382. See [facility evidence](../output/memecoin-switch-20260912/facility-candidate.md). This is not deployed: quote publication, wallet integration, fee routing and a verified deployment configuration remain outstanding.

## 11. Implementation work packages

| ID | Work | Completion evidence |
| --- | --- | --- |
| M1 | Define market and offer availability model; reuse existing client and cache | Validated manager identity; correct expiry, backing and unknown-state handling |
| M2 | Build memecoin discovery and exact-term selection | Desktop/mobile review for funded, empty, stale, disconnected and unsupported states |
| M3 | Integrate approval, acceptance and portfolio continuation | Wallet lifecycle checks, visible local errors, pending receipt recovery and deep-link preservation |
| M4 | Implement lender operator in observation mode | Deterministic budget ledger, pricing rejection, nonce recovery and cancel/accept race tests |
| M5 | Prepare lender mandate and funded pilot | Concrete terms and capital source recorded; fork lifecycle evidence; authorized canary receipts |
| M6 | Release borrower flow and funded availability | Verified production files, on-chain offers, fresh status and rollback package |
| M7 | Design reusable facility and fees | Contract specification with allocation, loss and fee invariants settled before implementation |

M1–M3 constitute the independent-P2P launch. M4–M5 belong to optional automated seeding and do not gate that launch. M4 can run on local fixtures and read-only production observations. M5 requires the specific lender mandate; elapsed time or general enthusiasm does not set its budget or interest rates. For M6, distinguish deployment of discovery from actual funded availability: an empty market can accept requests and new lender offers, but cannot advertise executable loans.

Implementation touchpoints: [borrow directory](../frontend/app/src/borrow/PoolLoanDirectory.tsx), [P2P screen](../frontend/app/src/screens/P2PLoansScreen/P2PLoansScreen.tsx), [P2P client](../frontend/app/src/p2p/client.ts), [pending transactions](../frontend/app/src/p2p/pending-transactions.ts), [market cache](../frontend/app/src/p2p/public-market-cache.ts), [V3 contract](../contracts/p2p/src/TurretP2PLendingV3.sol), [fee router](../contracts/rewards/src/TurretRecoverableFeeRouter.sol) and [cashback accounting](../services/borrower-cashback/src/accounting.mjs).

The root checkout contains unrelated changes and older descriptions of deployed behavior. Begin implementation from the verified production baseline and reconcile the relevant source overlays. Do not deploy a wholesale root build as this feature. Route changes need coverage for existing query-based loan pages and preserved stock/NFT repayment and withdrawal paths.

## 12. Acceptance and rollout

Before release, verify the following behavior:

- A borrower can identify and accept a real funded offer, see its confirmed deadline, repay, and withdraw collateral.
- Two borrowers racing for one offer cannot both receive its principal. Approval does not imply reservation.
- Exact offer expiry and final repayment deadline boundaries match the contract, including the grace period.
- Insufficient collateral, gas or USDG; wrong network; token restrictions; wallet rejection; and stale data produce visible actionable feedback.
- A pending transaction survives reload and worker restart without an unintentional duplicate send.
- Early repayment, extension races, default settlement, collateral shortfalls and separate credit withdrawals have correct results and labels.
- Operator budgets include pending and open commitments. Cancellation races, lost receipts, reorgs and failed credit withdrawals cannot free capital prematurely.
- Existing loan management remains usable if the new directory or offer service is disabled.

Use local lifecycle tests and actual-token fork scenarios before any funded production canary. Production read-only checks prove deployment state, not successful financial lifecycles. Record which type of evidence each check provides.

A frontend rollback restores the prior verified package. An operator stop does not cancel funded offers or erase borrower obligations. Preserve its journal and report outstanding offers and active loans during rollback.

Measure funded capacity by token, exact-term coverage, successful acceptances, unique borrowers, repayment cycles, failed transaction stages, committed capital, defaults, recovered collateral, realized lender results and net protocol fees. Separate operator/test activity and identify concentrated activity before reporting adoption. Numerical growth targets follow a real baseline; no adoption or profitability forecast is asserted here.

## 13. Decisions still needed for activation

| Decision | Current status |
| --- | --- |
| Product and chain | Approved: memecoin-first borrowing on Robinhood Chain |
| Initial mechanism | Independent fixed-term V3 P2P offers. Reusable facilities are deferred, with no automatic follow-on activation. |
| Initial collateral | CASHCAT plus verified PONS expansion; subsequent tokens require exact addresses and matching P2P deployments |
| Lending capital and account | Independent lenders supply their own USDG for release A. An optional operator mandate remains unset. |
| Offer prices and duration | Independent lenders choose their own exact terms. An optional operator's policy remains unset. |
| New protocol fee | Proposed 10% of collected interest in release C; not active or approved as a deployment parameter |
| New borrower incentives | Excluded from the first P2P release |

Independent lenders can use the existing offer flow without a Turret capital allocation. Unset operator and facility decisions belong to deferred releases and do not block the individual P2P interface or its verification.

## References

- [Initial feasibility review](../output/memecoin-switch-20260912/plan.md) and [snapshot reader](../output/memecoin-switch-20260912/snapshot.mjs).
- [V3 recovery design](turret-p2p-v3-spec.md), interpreted alongside current code and the production registry because its deployment-status paragraph is historical.
- [Paradigm: Blend](https://www.paradigm.xyz/writing/blend), explaining the embedded option and lender risk in collateral-backed loans. Its perpetual auction design is not included in this release.
- [Gondi refinancing](https://docs.gondi.xyz/gondi-v3/refinancing/), a reference for later lender replacement constraints, not a current Turret capability.
