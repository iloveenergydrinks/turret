// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "../research/DockyardStockCreditEngine.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";

contract DockyardMarketRetirementTest is DockyardStockCreditFixture {
    function testRetirementStopsNewLenderCapitalAndCannotBeReopened() public {
        engine.retireMarket();
        assertTrue(engine.retired());
        assertTrue(pool.retired());
        assertTrue(engine.riskPaused());
        assertEq(pool.maxDeposit(lender), 0);
        assertEq(pool.maxMint(lender), 0);
        cash.mint(lender, 1e6);
        vm.startPrank(lender);
        vm.expectRevert();
        pool.deposit(1e6, lender);
        vm.expectRevert();
        pool.mint(1e12, lender);
        vm.stopPrank();
        vm.expectRevert(DockyardIsolatedCreditEngine.MarketRetired.selector);
        engine.setRiskPaused(false);
        vm.prank(address(engine));
        vm.expectRevert(DockyardIsolatedCapitalPool.MarketRetired.selector);
        pool.draw(borrower, 1e6);
    }

    function testIdleLendersCanFullyExitAfterRetirementWithoutProofs() public {
        engine.retireMarket();
        stockFeed.setShouldRevert(true);
        vm.warp(block.timestamp + 60);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertEq(pool.redeemChecked(shares, lender, lender, 1000e6, block.timestamp + 60, "", ""), 1000e6);
        assertEq(pool.totalSupply(), 0);
        assertEq(pool.availableCash(), 0);
    }

    function testRetirementDoesNotForgiveLoansOrBlockDefensiveActions() public {
        _open();
        engine.retireMarket();
        stockFeed.setShouldRevert(true);
        vm.warp(block.timestamp + 60);
        assertGt(engine.positionDebt(borrower), 20e6);
        vm.startPrank(borrower);
        engine.depositCollateral(borrower, 1e18);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(stock.balanceOf(borrower), 10e18);
        assertGt(pool.maxWithdraw(lender), 999e6);
        assertEq(pool.maxDeposit(lender), 0);
    }

    function testLiquidationStillSettlesAfterRetirement() public {
        _open();
        engine.retireMarket();
        stockFeed.setAnswer(10e8);
        cash.mint(address(this), 20e6);
        cash.approve(address(engine), 20e6);
        engine.liquidate(borrower, 20e6, 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertGt(pool.cumulativeLoss(), 0);
        assertGt(pool.maxWithdraw(lender), 0);
    }

    function testOnlyOwnerCanRetireAndOnlyEngineCanCloseThePool() public {
        vm.prank(lender);
        vm.expectRevert("Ownable: caller is not the owner");
        engine.retireMarket();
        vm.expectRevert(DockyardIsolatedCapitalPool.EngineOnly.selector);
        pool.retire();
        assertFalse(engine.retired());
        assertFalse(pool.retired());
    }

    function testRetiredEngineRejectsNewCollateralButReturnsExistingDebtFreeCollateral() public {
        vm.prank(borrower);
        engine.depositCollateral(borrower, 1e18);
        engine.retireMarket();
        vm.startPrank(borrower);
        vm.expectRevert(DockyardIsolatedCreditEngine.MarketRetired.selector);
        engine.depositCollateral(borrower, 1e18);
        engine.withdrawCollateral(1e18, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
    }
}
