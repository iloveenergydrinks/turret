// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {ManagedApi3Boundary} from "./DockyardApi3ManagedUsdgFeed.t.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";

contract DockyardStockHeartbeatPolicyTest is DockyardStockCreditFixture {
    ManagedApi3Boundary api3;
    DockyardApi3ManagedUsdgFeed api3Feed;

    function setUp() public override {
        vm.chainId(4663);
        api3 = new ManagedApi3Boundary();
        api3.mapName(0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7);
        api3Feed = new DockyardApi3ManagedUsdgFeed(address(api3), address(api3).codehash, 25 hours);
        super.setUp();
    }

    function _beforeActivate() internal override {
        _api3(1e18, block.timestamp);
    }

    function _api3(int224 value, uint256 timestamp) private {
        api3.set(api3Feed.DATA_FEED_ID(), value, uint32(timestamp));
    }

    function _usdgConfig() internal view override returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return
            DockyardStockCreditEngine.UsdgPricing(address(usdA), address(api3Feed), 25 hours, 25 hours, 200, 25 hours);
    }

    function testAsynchronousHeartbeatsPermitBorrowAndHealthyLiquidation() public {
        usdA.setUpdatedAt(block.timestamp - 24 hours - 30 minutes);
        _open();
        assertEq(engine.positionDebt(borrower), 20e6);
        stockFeed.setAnswer(40e8);
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        (uint256 paid, uint256 seized) = engine.liquidateChecked(borrower, 100e6, 1, _live());
        assertEq(paid, 20e6);
        assertGt(seized, 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testEachFeedExpiresAtExactBoundaryWithoutTimestampRewriting() public {
        usdA.setUpdatedAt(block.timestamp - 25 hours + 1);
        _api3(1e18, block.timestamp - 25 hours + 1);
        assertEq(engine.price(), 100e18);
        usdA.setUpdatedAt(block.timestamp - 25 hours);
        vm.expectRevert();
        engine.price();
        usdA.setUpdatedAt(block.timestamp);
        _api3(1e18, block.timestamp - 25 hours);
        vm.expectRevert();
        engine.price();
    }

    function testIndependentAgeBudgetsCannotBorrowEachOthersGrace() public {
        DockyardStockCreditEngine.UsdgPricing memory u = _usdgConfig();
        u.primaryMaxAge = 3600;
        DockyardStockCreditEngine e = new DockyardStockCreditEngine(_config(), address(gate), u);
        _api3(1e18, block.timestamp - 80000);
        usdA.setUpdatedAt(block.timestamp - 3599);
        assertEq(e.price(), 100e18);
        usdA.setUpdatedAt(block.timestamp - 3600);
        vm.expectRevert();
        e.price();
        u.primaryMaxAge = 90000;
        u.secondaryMaxAge = 3600;
        e = new DockyardStockCreditEngine(_config(), address(gate), u);
        usdA.setUpdatedAt(block.timestamp - 80000);
        _api3(1e18, block.timestamp - 3599);
        assertEq(e.price(), 100e18);
        _api3(1e18, block.timestamp - 3600);
        vm.expectRevert();
        e.price();
    }

    function testOracleOutageBlocksRiskAndLiquidationButNotRecovery() public {
        _open();
        usdA.setUpdatedAt(block.timestamp - 25 hours);
        stockFeed.setAnswer(40e8);
        bytes memory health = _health(block.timestamp + 3600);
        bytes memory live = _live();
        vm.prank(borrower);
        vm.expectRevert();
        engine.borrowChecked(1e6, health, live);
        assertEq(pool.maxDeposit(lender), 0);
        assertEq(pool.maxWithdraw(lender), 0);
        vm.expectRevert();
        engine.liquidationQuote(borrower, 100e6);
        vm.startPrank(borrower);
        engine.depositCollateral(borrower, 1e18);
        engine.repay(borrower, 5e6);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertEq(pool.redeem(shares, lender, lender), 1000e6);
    }

    function testDepegDisagreementFailsClosedThenMatchingDepegUsesRealPrice() public {
        _open();
        _api3(0.8e18, block.timestamp);
        vm.expectRevert();
        engine.price();
        vm.expectRevert();
        engine.liquidationQuote(borrower, 100e6);
        assertEq(pool.maxDeposit(lender), 0);
        usdA.setAnswer(0.8e8);
        assertEq(engine.price(), 125e18, "not a hardcoded dollar peg");
        usdA.setAnswer(1.2e8);
        _api3(1.2e18, block.timestamp);
        assertEq(engine.price(), uint256(100e18) * 1e18 / 1.2e18);
    }

    function testMalformedAndUnboundedPoliciesRejected() public {
        DockyardStockCreditEngine.UsdgPricing memory u = _usdgConfig();
        u.primaryMaxAge = 90001;
        vm.expectRevert();
        new DockyardStockCreditEngine(_config(), address(gate), u);
        u.primaryMaxAge = 90000;
        u.secondaryMaxAge = 0;
        vm.expectRevert();
        new DockyardStockCreditEngine(_config(), address(gate), u);
        vm.expectRevert();
        new DockyardApi3ManagedUsdgFeed(address(api3), address(api3).codehash, 90001);
        vm.expectRevert();
        new DockyardApi3ManagedUsdgFeed(address(api3), address(api3).codehash, 0);
    }

    function testHeartbeatPolicyDoesNotExtendStockHealthOrLiveness() public {
        _open();
        vm.warp(block.timestamp + 46);
        vm.expectRevert();
        engine.price();
        gate.submitLiveness(_live());
        assertEq(engine.price(), 100e18);
        vm.expectRevert();
        engine.borrowingPrice();
    }

    function testFuzzBothSourcesNeedTheirOwnFreshTimestamp(uint32 ageA, uint32 ageB) public {
        ageA = uint32(bound(ageA, 0, 100000));
        ageB = uint32(bound(ageB, 0, 100000));
        usdA.setUpdatedAt(block.timestamp - ageA);
        _api3(1e18, block.timestamp - ageB);
        if (ageA >= 90000 || ageB >= 90000) vm.expectRevert();
        engine.price();
    }
}
