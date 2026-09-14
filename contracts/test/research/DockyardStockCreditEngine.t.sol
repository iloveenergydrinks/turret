// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";
import {DockyardStockCapitalPool} from "src/research/DockyardStockCapitalPool.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";
import {DockyardMockERC20, DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";
import {ScaledStockFixture} from "test/oracles/DockyardOracleV2.t.sol";

abstract contract DockyardStockCreditFixture is Test {
    uint256 constant KEY = 1234567;
    DockyardMockERC20 cash;
    ScaledStockFixture stock;
    DockyardMockOracle stockFeed;
    DockyardMockOracle usdA;
    DockyardMockOracle usdB;
    DockyardHeartbeatGuard guard;
    DockyardExecutionGate gate;
    DockyardStockCreditEngine engine;
    DockyardStockCapitalPool pool;
    address borrower = makeAddr("stock borrower");
    address lender = makeAddr("stock lender");
    uint256 healthySince;

    function setUp() public virtual {
        vm.chainId(4663);
        vm.warp(1_000_000);
        healthySince = block.timestamp;
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        stock = new ScaledStockFixture();
        stockFeed = new DockyardMockOracle(8, 100e8);
        usdA = new DockyardMockOracle(8, 1e8);
        usdB = new DockyardMockOracle(18, 1e18);
        guard = new DockyardHeartbeatGuard(address(stock), address(stockFeed), vm.addr(KEY), 86400);
        gate = new DockyardExecutionGate(vm.addr(KEY));
        engine = new DockyardStockCreditEngine(_config(), address(gate), _usdgConfig());
        pool = new DockyardStockCapitalPool(
            cash, address(stock), address(engine), makeAddr("treasury"), 1000e6, 1000, 1000
        );
        engine.bindPool(pool);
        cash.mint(lender, 1000e6);
        vm.startPrank(lender);
        cash.approve(address(pool), type(uint256).max);
        pool.deposit(1000e6, lender);
        vm.stopPrank();
        stock.mint(borrower, 10e18);
        cash.mint(borrower, 100e6);
        vm.startPrank(borrower);
        stock.approve(address(engine), type(uint256).max);
        cash.approve(address(engine), type(uint256).max);
        vm.stopPrank();
        vm.warp(block.timestamp + 120);
        _beforeActivate();
        gate.submitLiveness(_live());
        engine.setRiskPaused(false);
    }

    function _beforeActivate() internal virtual {}

    function _config() internal view returns (DockyardIsolatedCreditEngine.Config memory) {
        return DockyardIsolatedCreditEngine.Config(
            address(cash),
            address(stock),
            address(stockFeed),
            address(guard),
            address(this),
            86400,
            3000,
            4000,
            500,
            200,
            1e6
        );
    }

    function _usdgConfig() internal view virtual returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return DockyardStockCreditEngine.UsdgPricing(address(usdA), address(usdB), 300, 300, 200, 60);
    }

    function _sign(bytes32 hash, string memory name, address target) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                target
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, ECDSA.toTypedDataHash(domain, hash));
        return abi.encodePacked(r, s, v);
    }

    function _live() internal view returns (bytes memory) {
        DockyardExecutionGate.Liveness memory l = DockyardExecutionGate.Liveness(
            uint64(block.timestamp), uint64(healthySince), uint64(block.timestamp + 45), gate.epoch()
        );
        return abi.encode(
            l,
            _sign(
                keccak256(abi.encode(gate.LIVENESS_TYPEHASH(), l.observedAt, l.healthySince, l.validUntil, l.epoch)),
                "DockyardExecutionGate",
                address(gate)
            )
        );
    }

    function _health(uint256 close) internal view returns (bytes memory) {
        return _healthFor(address(engine), close);
    }

    function _healthFor(address target, uint256 close) internal view returns (bytes memory) {
        (uint256 value, uint256 time, uint80 round) = guard.currentData();
        DockyardHeartbeatGuard.Health memory h = DockyardHeartbeatGuard.Health(
            round,
            uint64(block.timestamp),
            uint64(close < block.timestamp + 45 ? close : block.timestamp + 45),
            uint64(block.timestamp - 120),
            uint64(close),
            keccak256(abi.encode(round, value, time)),
            guard.epoch()
        );
        return abi.encode(
            h,
            _sign(
                keccak256(
                    abi.encode(
                        guard.HEALTH_TYPEHASH(),
                        h.roundId,
                        h.observedAt,
                        h.validUntil,
                        h.sessionOpen,
                        h.sessionClose,
                        h.roundHash,
                        h.epoch
                    )
                ),
                "DockyardChainlinkGuard",
                address(guard)
            ),
            _sign(
                keccak256(
                    abi.encode(
                        engine.MARKET_HEALTH_TYPEHASH(),
                        h.roundId,
                        h.observedAt,
                        h.validUntil,
                        h.sessionOpen,
                        h.sessionClose,
                        h.roundHash,
                        h.epoch
                    )
                ),
                "DockyardStockCredit",
                target
            )
        );
    }

    function _open() internal {
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        engine.depositAndBorrowChecked(1e18, 20e6, h, l);
    }
}

contract DockyardStockCreditEngineTest is DockyardStockCreditFixture {
    function testQuoteRefreshesExpiredChecksWithoutMovingFunds() public {
        _open();
        vm.warp(block.timestamp + 46);
        assertEq(pool.maxWithdraw(lender), 0);
        uint256 beforeCash = cash.balanceOf(address(pool));
        uint256 beforeShares = pool.balanceOf(lender);
        uint256 beforeDebt = engine.positionDebt(borrower);
        (uint256 p, uint256 bp, uint256 deposits, uint256 withdrawals, uint256 redemptions) =
            engine.quoteWithChecks(lender, _health(block.timestamp + 3600), _live());
        assertEq(p, 100e18);
        assertEq(bp, p);
        assertGt(deposits, 0);
        assertEq(withdrawals, pool.availableCash());
        assertGt(redemptions, 0);
        assertEq(cash.balanceOf(address(pool)), beforeCash);
        assertEq(pool.balanceOf(lender), beforeShares);
        assertEq(engine.positionDebt(borrower), beforeDebt);
    }

    function testQuoteCannotRefreshClosedSessionOrUnsafeLoanIntoExit() public {
        _open();
        bytes memory health = _health(block.timestamp + 10);
        vm.warp(block.timestamp + 11);
        bytes memory live = _live();
        vm.expectRevert();
        engine.quoteWithChecks(lender, health, live);
        stockFeed.setAnswer(30e8);
        (,, uint256 deposits, uint256 withdrawals, uint256 redemptions) =
            engine.quoteWithChecks(lender, _health(block.timestamp + 3600), live);
        assertEq(deposits, 0);
        assertEq(withdrawals, 0);
        assertEq(redemptions, 0);
    }

    function testTokenOraclePauseStopsRiskButAllowsRepayAndIdleExit() public {
        _open();
        stock.setOraclePaused(true);
        vm.expectRevert();
        engine.price();
        assertEq(pool.maxWithdraw(lender), 0);
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        assertEq(engine.positionDebt(borrower), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        pool.redeem(shares, lender, lender);
        assertEq(pool.balanceOf(lender), 0);
    }

    function testAtomicOpenAndNoLegacyBorrowBypass() public {
        vm.prank(borrower);
        vm.expectRevert();
        engine.depositAndBorrow(1e18, 20e6);
        assertEq(stock.balanceOf(borrower), 10e18);
        _open();
        assertEq(engine.positionDebt(borrower), 20e6);
        assertEq(pool.availableCash(), 980e6);
    }

    function testUsdGIsNotAssumedOneDollarAndUsesConservativeMixedDecimals() public {
        usdA.setAnswer(2e8);
        usdB.setAnswer(2.02e18);
        assertEq(engine.price(), uint256(100e18) * 1e18 / 2.02e18);
        usdA.setAnswer(0.5e8);
        usdB.setAnswer(0.5e18);
        assertEq(engine.price(), 200e18);
    }

    function testUsdGDivergenceStalenessAndTimestampSkewBlockBorrowing() public {
        usdB.setAnswer(1.03e18);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        usdB.setAnswer(1e18);
        usdB.setUpdatedAt(block.timestamp - 61);
        usdA.setUpdatedAt(block.timestamp);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        usdB.setUpdatedAt(block.timestamp - 300);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
    }

    function testEachUsdGFeedRequiredAndNonpositiveFuturePricesRejected() public {
        usdA.setShouldRevert(true);
        vm.expectRevert();
        engine.price();
        usdA.setShouldRevert(false);
        usdB.setAnswer(0);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        usdB.setAnswer(-1);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        usdB.setAnswer(1e18);
        usdB.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
    }

    function testLendersCannotExitAtOldBookValueAfterSessionCloses() public {
        bytes memory h = _health(block.timestamp + 10);
        bytes memory l = _live();
        vm.prank(borrower);
        engine.depositAndBorrowChecked(1e18, 20e6, h, l);
        assertEq(pool.maxWithdraw(lender), 980e6);
        vm.warp(block.timestamp + 10);
        assertEq(pool.maxDeposit(lender), 0);
        assertEq(pool.maxWithdraw(lender), 0);
        vm.prank(lender);
        vm.expectRevert();
        pool.withdraw(1e6, lender, lender);
        assertEq(engine.price(), 100e18, "liquidation valuation is still available");
    }

    function testOutageAllowsTopupRepaymentAndDebtFreeLenderExit() public {
        _open();
        vm.warp(block.timestamp + 365 days);
        engine.setRiskPaused(true);
        stockFeed.setShouldRevert(true);
        usdA.setShouldRevert(true);
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
        assertGt(pool.redeem(shares, lender, lender), 1000e6);
    }

    function testLiquidationRequiresLivenessButNotFreshSessionApproval() public {
        _open();
        vm.warp(block.timestamp + 45);
        stockFeed.setAnswer(40e8);
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);
        engine.liquidate(borrower, 100e6, 1);
        (uint256 paid,) = engine.liquidateChecked(borrower, 100e6, 1, _live());
        assertGt(paid, 20e6);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testDebtBearingCollateralWithdrawalNeedsFreshSession() public {
        _open();
        vm.warp(block.timestamp + 45);
        gate.submitLiveness(_live());
        vm.prank(borrower);
        vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector);
        engine.withdrawCollateral(1, borrower);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        engine.withdrawCollateralChecked(1, borrower, h, l);
    }

    function testCorporateActionBlocksOldPriceAndMultiplierNotAppliedTwice() public {
        _open();
        stock.setMultiplier(2e18, block.timestamp);
        vm.expectRevert(DockyardHeartbeatGuard.CorporateActionPending.selector);
        engine.price();
        stockFeed.setAnswer(200e8);
        assertEq(engine.price(), 200e18);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);
        engine.borrowingPrice();
    }

    function testRuntimeChangesBlockRiskButNotFullRepayment() public {
        _open();
        vm.etch(address(usdA), hex"60006000fd");
        vm.expectRevert(DockyardStockCreditEngine.DependencyChanged.selector);
        engine.price();
        vm.prank(borrower);
        engine.close(20e6, borrower);
        assertEq(stock.balanceOf(borrower), 10e18);
    }

    function testQuarantineCannotBeBypassedByDirectLiquidation() public {
        _open();
        vm.prank(vm.addr(KEY));
        guard.trip(true);
        vm.expectRevert(DockyardHeartbeatGuard.PriceQuarantined.selector);
        engine.liquidate(borrower, 100e6, 0);
    }

    function testLivenessTripRevokesAllRiskOperations() public {
        _open();
        vm.prank(vm.addr(KEY));
        gate.trip();
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);
        engine.price();
        assertEq(pool.maxWithdraw(lender), 0);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        vm.expectRevert(DockyardExecutionGate.RecoveryPending.selector);
        engine.borrowChecked(1e6, h, l);
    }

    function testConfigurationRejectsReusedFeedsAndDifferentGuardians() public {
        DockyardStockCreditEngine.UsdgPricing memory u = _usdgConfig();
        u.secondary = u.primary;
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidConfiguration.selector);
        new DockyardStockCreditEngine(_config(), address(gate), u);
        u = _usdgConfig();
        DockyardExecutionGate other = new DockyardExecutionGate(makeAddr("wrong guardian"));
        vm.expectRevert(DockyardIsolatedCreditEngine.InvalidConfiguration.selector);
        new DockyardStockCreditEngine(_config(), address(other), u);
    }

    function testFuzzConservativeUsdGQuote(uint64 value) public {
        value = uint64(bound(value, 1e6, 100e8));
        usdA.setAnswer(int256(uint256(value)));
        usdB.setAnswer(int256(uint256(value) * 1e10));
        uint256 expected = uint256(100e18) * 1e18 / (uint256(value) * 1e10);
        assertEq(engine.price(), expected);
    }

    function testCheckedLenderWithdrawalRefreshesExpiredProofsAtomically() public {
        _open();
        vm.warp(block.timestamp + 45);
        assertEq(pool.maxWithdraw(lender), 0);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(lender);
        pool.withdrawChecked(10e6, lender, lender, 10e12, block.timestamp + 300, h, l);
        assertEq(cash.balanceOf(lender), 10e6);
        assertGt(pool.maxWithdraw(lender), 0);
    }

    function testCheckedLenderDepositRefreshesProofsAndKeepsExactShareBound() public {
        _open();
        vm.warp(block.timestamp + 45);
        cash.mint(lender, 10e6);
        uint256 quote = pool.previewDeposit(10e6);
        uint256 before = pool.balanceOf(lender);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(lender);
        pool.depositChecked(10e6, lender, quote, block.timestamp + 300, h, l);
        assertEq(pool.balanceOf(lender) - before, quote);
        assertEq(cash.balanceOf(lender), 0);
    }

    function testShareBoundFailureRollsBackProofPublicationAndFunds() public {
        _open();
        vm.warp(block.timestamp + 45);
        cash.mint(lender, 10e6);
        uint256 quote = pool.previewDeposit(10e6);
        uint256 before = pool.balanceOf(lender);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(lender);
        vm.expectRevert(DockyardIsolatedCapitalPool.Slippage.selector);
        pool.depositChecked(10e6, lender, quote + 1, block.timestamp + 300, h, l);
        assertEq(pool.balanceOf(lender), before);
        assertEq(cash.balanceOf(lender), 10e6);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);
        gate.requireLive();
    }

    function testBadProofCannotMoveLenderFunds() public {
        _open();
        uint256 before = pool.balanceOf(lender);
        bytes memory l = _live();
        vm.prank(lender);
        vm.expectRevert();
        pool.withdrawChecked(10e6, lender, lender, 10e12, block.timestamp + 300, hex"1234", l);
        assertEq(pool.balanceOf(lender), before);
        assertEq(cash.balanceOf(lender), 0);
    }

    function testFreshProofCannotMakeUnsafeLoanWithdrawable() public {
        _open();
        stockFeed.setAnswer(40e8);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(lender);
        vm.expectRevert();
        pool.withdrawChecked(1e6, lender, lender, 1e12, block.timestamp + 300, h, l);
        assertEq(cash.balanceOf(lender), 0);
    }

    function testCheckedIdleRedemptionNeedsNoProofDuringTotalOracleOutage() public {
        _open();
        vm.warp(block.timestamp + 45);
        usdA.setShouldRevert(true);
        stockFeed.setShouldRevert(true);
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertGe(pool.redeemChecked(shares, lender, lender, 1000e6, block.timestamp + 300, "", ""), 1000e6);
    }

    function testCheckedWithdrawalCannotSpendAnotherLendersShares() public {
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        vm.expectRevert();
        pool.withdrawChecked(1e6, borrower, lender, 1e12, block.timestamp + 300, h, l);
        assertEq(pool.balanceOf(lender), 1000e12);
    }

    function testStockContractsFitProductionEvmRuntimeLimits() public view {
        assertLe(address(engine).code.length, 24576);
        assertLe(address(pool).code.length, 24576);
    }
}
