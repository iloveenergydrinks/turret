// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/Test.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardStockEarnForkTest} from "./DockyardStockEarnFork.t.sol";
import {DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardStockCapitalPool} from "src/research/DockyardStockCapitalPool.sol";
import {DockyardStockDirectLiquidator} from "src/research/DockyardStockDirectLiquidator.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";

/// Real pinned AAPL/USDG pool, token and factory code/state. The loan, balances,
/// guardian and oracle history are local fixtures, not live-source qualification.
contract DockyardAaplCanaryExitForkTest is DockyardStockEarnForkTest {
    address private keeper = makeAddr("AAPL canary fork keeper");
    DockyardStockDirectLiquidator private executor;
    uint256 private posted;

    function _prepare(uint256 loan) private {
        string memory m = vm.envString("STOCK_CANARY_MANIFEST_JSON");
        DockyardStockCreditEngine liveEngine = DockyardStockCreditEngine(vm.parseJsonAddress(m, ".addresses.engine"));
        DockyardStockCapitalPool livePool = DockyardStockCapitalPool(vm.parseJsonAddress(m, ".addresses.pool"));
        address venue = vm.parseJsonAddress(m, ".directExit.salePool");
        address factory = vm.parseJsonAddress(m, ".directExit.factory");
        token = IERC20Metadata(address(liveEngine.collateralToken()));
        assertEq(address(token), 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9);
        assertEq(address(token).codehash, vm.parseJsonBytes32(m, ".hashes.collateral"));
        assertEq(address(USDG).codehash, vm.parseJsonBytes32(m, ".hashes.usdg"));
        assertEq(address(liveEngine).codehash, vm.parseJsonBytes32(m, ".hashes.engine"));
        assertEq(address(livePool).codehash, vm.parseJsonBytes32(m, ".hashes.pool"));
        assertEq(venue.codehash, vm.parseJsonBytes32(m, ".directExit.poolCodeHash"));
        assertEq(factory.codehash, vm.parseJsonBytes32(m, ".directExit.factoryCodeHash"));
        assertEq(liveEngine.minimumDebt(), 1e6);
        assertEq(liveEngine.maxLtvBps(), 3000);
        assertEq(liveEngine.liquidationLtvBps(), 4000);
        assertEq(liveEngine.bonusBps(), 500);
        assertEq(livePool.debtLimit(), 50e6);
        assertGe(livePool.availableCash(), loan);
        assertEq(livePool.outstandingPrincipal(), 0);

        (, int256 answer,,,) = liveEngine.primary().latestRoundData();
        assertGt(answer, 0);
        assertEq(liveEngine.primary().decimals(), 8);
        primary = new DockyardMockOracle(8, answer * 2);
        (, int256 usdA,,,) = liveEngine.usdgPrimary().latestRoundData();
        (, int256 usdB,,,) = liveEngine.usdgSecondary().latestRoundData();
        usdgPrimary = new DockyardMockOracle(liveEngine.usdgPrimary().decimals(), usdA);
        usdgSecondary = new DockyardMockOracle(liveEngine.usdgSecondary().decimals(), usdB);
        guard = new DockyardHeartbeatGuard(address(token), address(primary), vm.addr(KEY), liveEngine.staleness());
        gate = new DockyardExecutionGate(vm.addr(KEY));
        healthySince = block.timestamp;
        engine = new DockyardStockCreditEngine(DockyardIsolatedCreditEngine.Config({
            usdg: address(USDG), collateral: address(token), primary: address(primary), secondary: address(guard),
            guardian: address(this), staleness: liveEngine.staleness(), maxLtvBps: liveEngine.maxLtvBps(),
            liquidationLtvBps: liveEngine.liquidationLtvBps(), bonusBps: liveEngine.bonusBps(),
            deviationBps: liveEngine.deviationBps(), minimumDebt: liveEngine.minimumDebt()
        }), address(gate), DockyardStockCreditEngine.UsdgPricing(address(usdgPrimary), address(usdgSecondary),
            liveEngine.usdgPrimaryMaxAge(), liveEngine.usdgSecondaryMaxAge(),
            liveEngine.usdgMaxDeviationBps(), liveEngine.usdgMaxTimestampSkew()));
        pool = new DockyardStockCapitalPool(USDG, address(token), address(engine), treasury,
            livePool.debtLimit(), livePool.revenueFeeBps(), livePool.borrowAprBps());
        engine.bindPool(pool);
        vm.warp(block.timestamp + 120);
        gate.submitLiveness(_live());
        deal(address(USDG), lender, 250e6);
        vm.startPrank(lender);
        USDG.approve(address(pool), 250e6);
        pool.depositChecked(250e6, lender, 250e12, block.timestamp + 30, "", "");
        vm.stopPrank();
        engine.setRiskPaused(false);
        // Hypothetical loan opened at twice the pinned stock quote. Current
        // real DEX liquidity is NOT rewritten to manufacture a profitable sale.
        posted = loan * 1e12 * 2 * 1e8 / uint256(answer);
        deal(address(token), borrower, posted);
        bytes memory health = _health();
        bytes memory live = _live();
        vm.startPrank(borrower);
        token.approve(address(engine), posted);
        engine.depositAndBorrowChecked(posted, loan, health, live);
        vm.stopPrank();
        primary.setAnswer(answer);
        engine.setRiskPaused(true);
        deal(address(USDG), keeper, 60e6);
        executor = new DockyardStockDirectLiquidator(address(engine), venue, factory);
        assertEq(executor.poolFee(), 500);
        assertTrue(executor.routeHealthy());
        vm.prank(keeper);
        USDG.approve(address(executor), loan);
    }

    function testCanaryOneDollarLiquidationReturnsCashThroughRealPool() public {
        _prepare(1e6);
        // Explicit negative-control override reproduces the retired $1 floor.
        // Normal production-configured threshold for this size is $0.005.
        _sellAndExit(1e6, vm.envOr("CANARY_FORK_MIN_PROFIT_OVERRIDE", uint256(5000)));
    }

    function testCanaryTenDollarLiquidationReturnsCashThroughRealPool() public {
        _prepare(10e6);
        _sellAndExit(10e6, 50000);
    }

    function testCanaryFullDebtCapLiquidationReturnsCashThroughRealPool() public {
        _prepare(50e6);
        _sellAndExit(50e6, 250000);
    }

    function testCanaryFailedSaleRollsBackAndCanRetryWithoutStrandedFunds() public {
        _prepare(1e6);
        address venue = address(executor.salePool());
        uint256 venueCash = USDG.balanceOf(venue);
        uint256 venueStock = token.balanceOf(venue);
        bytes memory live = _live();
        vm.prank(keeper);
        vm.expectRevert(DockyardStockDirectLiquidator.InsufficientReturn.selector);
        executor.liquidateAndSellChecked(borrower, 1e6, 1, 1e6, block.timestamp + 30, live);
        assertEq(engine.positionDebt(borrower), 1e6);
        (uint256 collateral,,,,) = engine.positions(borrower);
        assertEq(collateral, posted);
        assertEq(pool.outstandingPrincipal(), 1e6);
        assertEq(pool.availableCash(), 249e6);
        assertEq(USDG.balanceOf(keeper), 60e6);
        assertEq(USDG.balanceOf(venue), venueCash);
        assertEq(token.balanceOf(venue), venueStock);
        assertEq(USDG.balanceOf(address(executor)), 0);
        assertEq(token.balanceOf(address(executor)), 0);
        assertEq(USDG.allowance(address(executor), address(engine)), 0);
        _sellAndExit(1e6, 5000);
    }

    function _sellAndExit(uint256 loan, uint256 minimumProfit) private {
        bytes memory live = _live();
        uint256 gasBefore = gasleft();
        vm.prank(keeper);
        (uint256 paid, uint256 seized, uint256 out) = executor.liquidateAndSellChecked(
            borrower, loan, 1, minimumProfit, block.timestamp + 30, live);
        uint256 gasUsed = gasBefore - gasleft();
        assertEq(paid, loan);
        assertGe(out, loan + minimumProfit);
        assertEq(USDG.balanceOf(keeper), 60e6 + out - paid);
        assertEq(USDG.balanceOf(address(executor)), 0);
        assertEq(token.balanceOf(address(executor)), 0);
        assertEq(USDG.allowance(address(executor), address(engine)), 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.cumulativeLoss(), 0);
        (uint256 remaining,,,,) = engine.positions(borrower);
        vm.prank(borrower);
        engine.withdrawCollateral(remaining, borrower);
        assertEq(token.balanceOf(borrower), posted - seized);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertEq(pool.redeemChecked(shares, lender, lender, 250e6, block.timestamp + 30, "", ""), 250e6);
        console2.log("Loan / paid (micro-USDG)", paid);
        console2.log("Sale returned (micro-USDG)", out);
        console2.log("Gross return before gas (micro-USDG)", out - paid);
        console2.log("Executor call EVM gas (not L1 data fee)", gasUsed);
    }
}
