// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {ManagedApi3Boundary} from "./DockyardApi3ManagedUsdgFeed.t.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";

contract DockyardStockManagedApi3IntegrationTest is DockyardStockCreditFixture {
    ManagedApi3Boundary api3;
    DockyardApi3ManagedUsdgFeed api3Feed;

    function setUp() public override {
        vm.chainId(4663);
        api3 = new ManagedApi3Boundary();
        api3.mapName(0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7);
        api3Feed = new DockyardApi3ManagedUsdgFeed(address(api3), address(api3).codehash, 3600);
        super.setUp();
    }

    function _beforeActivate() internal override {
        _refresh();
    }

    function _usdgConfig() internal view override returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return DockyardStockCreditEngine.UsdgPricing(address(usdA), address(api3Feed), 3600, 3600, 200, 60);
    }

    function _refresh() private {
        api3.set(api3Feed.DATA_FEED_ID(), 1e18, uint32(block.timestamp));
        usdA.setAnswer(1e8);
    }

    function testManagedFeedLendBorrowRepayCloseRedeem() public {
        _open();
        assertEq(engine.positionDebt(borrower), 20e6);
        cash.mint(lender, 100e6);
        vm.prank(lender);
        pool.deposit(100e6, lender);
        vm.warp(block.timestamp + 100);
        _refresh();
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        vm.startPrank(borrower);
        engine.repay(borrower, 5e6);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
        assertEq(engine.positionDebt(borrower), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertGe(pool.redeem(shares, lender, lender), 1100e6);
    }

    function testSubscribedButStaleFeedStopsRiskAndPreservesRepayment() public {
        _open();
        vm.warp(block.timestamp + 3600);
        usdA.setAnswer(1e8);
        gate.submitLiveness(_live());
        bytes memory health = _health(block.timestamp + 3600);
        bytes memory live = _live();
        vm.prank(borrower);
        vm.expectRevert();
        engine.borrowChecked(1e6, health, live);
        assertEq(pool.maxDeposit(lender), 0);
        vm.startPrank(borrower);
        engine.depositCollateral(borrower, 1e18);
        engine.repay(borrower, 5e6);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
        assertEq(engine.positionDebt(borrower), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertGe(pool.redeem(shares, lender, lender), 1000e6);
    }

    function testManagedFeedSupportsLiquidationWithFreshPrices() public {
        _open();
        vm.warp(block.timestamp + 45);
        _refresh();
        stockFeed.setAnswer(40e8);
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        (uint256 paid, uint256 seized) = engine.liquidateChecked(borrower, 100e6, 1, _live());
        assertGt(paid, 20e6);
        assertGt(seized, 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testDisagreementOrRemappingCannotEnableNewBorrowing() public {
        _open();
        api3.set(api3Feed.DATA_FEED_ID(), 0.8e18, uint32(block.timestamp));
        vm.expectRevert();
        engine.price();
        assertEq(pool.maxDeposit(lender), 0);
        api3.mapName(bytes32(uint256(456)));
        vm.expectRevert();
        engine.price();
        vm.startPrank(borrower);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(stock.balanceOf(borrower), 10e18);
    }
}
