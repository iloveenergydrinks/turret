// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "../research/DockyardStockCreditEngine.t.sol";
import {DockyardIsolatedCreditEngine as Engine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardStockDirectLiquidator as Direct} from "src/research/DockyardStockDirectLiquidator.sol";
import {IsolatedMockV3Factory} from "../research/DockyardV3TwapFeed.t.sol";
import {IsolatedExitMockPool} from "../research/DockyardAtomicLiquidator.t.sol";

/// @notice Mock-market stress tests of the real stock engine, pool and executor.
/// No live-liquidity, transaction-inclusion or deployed-bytecode claim is made.
contract DockyardLiquidationStressTest is DockyardStockCreditFixture {
    address internal keeper = makeAddr("stress keeper");
    address internal secondLender = makeAddr("stress second lender");

    function setUp() public override {
        super.setUp();
        cash.mint(keeper, 1_000_000e6);
        vm.prank(keeper);
        cash.approve(address(engine), type(uint256).max);
    }

    function _actor(uint256 i) internal pure returns (address) {
        return address(uint160(0xCAFE0000 + i));
    }

    function _loan(address who, uint256 debt) internal {
        stock.mint(who, 1e18);
        cash.mint(who, 1000e6);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.startPrank(who);
        stock.approve(address(engine), type(uint256).max);
        cash.approve(address(engine), type(uint256).max);
        engine.depositAndBorrowChecked(1e18, debt, h, l);
        vm.stopPrank();
    }

    function _shock(uint256 rawPrice) internal {
        stockFeed.setAnswer(int256(rawPrice));
        usdA.setAnswer(1e8);
        usdB.setAnswer(1e18);
        gate.submitLiveness(_live());
    }

    function _reconcile(uint256 count) internal view {
        uint256 principal;
        uint256 collateral;
        uint256 interest;
        uint256 active;
        for (uint256 i; i < count; ++i) {
            address who = _actor(i);
            (uint256 c, uint256 p,,,) = engine.positions(who);
            principal += p;
            collateral += c;
            uint256 debt = engine.positionDebt(who);
            interest += debt - p;
            if (debt > 0) ++active;
        }
        assertEq(pool.outstandingPrincipal(), principal, "aggregate principal");
        assertEq(stock.balanceOf(address(engine)), collateral, "collateral custody");
        assertEq(engine.activeDebtPositions(), active, "active count");
        assertGe(pool.interestReceivable() + pool.pendingInterest(), interest, "aggregate interest covers loans");
        assertEq(cash.balanceOf(address(engine)), 0, "no stranded repayment");
        assertEq(cash.allowance(address(engine), address(pool)), 0, "no stale allowance");
        for (uint256 i; i < active; ++i) {
            address a = engine.activeBorrowerAt(i);
            assertGt(engine.positionDebt(a), 0);
            for (uint256 j; j < i; ++j) {
                assertTrue(a != engine.activeBorrowerAt(j), "duplicate borrower");
            }
        }
    }

    function _campaign(uint256 count, uint256 rawPrice, uint256 elapsed, uint256 seed) internal {
        uint256 halfShares = pool.balanceOf(lender) / 2;
        vm.prank(lender);
        pool.transfer(secondLender, halfShares);
        uint256 initialPrincipal;
        for (uint256 i; i < count; ++i) {
            uint256 debt = 1e6 + uint256(keccak256(abi.encode(seed, i))) % 9e6;
            initialPrincipal += debt;
            _loan(_actor(i), debt);
        }
        vm.warp(block.timestamp + elapsed);
        _shock(rawPrice);
        pool.accrueInterest();
        uint256 grossInterest = pool.interestReceivable();
        assertEq(pool.maxWithdraw(lender), 0, "pending loss blocks early lender exit");
        assertEq(pool.maxDeposit(secondLender), 0, "pending loss blocks new lender entry");
        engine.setRiskPaused(true);
        uint256 totalPaid;
        for (uint256 i; i < count; ++i) {
            // Alternate head/tail removal, exercising swap-and-pop at full capacity.
            address who = engine.activeBorrowerAt(i % 2 == 0 ? 0 : count - i - 1);
            (uint256 q, uint256 c) = engine.liquidationQuote(who, type(uint256).max);
            uint256 beforeCash = cash.balanceOf(keeper);
            vm.prank(keeper);
            (uint256 paid, uint256 seized) = engine.liquidate(who, q, c);
            assertEq(paid, q);
            assertEq(seized, c);
            assertEq(beforeCash - cash.balanceOf(keeper), paid);
            totalPaid += paid;
            _reconcile(count);
            if (i + 1 != count) assertEq(pool.maxWithdraw(lender), 0);
        }
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.interestReceivable(), 0);
        assertEq(pool.cumulativeLoss(), initialPrincipal + grossInterest - totalPaid, "all shortfalls recognized");
        uint256 expectedAssets = 1000e6 - initialPrincipal + totalPaid - pool.protocolFees();
        assertEq(pool.totalAssets(), expectedAssets, "cash recovery determines lender wealth");
        stockFeed.setShouldRevert(true);
        usdA.setShouldRevert(true);
        usdB.setShouldRevert(true);
        uint256 firstShares = pool.balanceOf(lender);
        uint256 secondShares = pool.balanceOf(secondLender);
        vm.prank(lender);
        uint256 a = pool.redeem(firstShares, lender, lender);
        vm.prank(secondLender);
        uint256 b = pool.redeem(secondShares, secondLender, secondLender);
        assertApproxEqAbs(a, b, 2, "lenders share losses equally");
        assertApproxEqAbs(a + b, expectedAssets, 2, "debt-free exits survive outages");
        assertEq(pool.totalSupply(), 0);
    }

    function testSixtyFourBorrowerCorrelatedCrashAndProRataLenderLoss() public {
        _campaign(64, 1e8, 365 days, 42);
    }

    function testSixtyFourBorrowerNearZeroPriceRequiresOnlyMicroUnitPerLoan() public {
        _campaign(64, 1, 30 days, 73);
    }

    function testFuzzCorrelatedCrashReconcilesAllBorrowers(uint8 count, uint32 price, uint32 elapsed, uint96 seed)
        public
    {
        _campaign(bound(count, 1, 16), bound(price, 1, 2e8), bound(elapsed, 0, 3650 days), seed);
    }

    function testExactLiquidationBoundaryAndOneOracleUnitBelow() public {
        _loan(_actor(0), 30e6);
        _shock(75e8);
        vm.expectRevert(Engine.HealthyPosition.selector);
        engine.liquidationQuote(_actor(0), type(uint256).max);
        _shock(75e8 - 1);
        (uint256 paid,) = engine.liquidationQuote(_actor(0), type(uint256).max);
        assertEq(paid, 30e6);
        vm.prank(keeper);
        engine.liquidate(_actor(0), paid, 1);
        assertEq(pool.cumulativeLoss(), 0);
        _reconcile(1);
    }

    function testAtCapacityClosedSlotCanBeReused() public {
        for (uint256 i; i < 64; ++i) {
            _loan(_actor(i), 1e6);
        }
        // The 65th attempted atomic open cannot strand its collateral.
        stock.mint(_actor(64), 1e18);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.startPrank(_actor(64));
        stock.approve(address(engine), type(uint256).max);
        vm.expectRevert(Engine.PositionLimitReached.selector);
        engine.depositAndBorrowChecked(1e18, 1e6, h, l);
        vm.stopPrank();
        (uint256 c,,,,) = engine.positions(_actor(64));
        assertEq(c, 0);
        vm.prank(_actor(17));
        engine.close(type(uint256).max, _actor(17));
        _loan(_actor(64), 1e6);
        _reconcile(65);
        assertEq(engine.activeDebtPositions(), 64);
    }

    function testRepaymentWinsRaceAgainstLiquidationWithoutKeeperSpend() public {
        _loan(_actor(0), 30e6);
        _shock(50e8);
        (uint256 q, uint256 c) = engine.liquidationQuote(_actor(0), type(uint256).max);
        vm.prank(_actor(0));
        engine.close(type(uint256).max, _actor(0));
        uint256 before = cash.balanceOf(keeper);
        vm.prank(keeper);
        vm.expectRevert(Engine.HealthyPosition.selector);
        engine.liquidate(_actor(0), q, c);
        assertEq(cash.balanceOf(keeper), before);
        _reconcile(1);
    }

    function testTopUpWinsRaceAndRestoresCapitalOperations() public {
        _loan(_actor(0), 30e6);
        _shock(50e8);
        assertEq(pool.maxWithdraw(lender), 0);
        stock.mint(_actor(0), 1e18);
        vm.prank(_actor(0));
        engine.depositCollateral(_actor(0), 1e18);
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        assertGt(pool.maxWithdraw(lender), 0);
        vm.prank(keeper);
        vm.expectRevert(Engine.HealthyPosition.selector);
        engine.liquidate(_actor(0), 30e6, 1);
        _reconcile(1);
    }

    function testPriceRecoveryMakesPreviouslyValidQuoteRevertAtomically() public {
        _loan(_actor(0), 30e6);
        _shock(50e8);
        (uint256 q, uint256 c) = engine.liquidationQuote(_actor(0), type(uint256).max);
        _shock(100e8);
        vm.prank(keeper);
        vm.expectRevert(Engine.HealthyPosition.selector);
        engine.liquidate(_actor(0), q, c);
        assertEq(engine.positionDebt(_actor(0)), 30e6);
        _reconcile(1);
    }

    function testOneUnliquidatedAccountFreezesOtherLendersUntilResolved() public {
        _loan(_actor(0), 30e6);
        _loan(_actor(1), 1e6);
        _shock(50e8);
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        assertEq(pool.maxWithdraw(lender), 0);
        vm.prank(keeper);
        engine.liquidate(_actor(0), 30e6, 1);
        assertGt(pool.maxWithdraw(lender), 0);
        assertEq(engine.positionDebt(_actor(1)), 1e6);
        _reconcile(2);
    }

    function testFuzzRepeatedPartialLiquidationsPreserveServiceableRemainder(uint96 maximum, uint32 rawPrice) public {
        _loan(_actor(0), 30e6);
        _shock(bound(rawPrice, 2e8, 70e8));
        uint256 cap = bound(maximum, 1e6, 30e6);
        for (uint256 i; i < 32; ++i) {
            uint256 debt = engine.positionDebt(_actor(0));
            if (debt == 0) break;
            uint256 q;
            uint256 c;
            try engine.liquidationQuote(_actor(0), cap) returns (uint256 a, uint256 b) {
                q = a;
                c = b;
            } catch (bytes memory reason) {
                assertTrue(
                    bytes4(reason) == Engine.HealthyPosition.selector || bytes4(reason) == Engine.InvalidAmount.selector
                );
                break;
            }
            vm.prank(keeper);
            (uint256 paid, uint256 seized) = engine.liquidate(_actor(0), cap, c);
            assertEq(q, paid);
            assertEq(c, seized);
            assertLe(paid, cap);
            uint256 remaining = engine.positionDebt(_actor(0));
            assertLt(remaining, debt);
            assertTrue(remaining == 0 || remaining >= engine.minimumDebt());
            _reconcile(1);
        }
        // An arbitrary cap can leave a healthy loan or a remainder requiring a
        // larger final payment. Test the uncapped recovery independently.
        try engine.liquidationQuote(_actor(0), type(uint256).max) returns (uint256 q, uint256 c) {
            vm.prank(keeper);
            engine.liquidate(_actor(0), q, c);
            assertEq(engine.positionDebt(_actor(0)), 0);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), Engine.HealthyPosition.selector);
        }
        _reconcile(1);
    }

    function testFuzzDirectExitDiscountEitherPaysProfitOrRollsBack(uint16 discount, uint32 priceRaw) public {
        _loan(_actor(0), 30e6);
        uint256 rawPrice = bound(priceRaw, 1e8, 70e8);
        _shock(rawPrice);
        IsolatedMockV3Factory f = new IsolatedMockV3Factory();
        uint256 rate = rawPrice * bound(discount, 5000, 11000) / 10000 / 100;
        IsolatedExitMockPool venue = new IsolatedExitMockPool(address(stock), address(cash), address(f), rate);
        f.register(address(stock), address(cash), address(venue));
        cash.mint(address(venue), 1000e6);
        Direct executor = new Direct(address(engine), address(venue), address(f));
        vm.prank(keeper);
        cash.approve(address(executor), type(uint256).max);
        (uint256 quote, uint256 coll) = engine.liquidationQuote(_actor(0), 30e6);
        uint256 expectedOut = coll * rate / 1e18;
        uint256 beforeCash = cash.balanceOf(keeper);
        uint256 beforeAssets = pool.totalAssets();
        if (expectedOut <= quote) {
            vm.prank(keeper);
            vm.expectRevert(Direct.InsufficientReturn.selector);
            executor.liquidateAndSell(_actor(0), 30e6, coll, 1, block.timestamp);
            assertEq(cash.balanceOf(keeper), beforeCash);
            assertEq(pool.totalAssets(), beforeAssets);
            assertEq(pool.cumulativeLoss(), 0);
            assertEq(engine.positionDebt(_actor(0)), 30e6);
            assertEq(stock.balanceOf(address(venue)), 0);
            assertEq(cash.balanceOf(address(venue)), 1000e6);
        } else {
            vm.prank(keeper);
            (uint256 paid, uint256 seized, uint256 out) =
                executor.liquidateAndSell(_actor(0), 30e6, coll, 1, block.timestamp);
            assertEq(paid, quote);
            assertEq(seized, coll);
            assertEq(out, expectedOut);
            assertEq(cash.balanceOf(keeper), beforeCash + out - paid);
            assertEq(engine.positionDebt(_actor(0)), 0);
        }
        assertEq(cash.allowance(address(executor), address(engine)), 0);
        assertEq(cash.balanceOf(address(executor)), 0);
        assertEq(stock.balanceOf(address(executor)), 0);
        _reconcile(1);
    }
}
