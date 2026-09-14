// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardStockCapitalPool} from "src/research/DockyardStockCapitalPool.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";

/// @notice Stock Earn accounting compatibility, NOT stock-market admission.
/// Uses actual RH token bytecode with synthetic balances, locally deployed pools
/// and mock prices. No broadcaster, user key, price-provider or sale-path claim.
contract DockyardStockEarnForkTest is Test {
    IERC20Metadata constant USDG = IERC20Metadata(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address borrower = makeAddr("stock-earn-borrower");
    address lender = makeAddr("stock-earn-lender");
    address treasury = makeAddr("stock-earn-treasury");
    IERC20Metadata token;
    DockyardMockOracle primary;
    DockyardMockOracle usdgPrimary;
    DockyardMockOracle usdgSecondary;
    DockyardStockCreditEngine engine;
    DockyardStockCapitalPool pool;
    DockyardHeartbeatGuard guard;
    DockyardExecutionGate gate;
    uint256 constant KEY = 147852;
    uint256 healthySince;

    function setUp() public {
        uint256 pinned = vm.envUint("STOCK_EARN_FORK_BLOCK");
        require(pinned > 0, "Explicit pinned block required");
        vm.createSelectFork(vm.envString("STOCK_EARN_FORK_RPC_URL"), pinned);
        assertEq(block.chainid, 4663);
    }

    function _deploy(uint256 index, bool fund) internal {
        string memory manifest = vm.readFile("./utils/assets/dockyard-pilot-heartbeat-config.json");
        token = IERC20Metadata(
            vm.parseJsonAddress(manifest, string.concat(".markets[", vm.toString(index), "].collateral"))
        );
        assertEq(token.decimals(), 18);
        // Intentionally controlled price: this test does not certify live feeds.
        primary = new DockyardMockOracle(8, 100e8);
        usdgPrimary = new DockyardMockOracle(8, 1e8);
        usdgSecondary = new DockyardMockOracle(18, 1e18);
        guard = new DockyardHeartbeatGuard(address(token), address(primary), vm.addr(KEY), 3600);
        gate = new DockyardExecutionGate(vm.addr(KEY));
        healthySince = block.timestamp;
        engine = new DockyardStockCreditEngine(
            DockyardIsolatedCreditEngine.Config({
                usdg: address(USDG),
                collateral: address(token),
                primary: address(primary),
                secondary: address(guard),
                guardian: address(this),
                staleness: 1 hours,
                maxLtvBps: 3000,
                liquidationLtvBps: 4000,
                bonusBps: 500,
                deviationBps: 200,
                minimumDebt: 1e6
            }),
            address(gate),
            DockyardStockCreditEngine.UsdgPricing(address(usdgPrimary), address(usdgSecondary), 300, 300, 200, 60)
        );
        // 10% borrower APR / 10% share of received interest: TEST parameters only.
        pool = new DockyardStockCapitalPool(USDG, address(token), address(engine), treasury, 100e6, 1000, 1000);
        engine.bindPool(pool);
        vm.warp(block.timestamp + 120);
        gate.submitLiveness(_live());
        engine.setRiskPaused(false);
        deal(address(USDG), lender, 100e6);
        deal(address(token), borrower, 1e18);
        if (fund) {
            vm.startPrank(lender);
            USDG.approve(address(pool), 100e6);
            pool.depositChecked(100e6, lender, 100e12, block.timestamp + 300, "", "");
            vm.stopPrank();
        }
    }

    function _borrow() private {
        bytes memory health = _health();
        bytes memory live = _live();
        vm.startPrank(borrower);
        token.approve(address(engine), 1e18);
        engine.depositAndBorrowChecked(1e18, 30e6, health, live);
        vm.stopPrank();
    }

    function testAllTenStocksRepayAndLenderReceivesNetInterestDuringOracleOutage() public {
        for (uint256 i; i < 10; ++i) {
            uint256 snapshot = vm.snapshot();
            _deploy(i, true);
            _borrow();
            vm.warp(block.timestamp + 365 days);
            engine.setRiskPaused(true);
            primary.setShouldRevert(true);
            usdgPrimary.setShouldRevert(true);
            usdgSecondary.setShouldRevert(true);
            assertEq(pool.maxWithdraw(lender), 0, "Debt and unknown prices block book-value exits");
            assertEq(engine.positionDebt(borrower), 33e6);
            deal(address(USDG), borrower, 33e6);
            vm.startPrank(borrower);
            USDG.approve(address(engine), 33e6);
            assertEq(engine.close(33e6, borrower), 33e6);
            vm.stopPrank();
            assertEq(token.balanceOf(borrower), 1e18);
            assertEq(pool.protocolFees(), 300000);
            assertEq(pool.totalAssets(), 102700000);
            uint256 shares = pool.balanceOf(lender);
            vm.prank(lender);
            uint256 received = pool.redeemChecked(shares, lender, lender, 102699999, block.timestamp + 300, "", "");
            assertApproxEqAbs(received, 102700000, 1);
            assertEq(pool.balanceOf(lender), 0);
            assertEq(engine.positionDebt(borrower), 0);
            assertEq(USDG.allowance(borrower, address(engine)), 0);
            assertTrue(vm.revertTo(snapshot));
        }
    }

    function testStockLoanWithNoLenderCashRevertsCollateralTransferAtomically() public {
        _deploy(0, false);
        bytes memory health = _health();
        bytes memory live = _live();
        vm.startPrank(borrower);
        token.approve(address(engine), 1e18);
        vm.expectRevert(DockyardIsolatedCapitalPool.InsufficientCash.selector);
        engine.depositAndBorrowChecked(1e18, 30e6, health, live);
        vm.stopPrank();
        assertEq(token.balanceOf(borrower), 1e18);
        assertEq(token.balanceOf(address(engine)), 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testStockEarnWithdrawalCannotTakeCashCurrentlyLentOut() public {
        _deploy(0, true);
        _borrow();
        assertEq(pool.maxWithdraw(lender), 70e6);
        vm.startPrank(lender);
        vm.expectRevert();
        pool.withdrawWithMaxShares(70e6 + 1, lender, lender, 100e12, block.timestamp + 300);
        pool.withdrawWithMaxShares(70e6, lender, lender, 70e12, block.timestamp + 300);
        vm.stopPrank();
        assertEq(pool.availableCash(), 0);
        assertEq(pool.balanceOf(lender), 30e12);
    }

    function testStockPriceGapRecognizesLossInsteadOfPromisingLenderPrincipal() public {
        _deploy(0, true);
        _borrow();
        primary.setAnswer(10e8);
        assertEq(pool.maxWithdraw(lender), 0);
        (uint256 paid, uint256 seized) = engine.liquidationQuote(borrower, 30e6);
        deal(address(USDG), address(this), paid);
        USDG.approve(address(engine), paid);
        engine.liquidate(borrower, paid, seized);
        assertEq(seized, 1e18);
        assertEq(pool.cumulativeLoss(), 30e6 - paid);
        assertEq(engine.positionDebt(borrower), 0);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        uint256 recovered = pool.redeemWithMinAssets(shares, lender, lender, 70e6 + paid - 1, block.timestamp + 300);
        assertLt(recovered, 100e6);
        assertApproxEqAbs(recovered, 70e6 + paid, 1);
        // Seized stock is held, not sold: no liquidation liquidity is asserted.
        assertEq(token.balanceOf(address(this)), seized);
    }

    function _sign(bytes32 hash, string memory name, address target) private view returns (bytes memory) {
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

    function _health() internal view returns (bytes memory) {
        (uint256 value, uint256 time, uint80 round) = guard.currentData();
        DockyardHeartbeatGuard.Health memory h = DockyardHeartbeatGuard.Health(
            round,
            uint64(block.timestamp),
            uint64(block.timestamp + 45),
            uint64(block.timestamp - 120),
            uint64(block.timestamp + 3600),
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
                address(engine)
            )
        );
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
}
