// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {DockyardMockERC20, DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCreditEngineFixture} from "test/research/DockyardIsolatedCreditEngine.t.sol";
import {DockyardStockCreditFixture} from "test/research/DockyardStockCreditEngine.t.sol";
import {ManagedApi3Boundary} from "test/research/DockyardApi3ManagedUsdgFeed.t.sol";
import {IsolatedMockV3Factory, IsolatedMockV3Pool} from "test/research/DockyardV3TwapFeed.t.sol";
import {SignedPythFixture} from "test/oracles/DockyardOracleV2.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {DockyardPythVerifier} from "src/Oracles/DockyardPythVerifier.sol";
import {DockyardPythUsdRatioFeed} from "src/research/DockyardPythUsdRatioFeed.sol";
import {DockyardApi3UsdgFeed} from "src/research/DockyardApi3UsdgFeed.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";
import {DockyardV3TwapFeed} from "src/research/DockyardV3TwapFeed.sol";
import {DockyardCorroboratedV3Feed, ICorroboratingFeed} from "src/research/DockyardCorroboratedV3Feed.sol";
import {DockyardThresholdPriceFeed} from "src/research/DockyardThresholdPriceFeed.sol";

// Network-free fault injection at external source boundaries. Engines, adapters,
// signatures, pool accounting and liquidation execution below are actual code.
// Repro cases are permanent safety regressions; all assertions run by default.
contract DockyardOracleStressMutableFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public round = 1;
    uint80 public answered = 1;

    constructor(uint8 d, int256 a) {
        set(d, a, block.timestamp);
    }

    function set(uint8 d, int256 a, uint256 t) public {
        decimals = d;
        answer = a;
        updatedAt = t;
    }

    function setRound(uint80 r, uint80 a) external {
        round = r;
        answered = a;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, updatedAt, updatedAt, answered);
    }
}

contract DockyardOracleStressIsolated is DockyardIsolatedCreditEngineFixture {
    function _engine(address a, address b) internal returns (DockyardIsolatedCreditEngine) {
        return new DockyardIsolatedCreditEngine(
            DockyardIsolatedCreditEngine.Config(
                address(cash), address(token), a, b, address(this), 60, 5000, 6500, 500, 500, 1
            )
        );
    }

    function testFuzzFreshnessBothSourcesIncludesExactLimit(uint32 ageA, uint32 ageB) public {
        ageA = uint32(bound(ageA, 0, 86402));
        ageB = uint32(bound(ageB, 0, 86402));
        primary.setUpdatedAt(block.timestamp - ageA);
        secondary.setUpdatedAt(block.timestamp - ageB);
        if (ageA > 86400 || ageB > 86400) {
            vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
            engine.price();
        } else {
            assertEq(engine.price(), 100e18);
        }
    }

    function testExactFreshnessBoundaryIsInclusive() public {
        primary.setUpdatedAt(block.timestamp - 86400);
        secondary.setUpdatedAt(block.timestamp - 86400);
        assertEq(engine.price(), 100e18);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.price();
    }

    function testFuzzMalformedRoundAndTimeRejected(uint8 fault, bool first) public {
        DockyardOracleStressMutableFeed a = new DockyardOracleStressMutableFeed(8, 100e8);
        DockyardOracleStressMutableFeed b = new DockyardOracleStressMutableFeed(8, 100e8);
        DockyardIsolatedCreditEngine e = _engine(address(a), address(b));
        DockyardOracleStressMutableFeed bad = first ? a : b;
        fault = uint8(bound(fault, 0, 5));
        if (fault == 0) bad.setRound(0, 0);
        if (fault == 1) bad.setRound(2, 1);
        if (fault == 2) bad.set(8, 0, block.timestamp);
        if (fault == 3) bad.set(8, -1, block.timestamp);
        if (fault == 4) bad.set(8, 100e8, 0);
        if (fault == 5) bad.set(8, 100e8, block.timestamp + 1);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        e.price();
    }

    function testFuzzNormalizationAcrossAllSupportedDecimals(uint8 da, uint8 db, uint64 whole) public {
        da = uint8(bound(da, 0, 18));
        db = uint8(bound(db, 0, 18));
        whole = uint64(bound(whole, 1, 1e12));
        DockyardOracleStressMutableFeed a = new DockyardOracleStressMutableFeed(da, int256(uint256(whole) * 10 ** da));
        DockyardOracleStressMutableFeed b = new DockyardOracleStressMutableFeed(db, int256(uint256(whole) * 10 ** db));
        assertEq(_engine(address(a), address(b)).price(), uint256(whole) * 1e18);
    }

    function testFuzzReproDeviationAdmitsFractionBeyondConfiguredLimit(uint32 excess) public {
        excess = uint32(bound(excess, 1, 999999));
        uint256 low = 100e8;
        uint256 high = 105e8 + excess;
        primary.setAnswer(int256(low));
        secondary.setAnswer(int256(high));
        assertGt((high - low) * 10000, low * engine.deviationBps());
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleMismatch.selector);
        engine.price();
        secondary.setAnswer(105e8); // Exactly 500 bps remains usable.
        assertEq(engine.price(), 100e18);
        secondary.setAnswer(10501000000);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleMismatch.selector);
        engine.price();
    }

    function testUnboundedRawAnswerFailsClosedWithArithmeticPanic() public {
        primary.setAnswer(type(int256).max);
        vm.expectRevert(stdError.arithmeticError);
        engine.price();
    }

    function testFuzzIsolatedPrecisionDriftInEitherSourceFailsClosed(
        uint8 beforeDecimals,
        uint8 afterDecimals,
        bool first
    ) public {
        beforeDecimals = uint8(bound(beforeDecimals, 0, 18));
        afterDecimals = uint8(bound(afterDecimals, 0, 17));
        if (afterDecimals >= beforeDecimals) ++afterDecimals;
        int256 initial = int256(100 * 10 ** uint256(beforeDecimals));
        DockyardOracleStressMutableFeed a = new DockyardOracleStressMutableFeed(beforeDecimals, initial);
        DockyardOracleStressMutableFeed b = new DockyardOracleStressMutableFeed(beforeDecimals, initial);
        DockyardIsolatedCreditEngine e = _engine(address(a), address(b));
        assertEq(e.price(), 100e18);
        DockyardOracleStressMutableFeed changed = first ? a : b;
        changed.set(afterDecimals, int256(100 * 10 ** uint256(afterDecimals)), block.timestamp);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        e.price();
        changed.set(beforeDecimals, initial, block.timestamp);
        assertEq(e.price(), 100e18);
    }

    function testFuzzOutageBlocksUnhealthyLiquidationAtomicallyButAllowsClosure(uint8 fault, bool first) public {
        open(alice, 10e18, 400e6);
        updatePrice(40e8);
        (uint256 paid,) = engine.liquidationQuote(alice, 400e6);
        assertGt(paid, 0, "control: loan is liquidatable with healthy sources");
        DockyardMockOracle bad = first ? primary : secondary;
        fault = uint8(bound(fault, 0, 3));
        if (fault == 0) bad.setShouldRevert(true);
        if (fault == 1) bad.setUpdatedAt(block.timestamp - 86401);
        if (fault == 2) bad.setUpdatedAt(block.timestamp + 1);
        if (fault == 3) bad.setAnswer(100e8);
        uint256 cashBefore = cash.balanceOf(keeper);
        uint256 poolCash = pool.availableCash();
        vm.expectRevert();
        engine.liquidationQuote(alice, 400e6);
        vm.prank(keeper);
        vm.expectRevert();
        engine.liquidate(alice, 400e6, 1);
        assertEq(engine.positionDebt(alice), 400e6);
        (uint256 collateral,,,,) = engine.positions(alice);
        assertEq(collateral, 10e18);
        assertEq(cash.balanceOf(keeper), cashBefore);
        assertEq(pool.availableCash(), poolCash);
        assertEq(pool.maxWithdraw(address(this)), 0);
        vm.startPrank(alice);
        engine.depositCollateral(alice, 1e18);
        engine.repay(alice, 1e6);
        engine.close(type(uint256).max, alice);
        vm.stopPrank();
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(token.balanceOf(alice), 1000e18);
        pool.redeem(pool.balanceOf(address(this)), address(this), address(this));
        assertEq(pool.totalSupply(), 0);
    }
}

// Uses the active family's actual managed API3 adapter, 24h stock heartbeat and
// 25h source-specific USDG limits. The shared abstract fixture signs real proofs.
contract DockyardOracleStressStock is DockyardStockCreditFixture {
    ManagedApi3Boundary api3;
    DockyardApi3ManagedUsdgFeed managed;
    bytes32 constant ID = 0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7;

    function setUp() public override {
        vm.chainId(4663);
        api3 = new ManagedApi3Boundary();
        api3.mapName(ID);
        managed = new DockyardApi3ManagedUsdgFeed(address(api3), address(api3).codehash, 90000);
        super.setUp();
    }

    function _beforeActivate() internal override {
        _api(1e18, block.timestamp);
    }

    function _api(int224 a, uint256 t) internal {
        api3.set(ID, a, uint32(t));
    }

    function _usdgConfig() internal view override returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return DockyardStockCreditEngine.UsdgPricing(address(usdA), address(managed), 90000, 90000, 200, 90000);
    }

    function testFuzzReproUsdDeviationAdmitsFractionBeyondConfiguredLimit(uint64 excess) public {
        excess = uint64(bound(excess, 1, 1e14 - 1));
        uint256 high = 1.02e18 + excess;
        usdA.setAnswer(1e8);
        _api(int224(int256(high)), block.timestamp);
        assertGt((high - 1e18) * 10000, uint256(1e18) * engine.usdgMaxDeviationBps());
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        _api(1.02e18, block.timestamp); // Exactly 200 bps remains usable.
        assertEq(engine.price(), uint256(100e18) * 1e18 / 1.02e18);
        _api(1.0201e18, block.timestamp);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
    }

    function testFuzzUsdFreshnessIndependentBudgetsAndNoCrossSourceRefresh(uint32 ageA, uint32 ageB) public {
        ageA = uint32(bound(ageA, 0, 90001));
        ageB = uint32(bound(ageB, 0, 90001));
        usdA.setUpdatedAt(block.timestamp - ageA);
        _api(1e18, block.timestamp - ageB);
        if (ageA >= 90000 || ageB >= 90000) {
            vm.expectRevert();
            engine.price();
        } else {
            assertEq(engine.price(), 100e18);
        }
    }

    function testFuzzTimestampSkewEnforcedAtOneSecondBoundary(uint32 skew) public {
        DockyardStockCreditEngine.UsdgPricing memory u = _usdgConfig();
        u.maxTimestampSkew = 60;
        DockyardStockCreditEngine e = new DockyardStockCreditEngine(_config(), address(gate), u);
        skew = uint32(bound(skew, 59, 61));
        usdA.setUpdatedAt(block.timestamp);
        _api(1e18, block.timestamp - skew);
        if (skew > 60) {
            vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
            e.price();
        } else {
            assertEq(e.price(), 100e18);
        }
    }

    function testFuzzUsdDepegNormalizationIsConservative(uint64 units, uint16 spread) public {
        units = uint64(bound(units, 1, 1e12));
        spread = uint16(bound(spread, 0, 200));
        uint256 high = uint256(units) * 1e10 * (10000 + spread) / 10000;
        usdA.setAnswer(int256(uint256(units)));
        _api(int224(int256(high)), block.timestamp);
        assertEq(engine.price(), Math.mulDiv(100e18, 1e18, high));
    }

    function testStockHeartbeatExactExpiryAndWeekendRecovery() public {
        _open();
        stockFeed.setAnswer(40e8);
        uint256 lastRound = block.timestamp;
        vm.warp(lastRound + 86399);
        usdA.setAnswer(1e8);
        _api(1e18, block.timestamp);
        gate.submitLiveness(_live());
        (uint256 paid,) = engine.liquidationQuote(borrower, 100e6);
        assertGt(paid, 0, "expired borrowing proof does not itself block liquidation");
        vm.warp(lastRound + 86400);
        gate.submitLiveness(_live());
        vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);
        engine.liquidationQuote(borrower, 100e6);
        vm.warp(lastRound + 64 hours);
        usdA.setAnswer(1e8);
        _api(1e18, block.timestamp);
        gate.submitLiveness(_live());
        vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);
        engine.liquidationQuote(borrower, 100e6);
        // A fresh canonical reopening round, not a refreshed guardian proof, restores pricing.
        stockFeed.setAnswer(40e8);
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        (paid,) = engine.liquidateChecked(borrower, 100e6, 1, _live());
        assertGt(paid, 20e6);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testLivenessExactExpiryBlocksEvenFreshLiquidationUntilRefresh() public {
        _open();
        stockFeed.setAnswer(40e8);
        uint256 issuedAt = block.timestamp;
        vm.warp(issuedAt + 44);
        engine.liquidationQuote(borrower, 100e6);
        vm.warp(issuedAt + 45);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);
        engine.liquidationQuote(borrower, 100e6);
        gate.submitLiveness(_live());
        engine.liquidationQuote(borrower, 100e6);
        vm.expectRevert();
        engine.borrowingPrice();
    }

    function testFuzzStockOutageRollsBackLiquidationAndAllowsDebtFreeExit(uint8 fault) public {
        _open();
        stockFeed.setAnswer(40e8);
        engine.liquidationQuote(borrower, 100e6);
        fault = uint8(bound(fault, 0, 7));
        if (fault == 0) usdA.setShouldRevert(true);
        if (fault == 1) usdA.setUpdatedAt(block.timestamp - 90000);
        if (fault == 2) _api(1e18, block.timestamp - 90000);
        if (fault == 3) api3.mapName(bytes32(uint256(123)));
        if (fault == 4) stockFeed.setShouldRevert(true);
        if (fault == 5) stockFeed.setUpdatedAt(block.timestamp - 86400);
        if (fault == 6) _api(1.03e18, block.timestamp);
        if (fault == 7) {
            vm.prank(vm.addr(KEY));
            guard.trip(true);
        }
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        bytes memory live = _live();
        uint256 available = pool.availableCash();
        vm.expectRevert();
        engine.liquidateChecked(borrower, 100e6, 1, live);
        assertEq(cash.balanceOf(address(this)), 100e6);
        assertEq(pool.availableCash(), available);
        assertEq(engine.positionDebt(borrower), 20e6);
        (uint256 collateral,,,,) = engine.positions(borrower);
        assertEq(collateral, 1e18);
        assertEq(pool.maxWithdraw(lender), 0);
        vm.startPrank(borrower);
        engine.depositCollateral(borrower, 1e18);
        engine.repay(borrower, 1e6);
        engine.close(type(uint256).max, borrower);
        vm.stopPrank();
        assertEq(stock.balanceOf(borrower), 10e18);
        assertEq(engine.activeDebtPositions(), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        pool.redeem(shares, lender, lender);
        assertEq(pool.totalSupply(), 0);
    }

    function testReproStockDecimalChangeBehindSameCodeMispricesByTen() public {
        DockyardOracleStressMutableFeed mutableStock = new DockyardOracleStressMutableFeed(8, 100e8);
        DockyardHeartbeatGuard g =
            new DockyardHeartbeatGuard(address(stock), address(mutableStock), vm.addr(KEY), 86400);
        DockyardIsolatedCreditEngine.Config memory c = _config();
        c.primary = address(mutableStock);
        c.secondary = address(g);
        DockyardStockCreditEngine e = new DockyardStockCreditEngine(c, address(gate), _usdgConfig());
        assertEq(e.price(), 100e18);
        bytes32 beforeHash = address(mutableStock).codehash;
        mutableStock.set(9, 100e9, block.timestamp); // Same economic $100; different source precision.
        assertEq(address(mutableStock).codehash, beforeHash);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidPrice.selector);
        e.price();
        mutableStock.set(8, 100e8, block.timestamp);
        assertEq(e.price(), 100e18);
    }

    function testFuzzStockPrecisionDriftInBothDirectionsFailsClosed(uint8 beforeDecimals, uint8 afterDecimals) public {
        beforeDecimals = uint8(bound(beforeDecimals, 0, 18));
        afterDecimals = uint8(bound(afterDecimals, 0, 17));
        if (afterDecimals >= beforeDecimals) ++afterDecimals;
        DockyardOracleStressMutableFeed source =
            new DockyardOracleStressMutableFeed(beforeDecimals, int256(100 * 10 ** uint256(beforeDecimals)));
        DockyardHeartbeatGuard g = new DockyardHeartbeatGuard(address(stock), address(source), vm.addr(KEY), 86400);
        DockyardIsolatedCreditEngine.Config memory c = _config();
        c.primary = address(source);
        c.secondary = address(g);
        DockyardStockCreditEngine e = new DockyardStockCreditEngine(c, address(gate), _usdgConfig());
        assertEq(e.price(), 100e18);
        source.set(afterDecimals, int256(100 * 10 ** uint256(afterDecimals)), block.timestamp);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidPrice.selector);
        e.price();
    }

    function testUsdPrecisionDriftInEitherSourceFailsClosed() public {
        DockyardOracleStressMutableFeed a = new DockyardOracleStressMutableFeed(8, 1e8);
        DockyardOracleStressMutableFeed b = new DockyardOracleStressMutableFeed(18, 1e18);
        DockyardStockCreditEngine e = new DockyardStockCreditEngine(
            _config(), address(gate), DockyardStockCreditEngine.UsdgPricing(address(a), address(b), 300, 300, 200, 60)
        );
        assertEq(e.price(), 100e18);
        a.set(9, 1e9, block.timestamp);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        e.price();
        a.set(8, 1e8, block.timestamp);
        b.set(17, 1e17, block.timestamp);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        e.price();
        b.set(18, 1e18, block.timestamp);
        assertEq(e.price(), 100e18);
    }
}

contract DockyardOracleStressApi3 is Test {
    ManagedApi3Boundary server;
    DockyardApi3UsdgFeed fixedFeed;
    DockyardApi3ManagedUsdgFeed managed;
    bytes32 constant ID = 0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7;

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1000000);
        server = new ManagedApi3Boundary();
        server.mapName(ID);
        fixedFeed = new DockyardApi3UsdgFeed(address(server), address(server).codehash);
        managed = new DockyardApi3ManagedUsdgFeed(address(server), address(server).codehash, 90000);
        for (uint256 i; i < 5; ++i) {
            server.set(fixedFeed.beaconId(i), 1e18, uint32(block.timestamp));
        }
        server.set(ID, 1e18, uint32(block.timestamp));
    }

    function testFuzzEveryFixedProviderVetoesInvalidTime(uint8 index, uint8 fault) public {
        index = uint8(bound(index, 0, 4));
        fault = uint8(bound(fault, 0, 3));
        uint256 t = fault == 0 ? 0 : fault == 1 ? block.timestamp + 1 : block.timestamp - 60;
        server.set(fixedFeed.beaconId(index), fault == 3 ? int224(0) : int224(1e18), uint32(t));
        vm.expectRevert(DockyardApi3UsdgFeed.Unavailable.selector);
        fixedFeed.latestRoundData();
    }

    function testFuzzFixedPairSkewAndOldestTimestamp(uint32 skew) public {
        skew = uint32(bound(skew, 9, 11));
        server.set(fixedFeed.beaconId(4), 1e18, uint32(block.timestamp - skew));
        if (skew > 10) {
            vm.expectRevert(DockyardApi3UsdgFeed.Unavailable.selector);
            fixedFeed.latestRoundData();
        } else {
            (uint80 round,,, uint256 updated,) = fixedFeed.latestRoundData();
            assertEq(updated, block.timestamp - skew);
            assertEq(round, updated);
        }
    }

    function testFixedMedianCannotHideOneProviderDeviation() public {
        server.set(fixedFeed.beaconId(4), 1.01e18, uint32(block.timestamp));
        (, int256 answer,,,) = fixedFeed.latestRoundData();
        assertEq(answer, 1e18);
        server.set(fixedFeed.beaconId(4), 1.01e18 + 1, uint32(block.timestamp));
        vm.expectRevert(DockyardApi3UsdgFeed.Unavailable.selector);
        fixedFeed.latestRoundData();
    }

    function testFixedAndManagedExactAgeBoundaries() public {
        uint256 t = block.timestamp;
        vm.warp(t + 59);
        fixedFeed.latestRoundData();
        vm.warp(t + 60);
        vm.expectRevert(DockyardApi3UsdgFeed.Unavailable.selector);
        fixedFeed.latestRoundData();
        vm.warp(t + 89999);
        managed.latestRoundData();
        vm.warp(t + 90000);
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        managed.latestRoundData();
    }

    function testFuzzManagedValueBounds(uint128 value) public {
        value = uint128(bound(value, 1, type(uint128).max));
        server.set(ID, int224(uint224(value)), uint32(block.timestamp));
        (, int256 answer,, uint256 updated,) = managed.latestRoundData();
        assertEq(uint256(answer), value);
        assertEq(updated, block.timestamp);
        server.set(ID, int224(int256(uint256(type(uint128).max) + 1)), uint32(block.timestamp));
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        managed.latestRoundData();
    }

    function testManagedFutureOneSecondAndRemapFailClosed() public {
        server.set(ID, 1e18, uint32(block.timestamp + 1));
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        managed.latestRoundData();
        server.set(ID, 1e18, uint32(block.timestamp));
        server.mapName(bytes32(uint256(1)));
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        managed.latestRoundData();
    }
}

contract DockyardOracleStressPyth is Test {
    uint256 constant KEY = 923456;
    DockyardPythVerifier hub;
    DockyardPythUsdRatioFeed ratio;
    DockyardPythVerifier.Report a;
    DockyardPythVerifier.Report b;

    function setUp() public {
        vm.warp(1000000);
        vm.deal(address(this), 1 ether);
        hub = new DockyardPythVerifier(address(new SignedPythFixture(vm.addr(KEY))));
        ratio = new DockyardPythUsdRatioFeed(
            DockyardPythUsdRatioFeed.Config(
                address(hub),
                address(new DockyardMockERC20("Token", "T", 18)),
                address(new DockyardMockERC20("USDG", "U", 6)),
                3441,
                232,
                60,
                10,
                100,
                2,
                3
            )
        );
        a = DockyardPythVerifier.Report(
            uint64(block.timestamp * 1e6), uint64(block.timestamp * 1e6), 25e6, 1000, 2, -8, 0
        );
        b = DockyardPythVerifier.Report(
            uint64(block.timestamp * 1e6), uint64(block.timestamp * 1e6), 100e6, 1000, 3, -8, 0
        );
    }

    function _part(uint32 id, DockyardPythVerifier.Report memory r) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(id, uint8(6), uint8(0), r.price, uint8(3), r.publishers, uint8(4), r.exponent),
            abi.encodePacked(uint8(5), r.confidence, uint8(9), r.session, uint8(12), uint8(1), r.feedUpdateTimestampUs)
        );
    }

    function _signed(uint64 timestamp) internal view returns (bytes memory) {
        bytes memory p = bytes.concat(
            abi.encodePacked(uint32(2479346549), timestamp, uint8(4), uint8(2)), _part(3441, a), _part(232, b)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, keccak256(p));
        return abi.encodePacked(uint32(706910618), r, s, v - 27, uint16(p.length), p);
    }

    function _publish() internal {
        hub.update{value: 1}(_signed(uint64(block.timestamp * 1e6)));
    }

    function testFuzzPairSkewCheckedBeforeMicrosecondRounding(uint32 micros) public {
        micros = uint32(bound(micros, 9999999, 10000001));
        b.feedUpdateTimestampUs -= micros;
        _publish();
        if (micros > 10000000) {
            vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
            ratio.latestRoundData();
        } else {
            (uint80 round,,, uint256 updated,) = ratio.latestRoundData();
            assertEq(round, b.feedUpdateTimestampUs);
            assertEq(updated, b.feedUpdateTimestampUs / 1e6);
        }
    }

    function testSignedReportOneMicrosecondFutureRejectedByRealParser() public {
        bytes memory signed = _signed(uint64(block.timestamp * 1e6 + 1));
        vm.expectRevert(DockyardPythVerifier.StaleReport.selector);
        hub.update{value: 1}(signed);
    }

    function testReportExpiryNotRenewedByReplay() public {
        bytes memory signed = _signed(uint64(block.timestamp * 1e6));
        hub.update{value: 1}(signed);
        uint256 t = block.timestamp;
        vm.warp(t + 29);
        hub.update{value: 1}(signed);
        ratio.latestRoundData();
        assertEq(hub.report(3441).timestampUs, t * 1e6);
        vm.warp(t + 30);
        vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
        ratio.latestRoundData();
        vm.expectRevert(DockyardPythVerifier.StaleReport.selector);
        hub.update{value: 1}(signed);
    }

    function testFreshReportCannotRenewSixtySecondOldUnderlyingPrice() public {
        a.feedUpdateTimestampUs -= 60000000;
        b.feedUpdateTimestampUs -= 60000000;
        _publish();
        vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
        ratio.latestRoundData();
    }

    function testFuzzConservativeRatioAcrossExponents(uint8 ea, uint8 eb, uint64 pa, uint64 pb) public {
        ea = uint8(bound(ea, 0, 18));
        eb = uint8(bound(eb, 0, 18));
        pa = uint64(bound(pa, 10000, 1e12));
        pb = uint64(bound(pb, 10000, 1e12));
        a.exponent = -int16(uint16(ea));
        b.exponent = -int16(uint16(eb));
        a.price = int64(pa);
        b.price = int64(pb);
        a.confidence = pa / 100;
        b.confidence = pb / 100;
        _publish();
        uint256 lower = uint256(pa - a.confidence) * 10 ** (18 - ea);
        uint256 upper = uint256(pb + b.confidence) * 10 ** (18 - eb);
        uint256 expected = Math.mulDiv(lower, 1e18, upper);
        if (expected == 0) {
            vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
            ratio.latestRoundData();
        } else {
            (, int256 answer,,,) = ratio.latestRoundData();
            assertEq(uint256(answer), expected);
            uint256 midpoint = Math.mulDiv(uint256(pa) * 10 ** (18 - ea), 1e18, uint256(pb) * 10 ** (18 - eb));
            assertLe(uint256(answer), midpoint);
        }
    }

    function testFuzzNewSignedInvalidSourceSupersedesHealthyCache(uint8 fault, bool collateralSide) public {
        _publish();
        ratio.latestRoundData();
        vm.warp(block.timestamp + 1);
        a.feedUpdateTimestampUs = uint64(block.timestamp * 1e6);
        b.feedUpdateTimestampUs = a.feedUpdateTimestampUs;
        DockyardPythVerifier.Report memory bad = collateralSide ? a : b;
        fault = uint8(bound(fault, 0, 4));
        if (fault == 0) bad.session = 4;
        if (fault == 1) bad.publishers = 1;
        if (fault == 2) bad.feedUpdateTimestampUs = 0;
        if (fault == 3) bad.price = 0;
        if (fault == 4) bad.confidence = uint64(bad.price) / 100 + 1;
        if (collateralSide) a = bad;
        else b = bad;
        _publish();
        vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
        ratio.latestRoundData();
    }
}

contract DockyardOracleStressDex is Test {
    DockyardV3TwapFeed dex;
    DockyardCorroboratedV3Feed corroborated;
    DockyardOracleStressMutableFeed referenceFeed;
    IsolatedMockV3Pool first;
    IsolatedMockV3Pool second;
    address token;

    function setUp() public {
        vm.warp(1000000);
        token = address(new DockyardMockERC20("Token", "T", 18));
        address middle = address(new DockyardMockERC20("WETH", "W", 18));
        address cash = address(new DockyardMockERC20("USDG", "U", 6));
        IsolatedMockV3Factory factory = new IsolatedMockV3Factory();
        first = new IsolatedMockV3Pool(token, middle, address(factory));
        second = new IsolatedMockV3Pool(middle, cash, address(factory));
        factory.register(token, middle, address(first));
        factory.register(middle, cash, address(second));
        dex = new DockyardV3TwapFeed(
            DockyardV3TwapFeed.Config(
                token, middle, cash, address(factory), address(first), address(second), 1800, 300, 200, 1e15, 1e15
            )
        );
        referenceFeed = new DockyardOracleStressMutableFeed(18, 1e30);
        corroborated = new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(referenceFeed)), 60, 500);
    }

    function testFuzzPoolObservationExactBoundary(uint32 age, bool firstHop) public {
        age = uint32(bound(age, 299, 301));
        (firstHop ? first : second).setState(uint32(block.timestamp - age), 2, true, true);
        if (age > 300) {
            vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
            dex.latestRoundData();
        } else {
            (,,, uint256 updated,) = dex.latestRoundData();
            assertEq(updated, block.timestamp - age);
        }
    }

    function testReferenceBoundaryInclusiveAndNoReadRedating() public {
        referenceFeed.set(18, 1e30, block.timestamp - 60);
        (,,, uint256 updated,) = corroborated.latestRoundData();
        assertEq(updated, block.timestamp - 60);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        corroborated.latestRoundData();
    }

    function testReferenceDecimalDriftRejectedUnlikeStockGuard() public {
        bytes32 hash = address(referenceFeed).codehash;
        referenceFeed.set(17, 1e29, block.timestamp);
        assertEq(address(referenceFeed).codehash, hash);
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        corroborated.latestRoundData();
    }

    function testCorroboratedDeviationRejectsOneUnitBeyondLimit() public {
        referenceFeed.set(18, 1.05e30, block.timestamp);
        corroborated.latestRoundData();
        referenceFeed.set(18, 1.05e30 + 1, block.timestamp);
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        corroborated.latestRoundData();
    }

    function testFuzzConfirmedGapStillRequiresEveryPool(uint8 fault, bool firstHop) public {
        first.setPrice(first.token0() == token ? int24(-7000) : int24(7000), 0);
        (, uint256 spot,,) = dex.guardedQuotes();
        referenceFeed.set(18, int256(spot), block.timestamp);
        (uint256 value,, bool gap) = corroborated.quote();
        assertTrue(gap);
        assertEq(value, spot);
        fault = uint8(bound(fault, 0, 3));
        IsolatedMockV3Pool p = firstHop ? first : second;
        if (fault == 0) p.setState(uint32(block.timestamp - 301), 2, true, true);
        if (fault == 1) p.setState(uint32(block.timestamp), 2, false, true);
        if (fault == 2) p.setLiquidity(1, 1);
        if (fault == 3) p.setResponse(true, false, false);
        vm.expectRevert();
        corroborated.quote();
    }
}

contract DockyardOracleStressThreshold is Test {
    DockyardThresholdPriceFeed feed;
    uint256[4] keys;

    function setUp() public {
        vm.warp(1000000);
        keys = [uint256(101), 202, 303, 404];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j = i + 1; j < 4; ++j) {
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[j], keys[i]) = (keys[i], keys[j]);
            }
        }
        address[] memory reporters = new address[](4);
        for (uint256 i; i < 4; ++i) {
            reporters[i] = vm.addr(keys[i]);
        }
        feed =
            new DockyardThresholdPriceFeed(address(1), address(2), reporters, 3, 30, 7, 1, keccak256("stress policy"));
    }

    function _report() internal view returns (DockyardThresholdPriceFeed.PriceReport memory) {
        return DockyardThresholdPriceFeed.PriceReport(
            address(1),
            address(2),
            1,
            1,
            uint64(block.timestamp),
            uint64(block.timestamp),
            uint64(block.timestamp + 30),
            1e18,
            7,
            keccak256("stress policy"),
            keccak256("independent observations")
        );
    }

    function _sign(DockyardThresholdPriceFeed.PriceReport memory r) internal view returns (bytes[] memory signatures) {
        signatures = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 x, bytes32 y) = vm.sign(keys[i], feed.reportDigest(r));
            signatures[i] = abi.encodePacked(x, y, v);
        }
    }

    function testLateSigningCannotExtendObservationLifetime() public {
        DockyardThresholdPriceFeed.PriceReport memory r = _report();
        r.observedAt -= 29; // validUntil still grants 30 seconds from signing.
        feed.submit(r, _sign(r));
        feed.latestRoundData();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardThresholdPriceFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testFuzzExpiryIsEarlierOfValidUntilAndObservationAge(uint8 lifetime) public {
        lifetime = uint8(bound(lifetime, 1, 30));
        DockyardThresholdPriceFeed.PriceReport memory r = _report();
        r.validUntil = r.observedAt + lifetime;
        feed.submit(r, _sign(r));
        vm.warp(uint256(r.validUntil) - 1);
        feed.latestRoundData();
        vm.warp(r.validUntil);
        vm.expectRevert(DockyardThresholdPriceFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testFuzzSignedFutureOrStaleTimeRejected(uint8 fault) public {
        fault = uint8(bound(fault, 0, 3));
        DockyardThresholdPriceFeed.PriceReport memory r = _report();
        if (fault == 0) {
            ++r.observedAt;
            ++r.signedAt;
        }
        if (fault == 1) ++r.signedAt;
        if (fault == 2) r.observedAt -= 30;
        if (fault == 3) r.validUntil = uint64(block.timestamp);
        bytes[] memory signatures = _sign(r);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidReport.selector);
        feed.submit(r, signatures);
    }

    function testHigherSequenceCannotRefreshOldObservation() public {
        DockyardThresholdPriceFeed.PriceReport memory r = _report();
        feed.submit(r, _sign(r));
        vm.warp(block.timestamp + 29);
        ++r.sequence;
        r.signedAt = uint64(block.timestamp);
        r.validUntil = uint64(block.timestamp + 30);
        bytes[] memory signatures = _sign(r);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidReport.selector);
        feed.submit(r, signatures);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardThresholdPriceFeed.Unavailable.selector);
        feed.latestRoundData();
    }
}
