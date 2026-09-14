// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "../research/DockyardStockCreditEngine.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";

contract DockyardLiquidationMinimumDebtTest is DockyardStockCreditFixture {
    function _fundAndPrice(int256 answer) internal {
        stockFeed.setAnswer(answer);
        gate.submitLiveness(_live());
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), type(uint256).max);
    }

    function testPartialLiquidationKeepsServiceableDebtWithoutExceedingMaximum() public {
        _open();
        _fundAndPrice(21e8);
        (uint256 quote, uint256 collateral) = engine.liquidationQuote(borrower, 20e6 - 1);
        assertEq(quote, 19e6);
        (uint256 paid, uint256 seized) = engine.liquidate(borrower, 20e6 - 1, collateral);
        assertEq(paid, quote);
        assertEq(seized, collateral);
        assertEq(engine.positionDebt(borrower), engine.minimumDebt());
        assertEq(pool.outstandingPrincipal(), engine.minimumDebt());
        assertEq(engine.activeDebtPositions(), 1);
        engine.liquidate(borrower, 1e6, 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.maxWithdraw(lender), 1000e6);
    }

    function testMinimumSizeLoanRequiresFullPaymentUnlessCollateralIsExhausted() public {
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        engine.depositAndBorrowChecked(1e18, 1e6, h, l);
        _fundAndPrice(2e8);
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        engine.liquidationQuote(borrower, 1e6 - 1);
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        engine.liquidate(borrower, 1e6 - 1, 0);
        assertEq(engine.positionDebt(borrower), 1e6);
        engine.liquidate(borrower, 1e6, 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testExhaustedCollateralStillRecognizesLossBelowMinimumDebt() public {
        _open();
        _fundAndPrice(20.5e8);
        (uint256 quote, uint256 collateral) = engine.liquidationQuote(borrower, 20e6);
        assertLt(20e6 - quote, engine.minimumDebt());
        assertEq(collateral, 1e18);
        engine.liquidate(borrower, quote, collateral);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(pool.cumulativeLoss(), 20e6 - quote);
        assertEq(pool.totalAssets(), 1000e6 - pool.cumulativeLoss());
        assertEq(engine.activeDebtPositions(), 0);
    }

    function testAccruedInterestIsIncludedBeforeLimitingThePartialFill() public {
        _open();
        vm.warp(block.timestamp + 1 days);
        usdA.setAnswer(1e8);
        usdB.setAnswer(1e18);
        _fundAndPrice(22e8);
        uint256 debt = engine.positionDebt(borrower);
        assertGt(debt, 20e6);
        uint256 cap = debt - 1;
        (uint256 quote, uint256 collateral) = engine.liquidationQuote(borrower, cap);
        assertEq(quote, debt - engine.minimumDebt());
        engine.liquidate(borrower, cap, collateral);
        assertEq(engine.positionDebt(borrower), engine.minimumDebt());
        assertEq(pool.outstandingPrincipal(), engine.minimumDebt());
        assertEq(pool.interestReceivable(), 0);
    }

    function testInsolventPartialFillAlsoPreservesServiceableCollateralRecovery() public {
        _open();
        _fundAndPrice(10e8);
        (uint256 full,) = engine.liquidationQuote(borrower, type(uint256).max);
        (uint256 paid,) = engine.liquidate(borrower, full - 1, 0);
        assertLt(paid, full - 1);
        (uint256 nextPayment,) = engine.liquidationQuote(borrower, type(uint256).max);
        assertGe(nextPayment, engine.minimumDebt());
        engine.liquidate(borrower, nextPayment, 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.totalAssets(), 1000e6 - pool.cumulativeLoss());
    }

    function testSubMinimumCollateralRecoveryRequiresExhaustionWithinCallerBudget() public {
        _open();
        _fundAndPrice(0.5e8);
        (uint256 full,) = engine.liquidationQuote(borrower, type(uint256).max);
        assertLt(full, engine.minimumDebt());
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        engine.liquidate(borrower, full - 1, 0);
        engine.liquidate(borrower, full, 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testFuzzPartialLiquidationCannotCreateSubMinimumDebt(uint96 maximum, uint32 priceRaw) public {
        _open();
        _fundAndPrice(int256(bound(uint256(priceRaw), 1e8, 49e8)));
        uint256 cap = bound(uint256(maximum), 1, 30e6);
        uint256 before = cash.balanceOf(address(this));
        uint256 quote;
        uint256 collateral;
        try engine.liquidationQuote(borrower, cap) returns (uint256 q, uint256 c) {
            quote = q;
            collateral = c;
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), DockyardIsolatedCreditEngine.InvalidAmount.selector);
            (uint256 full,) = engine.liquidationQuote(borrower, type(uint256).max);
            assertLe(full, engine.minimumDebt());
            assertLt(cap, full);
            assertEq(cash.balanceOf(address(this)), before);
            return;
        }
        (uint256 paid, uint256 seized) = engine.liquidate(borrower, cap, collateral);
        uint256 remaining = engine.positionDebt(borrower);
        assertLe(paid, cap);
        assertEq(before - cash.balanceOf(address(this)), paid);
        assertEq(paid, quote);
        assertEq(seized, collateral);
        assertTrue(remaining == 0 || remaining >= engine.minimumDebt());
        assertEq(pool.outstandingPrincipal(), remaining);
        assertEq(20e6, paid + remaining + pool.cumulativeLoss());
        if (remaining != 0) {
            (uint256 tokens,,,,) = engine.positions(borrower);
            uint256 recovery = (tokens * engine.price() / 1e18) * 10000 / (10000 + engine.bonusBps()) / 1e12;
            assertGe(recovery, engine.minimumDebt());
        }
    }
}
