# P2P V3 internal review and release evidence

Status on 7 September 2026: implemented and tested; production deployment and website cutover are pending the owner wallet transactions. This is an internal review, not an independent audit. The product owner explicitly accepted that limitation because an external review is outside the available budget.

V3 deploys new contracts. It cannot change V1/V2 agreements or move their funds. All 20 existing registered contracts remain accessible for recovery; the release procedure pauses their new offer creation and acceptance before switching the website to 19 new V3 markets. Pooled Borrow and Earn contracts are outside this change.

## What changed

Each funded offer has its own immutable token vault. A loss of tokens in one vault cannot be covered by another loan's funds. Settlement records the agreed claim, while the interface separately shows the actual amount available. A beneficiary can withdraw the backed portion and retain the unpaid claim, or explicitly accept a permanent writeoff. Donations above a claim do not create withdrawal rights, and a completed writeoff does not recreate rights if tokens later arrive.

Repayment can combine the caller's settled USDG credits from at most 16 other loans in the same market with wallet funds. Transfers and full repayment happen atomically. Source IDs must be distinct and increasing; partial repayment of the debt is not supported.

Both parties can agree to a later deadline through an exact onchain proposal and acceptance. A proposal alone does not stop default. No additional interest is added, and a settled loan cannot reopen. The updated deadline appears in the loan, Portfolio and calendar reminders.

Private invitations have a separate inbox. Only accepting an offer creates a borrower obligation. A revision-checked index tracks active loans, separately from permanent history. Guardian replacement requires nomination and acceptance; the guardian can pause new lending but cannot withdraw users' funds or stop recovery.

## Validation

| Check | Result and scope |
| --- | --- |
| Complete contract suite | 155 tests across 16 suites passed: V1 42, V2 64, V3 including batch deployment 49. No failures or skips. |
| Stateful V3 accounting | 256 runs of 64 handler calls, 16,384 total calls, zero unexpected reverts. Inapplicable handler actions can return without a state change. Remaining claims are settled and recovered after each run. |
| Actual-token fork | All 19 supported collateral tokens passed funding, acceptance, extension, credit-assisted repayment, settlement and withdrawal checks at Robinhood Chain block 56855195. Actual token contracts and existing balances were used; no synthetic token balances or public transactions. |
| Browser loan lifecycle | Nine checks passed: funding into an isolated vault, acceptance, two-wallet extension, updated calendar, mixed-credit repayment, collateral withdrawal, partial shortfall recovery, explicit writeoff and private inbox. |
| Browser Portfolio and legacy recovery | Eight checks passed, including updated debt/deadlines and management links, 28 USDG actual backing versus 40 nominal/12 shortfall, complete repayment/cancellation/withdrawal of seeded V1 agreements, and extended debt remaining payable after its original deadline. |
| Frontend and server | 288 focused P2P and Portfolio tests passed, including connected-wallet restoration. The loan-index server passed 20 tests. Final TypeScript check passed. |
| Static analysis | Slither 0.11.6 completed 102 detectors, producing 29 raw reports. Internal triage established no confirmed V3 defect. There were 21 name-resolution warnings, which limit confidence in the affected analysis. |
| Deployment preparation | Three batches of 7, 7 and 5 markets passed read-only chain execution and local constructor verification. Independent internal checks reconstructed CREATE addresses and runtime immutables from the compiled artifacts for all 19 markets. |

No confirmed implementation defect remains from these completed checks. This is bounded evidence, not a proof that the contracts cannot fail.

The fork snapshot was block hash `0xbe21d481e7fdfa922368dd1972335e6a579f39fbc7f736abb544131b128f1f5b`. The 19 assets were AAPL, MSFT, GOOGL, AMZN, META, NVDA, AMD, MU, TSLA, SLV, CASHCAT, PONS, SPY, QQQ, GLD, COIN, PLTR, NFLX and INDEX.

## Remaining risks

Token issuers can restrict transfers, change implementations or remove tokens. Isolated custody prevents one loan from using another loan's assets, but cannot prevent an issuer action from affecting multiple vaults. Dishonest token balance reporting is outside the exact-transfer guarantees. A frozen token may prevent repayment or withdrawal until transfers work again; deadlines do not pause automatically.

Collateral prices can fall below the debt. Default assigns the remaining collateral to the lender; there is no promise of USDG recovery. The fixed interest is still owed on early repayment. Transaction ordering and chain timestamps determine expiry, extension and default boundaries. A late extension proposal does not prevent the lender from claiming an already-defaultable loan first.

The vault implementation and token pair are fixed. There is no upgrade mechanism or administrator rescue for mistaken transfers or surplus donations. New contracts require new explicit funding, and old token approvals do not authorize V3.

## Pinned contracts

Compiler: Solidity 0.8.24, Cancun, optimizer enabled with 200 runs. OpenZeppelin dependency: 4.9.5.

| Source | SHA-256 | Runtime bytes |
| --- | --- | --- |
| `TurretP2PLendingV3.sol` | `aa90a9c9d9e7dda5c404d728895546549c4532edb393d1233b369e2becbfef33` | 15,117 |
| `TurretP2PVaultV3.sol` | `b8d114275eb0788fab1f482affa7550288df6ae4ae61959e3cd82a0d894b8c34` | 2,089 |
| `TurretP2PBatchDeployerV3.sol` | `c3b73fb6c5aad7d01ad6e96d1c4ad0003e55856545d2fccf26884523022eb7f0` | 289 |

Detailed logs, source pins and browser evidence are retained under `/tmp/turret-p2p-v3-20260907`; the durable release evidence is collected under `output/p2p-v3-release-20260907`. Deployment records must identify confirmed transaction hashes and canonical receipt blocks before any address is published. An uncertain wallet outcome requires reconciliation of the same nonce, never a duplicate deployment attempt.
