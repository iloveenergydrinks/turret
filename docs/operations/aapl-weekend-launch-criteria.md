# Proposed small AAPL weekend launch

Status: proposed launch criteria, not an admission approval or deployment configuration. Prepared September 5, 2026, after authorization to pursue a small capped launch. Weekend borrowing remains closed.

## Initial scope and capital

Start with one 10 USDG loan using operator/protocol capital. The proposed aggregate outstanding principal ceiling for this separate AAPL market is 50 USDG, enforced onchain across all wallets. Accrued interest, execution costs and liquidation incentives must be included separately when proving keeper coverage; a 50 USDG principal ceiling is not a 50 USDG ceiling on all losses or operating costs. Do not use a per-wallet cap as the aggregate exposure control.

This is a provisional operational limit, not a limit statistically established by the current observations. Increase it only after full-exposure liquidation testing and observed operation through weekend/reopening cycles. Existing lenders and positions must not be silently moved into a market with different oracle behavior.

## History gate

For this tightly capped experiment, the proposed first review is after continuously observing the remaining September 5–7 closure and the September 8 reopening, including the regular US session opening. This is roughly three days from pilot startup. It gives event coverage; it does not demonstrate safety under rare jumps or manipulation.

The observer started on Saturday. This review therefore does not cover Friday's transition into closure, and must not be represented as a complete Friday-to-reopening history. Before increasing the initial cap or broadening the launch, observe at least two complete closure/reopening cycles, including that transition. The observation duration is engineering judgment, not a Uniswap/Kraken requirement or proof of safety.

Review timestamped source availability, gaps, disagreements, pool activity and simulated full-input sale proceeds throughout those periods. Count unavailable intervals and stale observations. A recent HTTP response or a calculable TWAP must not count as fresh price discovery. Uniswap v3 `observe` can construct counterfactual observations between recorded observations: https://developers.uniswap.org/docs/protocols/v3/concepts/price-oracles

September 8 is a go/no-go review, not a promised launch date. The September 12–13 weekend is the proposed earliest operational target for a capped weekend trial, conditional on completion of the technical gates. No automatic activation is scheduled.

## Technical gates independent of elapsed time

1. Implement and review a separate oracle-capable AAPL market. Existing immutable stock-engine oracle bindings cannot be replaced by the observer. Borrowing and liquidation must use a consistent, explicitly defined weekend valuation policy, with defined closure/reopening transitions.
2. Verify the Kraken displayed-token/share unit and normalize corporate actions correctly. Resolve the current last-trade freshness failures with independently validated price observations; do not merely extend the stale limit. A valid, active book feed may have different freshness semantics than a last-trade feed, but those semantics need verification before admission use.
3. Add a second RPC provider and test disagreement/outage handling. Never infer independence from two URLs served by the same upstream.
4. Exercise the actual new contracts, approval producer, borrower flow and funded keeper through borrow, repay and liquidation on a production-state fork. Preserve real pool behavior for normal execution tests; label any deliberately stressed states separately.
5. Test price gaps, thin/withdrawn liquidity, stale or unavailable sources, proxy/corporate-action changes, chain interruption and reopening jumps. A paused borrowing path must not be mistaken for a functioning liquidation path.
6. Demonstrate liquidation of the entire proposed principal cap plus accrued interest, incentives, slippage and gas using the real configured route. Existing observer simulations at 10/50/100/1000 USDG collateral notional alone are not this proof.
7. Verify the onchain aggregate cap, keeper reserve, monitored failure responses and a concrete route for repayment/exit before any funded production canary. Complete an independent implementation review before exposing lender funds.

## Evidence at the latest check

At September 5, 2026 16:16 UTC, the pilot retained five complete collection samples over approximately four minutes. All four onchain sale sizes simulated successfully. Kraken's last trade was about 20 minutes old, and only one RPC provider was configured. The observation pipeline passed 115 regression tests plus Node 24 live-data, HTTP, persistence and restart E2E checks. These are observation-pipeline tests, not successful weekend-loan lifecycle tests.

Production evidence: `output/weekend-pilot/production-verification.json` and `output/weekend-pilot/production-observations.json`.
