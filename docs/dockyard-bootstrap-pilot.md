# Dockyard lender subsidy and DOCK pilot

September 6, 2026. The user selected USDG subsidies and DOCK distribution for lenders, with the purpose of making more USDG available for borrowing. This replaces the earlier borrower-rebate assumption. Numerical terms below are recommendations; no campaign is activated and no spending amount has been selected.

Lenders would receive borrower-funded interest, a temporary treasury-funded USDG subsidy, and DOCK rewards. Both incentives can accrue while utilization is zero. Borrowers continue to owe their existing contract rate.

## Pool size and borrowing capacity

Lender deposits increase pool cash. Loans remain constrained by available cash, the engine and pool debt limits, collateral requirements and market admission checks. More deposits do not raise the debt cap.

The latest retained [activation evidence](security/dockyard-stress-production-2026-09-05.md) identifies CASHCAT as active with a 200 USDG principal cap and the other ten markets as commissioning. Recheck these values before setting the campaign manifest and target deposits. Incentivizing thousands of additional USDG against a 200 USDG borrowing cap would mostly subsidize idle capital.

Choose the initial liquidity target from expected borrowing within current caps plus a withdrawal buffer. Any later cap increase needs its own risk and liquidation-capacity review. Campaign size should follow usable borrowing capacity.

## Proposed terms

| Item | Proposal |
| --- | --- |
| Initial duration | 30 days, no automatic renewal |
| Participants | Lenders in verified active Dockyard markets |
| USDG subsidy | A fixed, prefunded daily budget shared by eligible staked lender shares |
| DOCK rewards | A separate fixed, prefunded daily token budget shared by the same eligible stake |
| DOCK reserve | Preserve the purchase target of 3% of initial supply, entirely for lenders |
| Treasury seed shares | Remain unstaked and do not collect either incentive |
| Loan utilization | Not required for launch incentives |
| Lockup | None for staking; pool withdrawal availability still depends on cash and existing checks |
| Renewal | Publish and fund a new round; never extend an unfunded promise |

Distribute each reward by share balance and time staked within its own pool. Allocate budgets between pools first: raw share balances from different pools cannot be added because their share values differ. Do not reward wallet count, transaction count or same-transaction entry and exit. When there are no stakers, advance the accounting clock without allocating that interval's rewards to future entrants.

## Fund a budget, then show its estimated rate

An illustrative planning target is a 5% annualized USDG subsidy for 30 days at the chosen eligible deposit target. This rate has not been selected by the user. Size the reserve with:

```text
USDG subsidy budget = target eligible supplied USDG × target annualized bonus × 30 / 365
```

At a target of 1,000 USDG and a 5% bonus, the 30-day subsidy budget is about 4.11 USDG. This is a scale example, not a proposed deposit target for the current 200 USDG borrowing cap. Distribution and execution costs are additional.

Freeze the actual USDG budget, DOCK budget, emission rates and dates before activation. With a fixed daily USDG budget:

```text
estimated USDG subsidy APR = USDG emitted per day × 365 / eligible staked share value in USDG
```

More eligible stake lowers the estimated rate; less stake raises it. At zero eligible stake, display no estimate and leave emissions unallocated. Do not promise a minimum APR or an unlimited 5% top-up. Pool share value includes the pool's accounting for interest and losses; the estimate is not a guarantee of realizable cash value.

Keep the lender-funded USDG deposit principal separate from the treasury reward reserve. No subsidy may be paid by consuming deposit principal. Claimable rewards remain separately accounted for until actually claimed or explicitly deposited by the lender.

## Release DOCK gradually

The existing [lender rewards design](dockyard-dock-lender-rewards.md) provides the starting point for staking, claims and unstaking. The entire 3% reserve stays dedicated to lenders.

For this small pilot, propose an explicitly specified DOCK tranche below the earlier default of one sixth of the reserve. Do not automatically assign a full monthly tranche to the only active pool. Choose the quantity after verifying purchased inventory, eligible liquidity and expected participation; keep the rest reserved for later lender campaigns. No revised token quantity or schedule has been selected.

Every future eligible market remains in scope through a published allocation before its round starts. Commissioning markets receive no active emissions schedule. Treasury seed shares remain unstaked. Known-wallet exclusions cannot prove that every related account has been identified, and time-weighted rewards do not eliminate incentive farming.

## Contract and interface changes

Extend the proposed per-pool lender rewards design to accept one stake and account for two reward tokens: USDG and DOCK. Each reward needs its own funded inventory, emission rate, accrued obligations and paid totals. Budget checks and recovery of unallocated inventory must never use funds owed under the other reward stream.

Support independent claims for each token, so a DOCK transfer failure cannot block USDG claims. Share unstaking must work without claiming either reward. Verify the deployed token behavior, exact received balances and staking-token identity. The rewards contract must not replace or modify the pool's borrower accounting.

On Earn, show three separate values:

- USDG interest APR generated by borrowers, after the protocol fee.
- Estimated promotional USDG APR, with the daily budget and end date.
- DOCK/day and the lender's estimated allocation, plus claimable DOCK.

A combined USDG APR estimate can sum the first two, with the promotional component explicit. Do not include DOCK in a dollar APR until a suitable price source and meaningful liquidity support that valuation. At zero borrowing, the base interest APR remains zero even while funded incentives accrue.

Show claimable USDG subsidy separately from the lender's pool position, and include staked shares in the portfolio exactly once. Explain that unstaking returns shares; USDG withdrawal remains subject to available pool cash and existing checks. Do not describe unstaking as instant cash withdrawal.

## Implementation and activation

Implementation remains outstanding: extend the lender rewards contract specification and implement dual-token accounting, staking and claim UI, campaign manifests, and settlement reconciliation. Test staggered deposits, partial unstaking, independent claims, no-staker intervals, rounding, campaign boundaries, token failures, reentrancy, funding shortfalls and preservation of accrued claims. Invariants must prove share backing and budget solvency independently for each reward token. Exercise the real pool share implementation through stake, claim, unstake and withdrawal.

Before activation, resolve target eligible deposits, exact USDG and DOCK budgets, funded inventory, campaign dates, verified market manifest, treasury and distribution addresses, and claim terms. These are required to prepare a funded campaign; agreement with the strategy does not specify them.

Measure external deposits, outstanding external borrowing, utilization, paid borrower interest, available withdrawal cash, USDG subsidies paid, DOCK distributed, reward concentration and retention after incentives end. Growing deposits with flat borrowing is a reason to reduce or redirect later incentives, not increase the budget automatically.

External reference: [Morpho's reward campaign documentation](https://docs.morpho.org/developers/rewards/concepts/reward-campaigns/) describes supply incentives with fixed durations and budgets. It supports the general campaign model; it does not establish compatibility with Dockyard's custom pools.
