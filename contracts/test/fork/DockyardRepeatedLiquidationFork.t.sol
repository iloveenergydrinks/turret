// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardLiquidationSizingFixture} from "./DockyardLiquidationSizingFork.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";

/// @notice Real-pool repeated exits with synthetic funding and mock spot feeds.
/// No independent oracle, live keeper, MEV or native fee coverage is claimed.
contract DockyardRepeatedLiquidationForkTest is DockyardLiquidationSizingFixture {
    struct Totals {
        uint256 paid;
        uint256 profit;
        uint256 cycles;
        bool blocked;
        bool healthy;
    }

    function testCashcatResponsiveHalfPriceSettlement() public {
        _settle(CASHCAT, CASHCAT_POOL, 5500, true);
    }

    function testPonsResponsiveHalfPriceSettlement() public {
        _settle(PONS, PONS_POOL, 5500, true);
    }

    function testCashcatResponsiveQuarterPriceSettlement() public {
        _settle(CASHCAT, CASHCAT_POOL, 2500, true);
    }

    function testPonsResponsiveQuarterPriceSettlement() public {
        _settle(PONS, PONS_POOL, 2500, true);
    }

    function testCashcatFrozenPostShockReference() public {
        _settle(CASHCAT, CASHCAT_POOL, 2500, false);
    }

    function testPonsFrozenPostShockReference() public {
        _settle(PONS, PONS_POOL, 2500, false);
    }

    function _settle(address token, address venue, uint256 shockBps, bool refresh) internal {
        _fund();
        (, uint256 loan, uint256 initial) = _openSized(token, venue, 250 ether, 100 ether);
        uint256 lenderAssets = capital.totalAssets();
        _shock(token, venue, initial * shockBps / 10000);
        Totals memory totals;
        for (; totals.cycles < 32 && engine.positionDebt(borrower) != 0; ++totals.cycles) {
            if (refresh) _refreshReference(token, venue);
            uint256 cap = loan;
            Attempt memory result;
            for (uint256 step; step < 4; ++step) {
                uint256 quoted;
                try engine.liquidationQuote(borrower, cap) returns (uint256 paid, uint256) {
                    quoted = paid;
                } catch (bytes memory reason) {
                    assertEq(bytes4(reason), DockyardIsolatedCreditEngine.HealthyPosition.selector);
                    totals.healthy = true;
                    break;
                }
                uint256 beforeDebt = engine.positionDebt(borrower);
                result = _attemptWithFloor(token, venue, cap, 1e6);
                if (result.executable) {
                    assertLt(engine.positionDebt(borrower), beforeDebt);
                    totals.paid += result.paid;
                    totals.profit += result.out - result.paid;
                    break;
                }
                cap = (cap < quoted ? cap : quoted) / 2;
                if (cap == 0) break;
            }
            if (totals.healthy) break;
            if (!result.executable) {
                totals.blocked = true;
                break;
            }
        }
        uint256 remaining = engine.positionDebt(borrower);
        uint256 loss = capital.cumulativeLoss();
        assertEq(totals.paid + loss + remaining, loan, "Principal must reconcile after every partial exit");
        assertEq(capital.outstandingPrincipal(), remaining);
        assertGt(totals.paid, 0, "No liquidation progress");
        emit log_named_address("Repeated exit token", token);
        emit log_named_uint("Refresh reference between exits", refresh ? 1 : 0);
        emit log_named_uint("Completed liquidation cycles", totals.cycles);
        emit log_named_uint("Blocked by return floor", totals.blocked ? 1 : 0);
        emit log_named_uint("Healthy remaining position", totals.healthy ? 1 : 0);
        emit log_named_uint("Initial principal USDG (6 decimals)", loan);
        emit log_named_uint("Liquidator paid USDG (6 decimals)", totals.paid);
        emit log_named_uint("Gross profit before gas USDG (6 decimals)", totals.profit);
        emit log_named_uint("Recognized loss USDG (6 decimals)", loss);
        emit log_named_uint("Remaining debt USDG (6 decimals)", remaining);
        if (refresh) {
            assertFalse(totals.blocked, "Responsive reference still leaves an unexecutable loan");
            assertTrue(remaining == 0 || totals.healthy, "Cycle limit reached with unhealthy debt");
            if (shockBps == 2500) {
                assertEq(remaining, 0, "Severely insolvent fixture must fully settle");
                assertGt(loss, 0, "Shortfall must reduce lender assets");
            } else {
                assertTrue(totals.healthy);
                assertGt(remaining, 0, "Healthy remaining debt must not be liquidated");
                assertEq(loss, 0);
            }
        } else {
            assertTrue(totals.blocked, "Frozen reference fixture should expose blocked exits");
            assertGt(remaining, 0);
            assertFalse(capital.capitalOperationsAllowed(), "Lenders cannot exit at overstated book value");
        }
        // Recovery is separate from liquidation: the borrower retained the loan
        // in this fixture and voluntarily repays any remainder. Never count this
        // transfer as a successful keeper liquidation or lender loss recovery.
        primary.setShouldRevert(true);
        secondary.setShouldRevert(true);
        engine.setRiskPaused(true);
        if (remaining != 0) {
            assertEq(capital.maxWithdraw(address(this)), 0);
            vm.startPrank(borrower);
            IERC20(USDG).approve(address(engine), remaining);
            engine.close(remaining, borrower);
            vm.stopPrank();
        } else {
            (uint256 held,,,,) = engine.positions(borrower);
            if (held != 0) {
                vm.prank(borrower);
                engine.withdrawCollateral(held, borrower);
            }
        }
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(capital.outstandingPrincipal(), 0);
        assertEq(capital.interestReceivable(), 0);
        assertEq(IERC20(token).balanceOf(address(engine)), 0);
        uint256 recovered = capital.redeem(capital.balanceOf(address(this)), address(this), address(this));
        assertApproxEqAbs(recovered + loss, lenderAssets, 1, "Lender realizes the recorded loss");
        emit log_named_uint("Voluntary borrower repayment USDG (6 decimals)", remaining);
        emit log_named_uint("Lender withdrawal USDG (6 decimals)", recovered);
    }
}
