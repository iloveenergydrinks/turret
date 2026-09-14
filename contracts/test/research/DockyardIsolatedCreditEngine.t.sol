// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardMockERC20, DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";

abstract contract DockyardIsolatedCreditEngineFixture is Test {
    DockyardMockERC20 cash;
    DockyardMockERC20 token;
    DockyardMockOracle primary;
    DockyardMockOracle secondary;
    DockyardIsolatedCreditEngine engine;
    DockyardIsolatedCapitalPool pool;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(1000000);
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        token = new DockyardMockERC20("Candidate", "CAND", 18);
        primary = new DockyardMockOracle(8, 100e8);
        secondary = new DockyardMockOracle(8, 100e8);
        engine = new DockyardIsolatedCreditEngine(
            DockyardIsolatedCreditEngine.Config({
                usdg: address(cash),
                collateral: address(token),
                primary: address(primary),
                secondary: address(secondary),
                guardian: address(this),
                staleness: 1 days,
                maxLtvBps: 5000,
                liquidationLtvBps: 6500,
                bonusBps: 500,
                deviationBps: 500,
                minimumDebt: 1
            })
        );
        pool = new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(token), address(engine), makeAddr("treasury"), 100000e6, 1000, 1000
        );
        engine.bindPool(pool);
        engine.setRiskPaused(false);
        cash.mint(address(this), 100000e6);
        cash.approve(address(pool), type(uint256).max);
        pool.deposit(100000e6, address(this));
        for (uint256 i; i < 3; i++) {
            address who = i == 0 ? alice : i == 1 ? bob : keeper;
            token.mint(who, 1000e18);
            cash.mint(who, 100000e6);
            vm.startPrank(who);
            token.approve(address(engine), type(uint256).max);
            cash.approve(address(engine), type(uint256).max);
            vm.stopPrank();
        }
    }

    function open(address who, uint256 collateral, uint256 debt) internal {
        vm.startPrank(who);
        engine.depositCollateral(who, collateral);
        engine.borrow(debt);
        vm.stopPrank();
    }

    function updatePrice(int256 price_) internal {
        primary.setAnswer(price_);
        secondary.setAnswer(price_);
    }
}

contract DockyardIsolatedCreditEngineTest is DockyardIsolatedCreditEngineFixture {
    function testBorrowRepayAndRecoverCollateral() public {
        open(alice, 10e18, 400e6);
        vm.warp(block.timestamp + 365 days);
        assertEq(engine.positionDebt(alice), 440e6);
        vm.startPrank(alice);
        assertEq(engine.repay(alice, type(uint256).max), 440e6);
        engine.withdrawCollateral(10e18, alice);
        vm.stopPrank();
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.interestReceivable(), 0);
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(token.balanceOf(alice), 1000e18);
        assertEq(pool.totalAssets(), 100036e6);
    }

    function testRepaymentAndDebtFreeWithdrawalWorkWithPausedBrokenOracles() public {
        open(alice, 10e18, 400e6);
        engine.setRiskPaused(true);
        primary.setShouldRevert(true);
        secondary.setShouldRevert(true);
        vm.startPrank(alice);
        engine.repay(alice, type(uint256).max);
        engine.withdrawCollateral(10e18, alice);
        vm.stopPrank();
        assertEq(engine.positionDebt(alice), 0);
    }

    function testPausedTopUpIsAvailableButBorrowingIsNot() public {
        open(alice, 10e18, 400e6);
        engine.setRiskPaused(true);
        vm.startPrank(bob);
        engine.depositCollateral(alice, 1e18);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCreditEngine.NotReady.selector);
        engine.borrow(1);
        (uint256 c,,,,) = engine.positions(alice);
        assertEq(c, 11e18);
    }

    function testUnsafeBorrowAndWithdrawalFailWithoutChangingDebt() public {
        open(alice, 10e18, 400e6);
        vm.startPrank(alice);
        vm.expectRevert(DockyardIsolatedCreditEngine.UnsafePosition.selector);
        engine.borrow(101e6);
        vm.expectRevert(DockyardIsolatedCreditEngine.UnsafePosition.selector);
        engine.withdrawCollateral(3e18, alice);
        vm.stopPrank();
        assertEq(pool.outstandingPrincipal(), 400e6);
    }

    function testBothOraclesRequiredAndDeviationFailsClosed() public {
        open(alice, 10e18, 400e6);
        secondary.setShouldRevert(true);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.borrow(1);
        secondary.setShouldRevert(false);
        secondary.setAnswer(80e8);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleMismatch.selector);
        engine.price();
        updatePrice(100e8);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.price();
    }

    function testHealthyLoanCannotBeLiquidated() public {
        open(alice, 10e18, 400e6);
        vm.prank(keeper);
        vm.expectRevert(DockyardIsolatedCreditEngine.HealthyPosition.selector);
        engine.liquidate(alice, 400e6, 0);
    }

    function testLiquidationWorksWhileNewRiskPaused() public {
        open(alice, 10e18, 400e6);
        updatePrice(50e8);
        engine.setRiskPaused(true);
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(alice, 100e6, 2e18);
        assertEq(paid, 100e6);
        assertEq(seized, 2.1e18);
        assertEq(engine.positionDebt(alice), 300e6);
        assertEq(pool.outstandingPrincipal(), 300e6);
    }

    function testLiquidationSlippageRevertsPaymentAndState() public {
        open(alice, 10e18, 400e6);
        updatePrice(50e8);
        uint256 beforeBalance = cash.balanceOf(keeper);
        vm.prank(keeper);
        vm.expectRevert(DockyardIsolatedCreditEngine.Slippage.selector);
        engine.liquidate(alice, 100e6, 3e18);
        assertEq(cash.balanceOf(keeper), beforeBalance);
        assertEq(engine.positionDebt(alice), 400e6);
    }

    function testInsolvencySeizesCollateralAndRecognizesLossInSameTransaction() public {
        open(alice, 10e18, 400e6);
        vm.warp(block.timestamp + 365 days);
        updatePrice(20e8);
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(alice, type(uint256).max, 10e18);
        assertEq(paid, 190476190);
        assertEq(seized, 10e18);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.interestReceivable(), 0);
        assertEq(engine.positionDebt(alice), 0);
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(pool.cumulativeLoss(), 440e6 - paid);
        assertEq(pool.totalAssets(), 100000e6 - 400e6 + paid - 4e6);
    }

    function testPartialRepaymentPaysInterestFirst() public {
        open(alice, 10e18, 400e6);
        vm.warp(block.timestamp + 365 days);
        vm.prank(bob);
        engine.repay(alice, 20e6);
        (, uint256 principal, uint256 interest,,) = engine.positions(alice);
        assertEq(principal, 400e6);
        assertEq(interest, 20e6);
        assertEq(pool.outstandingPrincipal(), 400e6);
        assertEq(pool.interestReceivable(), 20e6);
    }

    function testPoolCannotBeRebound() public {
        vm.expectRevert(DockyardIsolatedCreditEngine.PoolAlreadyBound.selector);
        engine.bindPool(pool);
    }

    function testPendingLiquidationStopsLenderEntryAndExit() public {
        open(alice, 10e18, 400e6);
        updatePrice(20e8);
        assertFalse(engine.capitalOperationsAllowed());
        assertFalse(pool.capitalOperationsAllowed());
        assertEq(pool.maxDeposit(bob), 0);
        assertEq(pool.maxMint(bob), 0);
        assertEq(pool.maxWithdraw(address(this)), 0);
        assertEq(pool.maxRedeem(address(this)), 0);
        vm.expectRevert("ERC4626: withdraw more than max");
        pool.withdraw(1e6, address(this), address(this));
        vm.expectRevert("ERC4626: redeem more than max");
        pool.redeem(1e6, address(this), address(this));
        vm.prank(bob);
        vm.expectRevert("ERC4626: deposit more than max");
        pool.deposit(1e6, bob);
        vm.prank(bob);
        vm.expectRevert("ERC4626: mint more than max");
        pool.mint(1e6, bob);
    }

    function testLiquidationRestoresWithdrawalsAtLossAdjustedValue() public {
        open(alice, 10e18, 400e6);
        updatePrice(20e8);
        vm.prank(keeper);
        engine.liquidate(alice, type(uint256).max, 0);
        assertTrue(pool.capitalOperationsAllowed());
        uint256 claim = pool.maxWithdraw(address(this));
        assertLt(claim, 100000e6);
        pool.withdraw(claim, address(this), address(this));
        assertEq(cash.balanceOf(address(this)), claim);
    }

    function testRepaymentRestoresSafetyWithoutKeeper() public {
        open(alice, 10e18, 400e6);
        updatePrice(50e8);
        assertFalse(pool.capitalOperationsAllowed());
        vm.prank(alice);
        engine.repay(alice, 100e6);
        assertTrue(pool.capitalOperationsAllowed());
        assertGt(pool.maxWithdraw(address(this)), 0);
    }

    function testCollateralTopUpRestoresSafetyWithoutKeeper() public {
        open(alice, 10e18, 400e6);
        updatePrice(50e8);
        vm.prank(bob);
        engine.depositCollateral(alice, 10e18);
        assertTrue(pool.capitalOperationsAllowed());
    }

    function testStaleOrPausedPricingBlocksCapitalButNotDebtFreeRecovery() public {
        open(alice, 10e18, 400e6);
        engine.setRiskPaused(true);
        assertFalse(pool.capitalOperationsAllowed());
        engine.setRiskPaused(false);
        secondary.setShouldRevert(true);
        assertEq(pool.maxWithdraw(address(this)), 0);
        assertEq(pool.maxDeposit(bob), 0);
        vm.prank(alice);
        engine.close(400e6, alice);
        assertTrue(pool.capitalOperationsAllowed());
        pool.withdraw(100000e6, address(this), address(this));
        assertEq(cash.balanceOf(address(this)), 100000e6);
    }

    function testPendingLiquidationBlocksDrawingFreshCapital() public {
        open(alice, 10e18, 400e6);
        updatePrice(20e8);
        vm.prank(bob);
        vm.expectRevert(DockyardIsolatedCapitalPool.CapitalOperationsSuspended.selector);
        engine.depositAndBorrow(100e18, 100e6);
        assertEq(engine.activeDebtPositions(), 1);
        assertEq(token.balanceOf(bob), 1000e18);
    }

    function testActiveBorrowerRegistrySwapRemovalAndReopening() public {
        open(alice, 10e18, 100e6);
        open(bob, 10e18, 100e6);
        open(keeper, 10e18, 100e6);
        assertEq(engine.activeBorrowerAt(1), bob);
        vm.prank(bob);
        engine.close(100e6, bob);
        assertEq(engine.activeBorrowerAt(1), keeper);
        assertEq(engine.activeDebtPositions(), 2);
        open(bob, 10e18, 100e6);
        assertEq(engine.activeBorrowerAt(2), bob);
        vm.prank(alice);
        engine.close(100e6, alice);
        vm.prank(bob);
        engine.close(100e6, bob);
        vm.prank(keeper);
        engine.close(100e6, keeper);
        assertEq(engine.activeDebtPositions(), 0);
    }

    function testActivePositionCapAndSlotReuse() public {
        for (uint256 i; i < 65; i++) {
            address actor = address(uint160(0xD000 + i));
            token.mint(actor, 1e18);
            vm.startPrank(actor);
            token.approve(address(engine), 1e18);
            cash.approve(address(engine), type(uint256).max);
            if (i == 64) vm.expectRevert(DockyardIsolatedCreditEngine.PositionLimitReached.selector);
            engine.depositAndBorrow(1e18, 1e6);
            vm.stopPrank();
        }
        assertEq(engine.activeDebtPositions(), 64);
        assertTrue(pool.capitalOperationsAllowed());
        vm.prank(address(0xD020));
        engine.close(1e6, address(0xD020));
        vm.prank(address(0xD040));
        engine.depositAndBorrow(1e18, 1e6);
        assertEq(engine.activeDebtPositions(), 64);
        assertTrue(pool.capitalOperationsAllowed());
    }

    function testMinimumDebtPreventsDustOpeningAndVoluntaryDustRemainder() public {
        DockyardIsolatedCreditEngine limited = new DockyardIsolatedCreditEngine(
            DockyardIsolatedCreditEngine.Config({
                usdg: address(cash),
                collateral: address(token),
                primary: address(primary),
                secondary: address(secondary),
                guardian: address(this),
                staleness: 1 days,
                maxLtvBps: 5000,
                liquidationLtvBps: 6500,
                bonusBps: 500,
                deviationBps: 500,
                minimumDebt: 100e6
            })
        );
        DockyardIsolatedCapitalPool capital = new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(token), address(limited), keeper, 10000e6, 1000, 1000
        );
        limited.bindPool(capital);
        limited.setRiskPaused(false);
        cash.mint(address(this), 1000e6);
        cash.approve(address(capital), 1000e6);
        capital.deposit(1000e6, address(this));
        vm.startPrank(alice);
        token.approve(address(limited), type(uint256).max);
        cash.approve(address(limited), type(uint256).max);
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        limited.depositAndBorrow(10e18, 99e6);
        limited.depositAndBorrow(10e18, 150e6);
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        limited.repay(alice, 60e6);
        limited.repay(alice, 50e6);
        limited.close(100e6, alice);
        vm.stopPrank();
        assertEq(limited.activeDebtPositions(), 0);
    }

    function testAtomicOpenAndClose() public {
        vm.startPrank(alice);
        engine.depositAndBorrow(10e18, 400e6);
        engine.close(400e6, alice);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 1000e18);
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(pool.totalAssets(), 100000e6);
    }

    function testUnfundedAtomicBorrowDoesNotTakeCollateral() public {
        pool.redeem(pool.balanceOf(address(this)), address(this), address(this));
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.InsufficientCash.selector);
        engine.depositAndBorrow(10e18, 400e6);
        assertEq(token.balanceOf(alice), 1000e18);
        assertEq(engine.positionDebt(alice), 0);
        assertEq(engine.activeDebtPositions(), 0);
    }

    function testInsufficientCloseMaximumRevertsRepayment() public {
        open(alice, 10e18, 400e6);
        uint256 balance = cash.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCreditEngine.UnsafePosition.selector);
        engine.close(399e6, alice);
        assertEq(cash.balanceOf(alice), balance);
        assertEq(engine.positionDebt(alice), 400e6);
    }

    function testQuoteMatchesLiquidationIncludingAccruedInterest() public {
        open(alice, 10e18, 400e6);
        vm.warp(block.timestamp + 365 days);
        updatePrice(30e8);
        (uint256 expectedPaid, uint256 expectedSeized) = engine.liquidationQuote(alice, type(uint256).max);
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(alice, type(uint256).max, expectedSeized);
        assertEq(paid, expectedPaid);
        assertEq(seized, expectedSeized);
    }

    function testDustLiquidationCannotTakeCollateralWithoutPayment() public {
        open(alice, 1e18, 1);
        updatePrice(1); // one token worth $0.00000001
        vm.prank(keeper);
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidAmount.selector);
        engine.liquidate(alice, 0, 0);
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(alice, 1, 1e18);
        assertEq(paid, 1);
        assertEq(seized, 1e18);
        assertEq(pool.outstandingPrincipal(), 0);
    }

    function testFuzzMultipleBorrowersCloseWithoutPhantomDebt(uint64 first, uint64 second, uint32 delay) public {
        uint256 a = bound(uint256(first), 1, 100e6);
        uint256 b = bound(uint256(second), 1, 100e6);
        uint256 elapsed = bound(uint256(delay), 1, 365 days);
        open(alice, 10e18, a);
        vm.warp(block.timestamp + elapsed);
        updatePrice(100e8);
        open(bob, 10e18, b);
        vm.warp(block.timestamp + elapsed);
        vm.prank(alice);
        engine.repay(alice, type(uint256).max);
        assertEq(pool.outstandingPrincipal(), b);
        vm.warp(block.timestamp + elapsed);
        vm.prank(bob);
        engine.repay(bob, type(uint256).max);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.interestReceivable(), 0);
        assertEq(engine.activeDebtPositions(), 0);
        assertLe(pool.cumulativeLoss(), 2); // only sum-of-floors interest dust
    }
}
