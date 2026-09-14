// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {Api3ServerBoundary} from "./DockyardApi3UsdgFeed.t.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardApi3UsdgFeed} from "src/research/DockyardApi3UsdgFeed.sol";

/// @notice Real stock-engine/pool/adapter code with external feeds and tokens
/// mocked. Native API3 signature validation is covered by the separate fork.
contract DockyardStockApi3IntegrationTest is DockyardStockCreditFixture {
    Api3ServerBoundary api3;
    DockyardApi3UsdgFeed api3Feed;

    function setUp() public override {
        vm.chainId(4663);
        api3 = new Api3ServerBoundary();
        api3Feed = new DockyardApi3UsdgFeed(address(api3), address(api3).codehash);
        super.setUp();
    }

    function _beforeActivate() internal override {
        _refresh();
    }

    function _usdgConfig() internal view override returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return DockyardStockCreditEngine.UsdgPricing(address(usdA), address(api3Feed), 300, 300, 200, 60);
    }

    function _refresh() private {
        for (uint256 i; i < 5; ++i) {
            api3.set(api3Feed.beaconId(i), 1e18, uint32(block.timestamp));
        }
        usdA.setAnswer(1e8);
    }

    function testLendBorrowRepayAndRedeemWithApi3Adapter() public {
        _open();
        assertEq(engine.positionDebt(borrower), 20e6);
        assertEq(engine.price(), 100e18);
        cash.mint(lender, 100e6);
        vm.prank(lender);
        pool.deposit(100e6, lender);
        vm.warp(block.timestamp + 3600);
        _refresh();
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        assertGt(engine.positionDebt(borrower), 20e6);
        vm.startPrank(borrower);
        engine.repay(borrower, 5e6);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
        assertEq(engine.positionDebt(borrower), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertGt(pool.redeem(shares, lender, lender), 1100e6);
        assertEq(pool.balanceOf(lender), 0);
    }

    function testApi3OutageStopsNewRiskButAllowsCollateralAndCashRecovery() public {
        _open();
        vm.warp(block.timestamp + 60);
        gate.submitLiveness(_live());
        usdA.setAnswer(1e8);
        bytes memory health = _health(block.timestamp + 3600);
        bytes memory live = _live();
        vm.prank(borrower);
        vm.expectRevert();
        engine.borrowChecked(1e6, health, live);
        assertEq(pool.maxDeposit(lender), 0);
        assertEq(pool.maxWithdraw(lender), 0);
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
        assertEq(pool.balanceOf(lender), 0);
    }
}
