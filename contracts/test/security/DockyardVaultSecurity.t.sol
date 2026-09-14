// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardUSDGCreditVault} from "src/DockyardUSDGCreditVault.sol";
import {DockyardMockERC20, DockyardMockStockToken, DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";

/// @notice Local reproductions of security review findings. Passing means the
/// vulnerable behavior was reproduced, not that the issue is fixed.
contract DockyardVaultSecurityTest is Test {
    DockyardMockERC20 internal usdg;
    DockyardMockStockToken internal stock;
    DockyardMockOracle internal primary;
    DockyardMockOracle internal secondary;
    DockyardUSDGCreditVault internal vault;
    address internal borrower = makeAddr("security-borrower");
    address internal liquidator = makeAddr("security-liquidator");

    function setUp() public {
        vm.warp(10 days);
        usdg = new DockyardMockERC20("USDG", "USDG", 6);
        stock = new DockyardMockStockToken();
        primary = new DockyardMockOracle(8, 100e8);
        secondary = new DockyardMockOracle(8, 100e8);
        vault = new DockyardUSDGCreditVault(address(usdg), address(this), 50, 1 days);
        // Same risk settings as the deployed AAPL market.
        vault.addMarket(address(stock), address(primary), address(secondary), 15_000_000e6, 5214, 5714, 500, 200);
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(10_000e6);
        stock.mint(borrower, 100 ether);
        vm.prank(borrower);
        stock.approve(address(vault), type(uint256).max);
        usdg.mint(liquidator, 10_000e6);
        vm.prank(liquidator);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _open() internal {
        vm.prank(borrower);
        vault.depositAndBorrow(address(stock), 10 ether, 500e6);
    }

    function testFinding_OneDayWithoutUpdatesDisablesLiquidation() public {
        _open();
        primary.setAnswer(70e8);
        secondary.setAnswer(70e8);
        assertGt(vault.positionLtvBps(address(stock), borrower), 5714);
        vm.warp(block.timestamp + 1 days);
        vm.prank(liquidator);
        vm.expectRevert(DockyardUSDGCreditVault.OracleUnavailable.selector);
        vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        (, uint128 debt) = vault.positions(address(stock), borrower);
        assertEq(debt, 502_500_000);
        // Recovery still works once a fresh trusted price arrives.
        primary.setAnswer(70e8);
        vm.prank(liquidator);
        (uint256 repaid,) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 502_500_000);
    }

    function testFinding_AsynchronousFeedMoveBlocksLiquidationUntilConvergence() public {
        _open();
        vm.warp(block.timestamp + 2 hours);
        primary.setAnswer(85e8);
        bytes memory expected = abi.encodeWithSelector(DockyardUSDGCreditVault.OracleMismatch.selector, 85e18, 100e18);
        // At the current $85 price, debt $502.50 exceeds the $485.69 limit.
        assertGt(uint256(502_500_000) * 1e12, uint256(850e18) * 5714 / 10_000);
        vm.prank(liquidator);
        vm.expectRevert(expected);
        vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        secondary.setAnswer(85e8);
        vm.prank(liquidator);
        (uint256 repaid,) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 502_500_000);
    }

    function testFinding_TopUpsBlockedDuringGlobalPause() public {
        _open();
        vault.pause();
        vm.prank(borrower);
        vm.expectRevert("Pausable: paused");
        vault.depositCollateral(address(stock), 10 ether);
        (uint128 collateral,) = vault.positions(address(stock), borrower);
        assertEq(collateral, 10 ether);
    }

    function testFinding_TopUpsBlockedWhenMarketDisabled() public {
        _open();
        vault.setMarketEnabled(address(stock), false);
        vm.prank(borrower);
        vm.expectRevert(DockyardUSDGCreditVault.MarketDisabled.selector);
        vault.depositCollateral(address(stock), 10 ether);
    }

    function testFinding_TopUpsBlockedByOracleMismatchButFullRepaymentStillWorks() public {
        _open();
        primary.setAnswer(85e8);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(DockyardUSDGCreditVault.OracleMismatch.selector, 85e18, 100e18));
        vault.depositCollateral(address(stock), 10 ether);
        assertEq(stock.balanceOf(borrower), 90 ether, "Failed top-up must roll back token transfer");
        usdg.mint(borrower, 2_500_000);
        vm.startPrank(borrower);
        usdg.approve(address(vault), type(uint256).max);
        vault.repayAllAndWithdrawCollateral(address(stock), borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 100 ether);
    }

    function testFinding_23HourOldPriceCanOriginateDebtAboveCurrentCollateralValue() public {
        // Dependency-failure scenario: feeds retain $100 while the real price
        // has dropped to $20. No ability to change a real feed is assumed.
        vm.warp(block.timestamp + 23 hours);
        assertEq(vault.price(address(stock)), 100e18);
        _open();
        assertEq(usdg.balanceOf(borrower), 500e6);
        uint256 currentCollateralValue = 10 * 20e6;
        assertGt(500e6, currentCollateralValue);
        // When feeds catch up, full collateral liquidation cannot repay debt.
        primary.setAnswer(20e8);
        secondary.setAnswer(20e8);
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 190_476_190);
        assertEq(seized, 10 ether);
        (, uint128 debt) = vault.positions(address(stock), borrower);
        assertEq(debt, 312_023_810);
    }

    function testFinding_PositiveDustCollateralPreventsBadDebtWriteOff() public {
        vm.prank(borrower);
        vault.depositAndBorrow(address(stock), 4e10, 1); // Four microdollars of collateral; two debt units including fee.
        primary.setAnswer(1e8);
        secondary.setAnswer(1e8);
        vm.prank(liquidator);
        vm.expectRevert(DockyardUSDGCreditVault.ZeroAmount.selector);
        vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        vm.expectRevert(DockyardUSDGCreditVault.NoBadDebt.selector);
        vault.writeOffBadDebt(address(stock), borrower);
        (uint128 collateral, uint128 debt) = vault.positions(address(stock), borrower);
        assertEq(collateral, 4e10);
        assertEq(debt, 2);
        assertEq(vault.totalDebt(), 2);
    }

    function testFuzz_LiquidationPreservesAccounting(uint128 seedCollateral, uint128 seedBorrow, uint64 seedPrice)
        public
    {
        uint256 deposited = bound(uint256(seedCollateral), 1e14, 100 ether);
        uint256 maximumPrincipal = deposited * 100 * 5214 / 10_000 / 1e12 * 10_000 / 10_050;
        uint256 principal = bound(uint256(seedBorrow), 1, maximumPrincipal - 1);
        vm.prank(borrower);
        vault.depositAndBorrow(address(stock), deposited, principal);
        uint256 newPrice = bound(uint256(seedPrice), 1e8, 100e8);
        primary.setAnswer(int256(newPrice));
        secondary.setAnswer(int256(newPrice));
        (uint128 collateral, uint128 debt) = vault.positions(address(stock), borrower);
        uint256 value = uint256(collateral) * newPrice * 1e10 / 1e18;
        if (uint256(debt) * 1e12 <= value * 5714 / 10_000 || value * 10_000 / 10_500 / 1e12 == 0) return;
        uint256 beforeLiquidity = vault.availableLiquidity();
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        (uint128 remainingCollateral, uint128 remainingDebt) = vault.positions(address(stock), borrower);
        assertEq(uint256(remainingCollateral) + seized, collateral);
        assertEq(uint256(remainingDebt) + repaid, debt);
        assertEq(vault.marketDebt(address(stock)), remainingDebt);
        assertEq(vault.totalDebt(), remainingDebt);
        assertEq(stock.balanceOf(address(vault)), remainingCollateral);
        assertEq(vault.availableLiquidity(), beforeLiquidity + repaid);
    }
}
