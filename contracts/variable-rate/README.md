# Variable borrowing rates

Implementation candidate, not deployed. This is a new pool/engine generation for PONS. Existing fixed-rate contracts and their positions remain unchanged. The deployed fixed APR cannot be changed in place.

The initial immutable curve is 10% APR at zero utilization, 20% at 80%, 60% at 90%, and 100% at 100%. Between these points rates interpolate linearly, rounded down to whole basis points. These are proposed launch parameters, not an assertion that this curve guarantees liquidity or has been economically calibrated at scale.

Utilization is outstanding principal divided by outstanding principal plus available USDG. Available cash excludes collected protocol fees. Unpaid interest is a receivable, not spendable cash, and is excluded from this utilization denominator. Lender return estimates still use net total assets as their denominator.

Every draw, repayment, loss, deposit, mint, withdrawal and redemption checkpoints interest before changing balances, then updates the APR for future time. The pool integrates basis points multiplied by seconds; individual loans use the same integral. Interest remains simple interest on principal, preserving the existing accounting model. No historical debt is repriced when the rate changes, and no borrower iteration is required. Already-open loans in this new generation follow future rate changes.

Direct USDG donations affect the curve only at the next checkpoint. They cannot retrospectively lower interest. ERC-4626 rounding may leave one micro-USDG and move a boundary quote by one basis point. Pool/loan fractional-interest differences are cleared when the final loan closes, as in the existing engine. Accounting version 2 denotes the existing available-cash withdrawal and paginated borrower APIs; rateModelVersion 1 separately identifies the new rate curve.

The existing collateral checks, 20% starting LTV, 35% liquidation threshold, 50 USDG minimum loan, 1,000 USDG principal cap, 5% liquidation bonus, and 10% protocol share of received interest are preserved in the PONS deployment proposal. Rate parameters have no administrator setter. Withdrawal restrictions and lender loss exposure remain. A rate increase encourages repayment but does not force it or guarantee an exit date.

Sources were adapted from the frozen PONS release and its reviewed pool ledger, identified in baseline.json. The liquidation executor reuses the existing route implementation. This work is tested locally; it is not an independent security audit or a completed production rollout.

Run deterministic accounting and fuzz tests from the repository root:

```sh
forge test --root contracts/variable-rate --match-contract VariableRatesTest -vv
```

Run the selected real-token/DEX fork regressions using the recorded LP fixture at block 61160361:

```sh
PONS_FORK_RPC=<read-only-rpc-url> PONS_FORK_BLOCK=61160361 forge test --root contracts/variable-rate --match-contract PonsVariableForkTest --match-test 'testPilot1000|testPilotMinimumLoan|testBorrowRepayDuringSignerOutage|testStaleLiquidationPriceRollsBack|testEightBorrowersShareExit|testVariableLoanInterestWithRealTokens' -vv
```

The fork tests create contracts and impersonate accounts only inside Foundry. Do not use the synthetic test signer on a live chain. The LP removal fixture is specific to its recorded block; testing it at a newer block requires rediscovering positions instead of relaxing its threshold.

Runtime integration and release status: ../../output/variable-rate-20260912/REPORT.md.
