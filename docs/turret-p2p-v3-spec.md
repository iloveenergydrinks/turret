# P2P V3 recovery design

Status: implemented; contract, actual-token fork and browser lifecycle checks passed; production deployment is pending owner wallet confirmation. See [the internal review and release evidence](turret-p2p-v3-internal-review-20260907.md). On 7 September 2026 the product owner explicitly chose internal review and testing because an independent review is outside the available budget. This does not constitute an independent audit. V1/V2 agreements remain unchanged.

## Accepted-loan index

Only acceptance adds a borrower obligation. Unsolicited private offers occupy a separate incoming-offer index. Settlement removes the loan from the active set; a separate append-only history preserves auditability. Pagination must tolerate additions and removals without silently losing active IDs. Acceptance/settlement events include indexed borrower and lender fields for independent recovery tools. Settlement remains constant-time in total loan count.

## Mutually agreed extension

Both the borrower and current fixed lender must approve an exact new final deadline. No administrator or third party may extend it. Prefer two explicit onchain approvals for the first version rather than introducing offchain signatures, relayers and replay domains at the same time.

An extension proposal binds contract, chain, loan ID, proposer, monotonically increasing nonce, old deadline, new deadline and proposal expiry. The other party accepts; the proposer may revoke. A change of state, deadline or nonce invalidates an older proposal. A borrower/lender may propose but cannot accept their own proposal. New deadline must strictly increase and stay within the supported calendar range. The proposal adds no interest or compensation in the first version; any price change requires a separately specified feature.

An active but expired, unclaimed loan may be extended only with both parties' consent. Default settlement and extension acceptance are competing state transitions: whichever confirms first determines the result. Creating an extension proposal alone never blocks the lender's default right. Repayment/default terminal states cannot be reopened. Guardian pauses do not change consent or terms.

Acceptance checks: exact-deadline races, stale/revoked proposals, two competing extensions, unrelated acceptors, repeated acceptance, overflow, settled loans, pause state, and event/state consistency. Each successful extension must be visible in the loan timeline and require a new explicit agreement.

## Repayment using withdrawal credit

Allow the caller to choose an exact amount of their own USDG credit to apply, from zero through the agreed repayment amount. Debit only that caller's credit and aggregate USDG credit liability; pull the remaining USDG from that caller; atomically credit the lender and release the borrower's collateral credit. A third-party payer cannot spend either party's credit or allowance. No partial debt repayment is introduced: the total obligation still settles in full or the transaction reverts.

Acceptance checks: all-credit, all-wallet and mixed funding; lender equals payer; third-party payer; insufficient credit/allowance; token transfer failure rollback; backing before/after; total liability conservation; and no event/state publication on a reverted transition.

## Insolvency handling

V3 uses one dedicated vault for each offer, created before funding. Its loan and collateral tokens never share custody with another offer. Each token has one eventual beneficiary under that offer's state: cancelled/expired principal and repaid USDG go to its lender; repaid collateral goes to its borrower; defaulted collateral goes to its lender. Fixed principal, interest and deadlines do not change automatically after an external token loss.

The pair's manager creates a fixed vault implementation in its constructor and uses OpenZeppelin 4.9.5 EIP-1167 clones. There is no initializer, implementation replacement or administrator transfer path. The implementation embeds the manager and token pair as immutables; only that non-upgradeable manager can instruct a vault transfer. [OpenZeppelin clone documentation](https://docs.openzeppelin.com/contracts/4.x/api/proxy#Clones).

A shortfall is local to the affected offer. Acceptance requires that offer's vault to hold the full promised principal. Subsequent funding uses a new vault and cannot recapitalize the old offer. A transfer restriction may still prevent a vault's recovery, and a global issuer action may affect many vaults at once. Isolation cannot restore externally destroyed tokens.

After settlement, the beneficiary's nominal claim remains separately recorded. Available recovery is `min(remaining nominal claim, actual vault token balance)`. An exact partial withdrawal reduces the nominal claim only by the amount received, preserving any remaining claim. The separate `withdrawAvailableCredit` action explicitly closes the entire remaining claim, transfers the available amount and writes off the difference. It takes a caller-specified minimum receipt; a zero receipt requires an explicit zero minimum. Failed transfers revert both payment and writeoff. The UI must distinguish these actions and obtain an explicit loss acknowledgment for a writeoff.

Only the affected beneficiary can choose to close a claim. Neither withdrawal order nor fresh funding in other vaults changes their recovery. Aggregate `credits` and `totalCredits` remain nominal display figures; they are not manager token backing or guaranteed spendable balances. Tokens donated above the nominal claim have no rescue path and do not increase the agreed claim. Recovery after a complete writeoff does not recreate a claim.

Credit-funded repayment selects at most 16 strictly increasing source offer IDs within the same manager. Every source is a settled or cancelled/expired USDG claim owned by the caller, with enough actual balance for the selected amount. Exact token transfers move selected credits directly from their source vaults to the target vault. The caller supplies the exact remaining wallet amount. The target must receive the full debt as new transfers in this transaction; pre-existing donations cannot count as repayment. All source debits, transfers and debt settlement revert together on any failure. No deficit is spread to other loans and no partial debt repayment is introduced.

Repayment after a collateral loss still settles the fixed USDG obligation and assigns the remaining collateral claim to the borrower. Before confirmation the UI shows the available collateral and any shortfall; default continues to assign that loan's collateral claim to its lender. There is no promise of collateral restoration, guaranteed principal recovery, automatic debt reduction or paused repayment clock.

## Guardian rotation

Use two-step nomination and acceptance, with a nonzero replacement. The current guardian retains its limited new-exposure pause power until acceptance. Rotation does not alter token bindings, terms, credits or existing repayment rights. Emit nomination and acceptance events; test unauthorized calls and repeated/stale nominations. Rotation does not introduce escrow upgrades or asset-seizure powers.

## Migration and release acceptance

Deploy separate V3 managers only after the internal release checks complete without unresolved implementation failures. The product owner has accepted proceeding without a paid independent review; the release must retain an explicit unaudited status. Existing V1/V2 offers and loans remain at their original addresses and remain manageable in the portfolio. The UI labels versions, never silently migrates funds, and requires new explicit funding for new V3 offers. Immediately before cutover, recheck existing obligations and pause new V1/V2 exposure without restricting recovery.

The release package must identify source/dependency/compiler hashes, exact deployment calldata and immutables, token qualification, stateful tests, actual-token fork tests, browser transaction tests, and reviewed fixes. No production deployment is authorized merely by this specification's existence.
