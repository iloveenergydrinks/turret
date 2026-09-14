// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedMarketsForkFixture} from "./DockyardIsolatedMarketsFork.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardV3TwapFeed, IIsolatedV3Pool} from "src/research/DockyardV3TwapFeed.sol";

/// @notice Tests the actual DEX TWAP/engine/atomic-exit combination on a pinned
/// fork. The second feed is a test-controlled, immediately responsive spot feed.
/// This is an optimistic timing reference, NOT independent production pricing.
/// Synthetic whale inventory moves real pools; no arbitrage is simulated.
contract DockyardIsolatedOracleGapForkTest is DockyardIsolatedMarketsForkFixture {
    DockyardV3TwapFeed internal twap;

    function _deployFeeds(address token, address venue, uint256 initialPrice)
        internal
        override
        returns (address, address)
    {
        twap = new DockyardV3TwapFeed(
            DockyardV3TwapFeed.Config({
                collateral: token,
                intermediate: WETH,
                usdg: USDG,
                factory: FACTORY,
                firstPool: venue,
                secondPool: USDG_POOL,
                window: 1800,
                maxObservationAge: 600,
                maxSpotTickDeviation: 200,
                firstMinLiquidity: 1e18,
                secondMinLiquidity: 1e15
            })
        );
        secondary = new DockyardMockOracle(18, int256(initialPrice));
        return (address(twap), address(secondary));
    }

    function testCashcatGapDelaysLiquidationUntilHistoryCatchesUp() public {
        _gap(CASHCAT, CASHCAT_POOL, false);
    }

    function testPonsGapDelaysLiquidationUntilHistoryCatchesUp() public {
        _gap(PONS, PONS_POOL, false);
    }

    function testCashcatSecondGapDuringDelayCreatesLenderLoss() public {
        _gap(CASHCAT, CASHCAT_POOL, true);
    }

    function testPonsSecondGapDuringDelayCreatesLenderLoss() public {
        _gap(PONS, PONS_POOL, true);
    }

    function testCashcatInactiveOracleBlocksLiquidationButNotRepayment() public {
        _inactive(CASHCAT, CASHCAT_POOL);
    }

    function testPonsInactiveOracleBlocksLiquidationButNotRepayment() public {
        _inactive(PONS, PONS_POOL);
    }

    function _shock(address token, address venue, uint256 target) internal returns (uint256 price) {
        uint256 chunk = IERC20(token).balanceOf(venue) / 20;
        for (uint256 i; i < 40 && _tokenPrice(venue, token) > target; ++i) {
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + chunk);
            _swap(token, venue, chunk);
        }
        price = _tokenPrice(venue, token);
        assertLe(price, target, "Shock target not reached");
        secondary.setAnswer(int256(price));
    }

    function _assertBlocked() internal {
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.liquidationQuote(borrower, type(uint256).max);
        assertFalse(capital.capitalOperationsAllowed(), "No share entry/exit at stale book value");
        assertEq(capital.maxWithdraw(address(this)), 0);
        assertEq(capital.maxRedeem(address(this)), 0);
    }

    function _gap(address token, address venue, bool cascade) internal {
        (, uint256 loan, uint256 initialPrice) = _open(token, venue);
        uint256 start = block.timestamp;
        uint256 initialGapPrice = _shock(token, venue, initialPrice * 5500 / 10000);
        _assertBlocked();
        // A counterfactual immediate, correct price would permit a solvent exit
        // before the second crash. Mock ONLY for this comparison, then restore
        // all state before measuring the real adapter's behavior.
        uint256 snapshot = vm.snapshotState();
        vm.mockCall(
            address(twap),
            abi.encodeWithSelector(twap.latestRoundData.selector),
            abi.encode(
                uint80(block.timestamp),
                int256(initialGapPrice),
                block.timestamp,
                block.timestamp,
                uint80(block.timestamp)
            )
        );
        ExitResult memory immediate = _liquidateAndExit(token, venue);
        assertEq(immediate.paid, loan);
        assertEq(capital.cumulativeLoss(), 0);
        vm.clearMockedCalls();
        assertTrue(vm.revertToState(snapshot));
        _assertBlocked();
        uint256 firstAvailable;
        uint256 blockedSamples;
        for (uint256 elapsed = 60; elapsed <= 3600; elapsed += 60) {
            vm.warp(start + elapsed);
            if (cascade && elapsed == 900) _shock(token, venue, initialPrice / 4);
            // Real, small trades keep actual observations fresh. They slightly
            // move prices and incur real pool fees; their impact is reported.
            if (elapsed % 300 == 0) {
                _refresh(token, venue);
                _refresh(WETH, USDG_POOL);
            }
            secondary.setAnswer(int256(_tokenPrice(venue, token)));
            try engine.liquidationQuote(borrower, type(uint256).max) returns (uint256 paid, uint256 seized) {
                assertGt(paid, 0);
                assertGt(seized, 0);
                firstAvailable = elapsed;
                break;
            } catch (bytes memory reason) {
                assertTrue(
                    bytes4(reason) == DockyardIsolatedCreditEngine.OracleUnavailable.selector
                        || bytes4(reason) == DockyardIsolatedCreditEngine.OracleMismatch.selector,
                    "Only oracle blocking is expected while economically unsafe"
                );
                ++blockedSamples;
                assertFalse(capital.capitalOperationsAllowed());
                assertEq(capital.cumulativeLoss(), 0, "Loss not recognized before liquidation");
                assertGe(engine.positionDebt(borrower), loan);
            }
        }
        assertGt(firstAvailable, cascade ? 900 : 0, "Required measured delay");
        assertLe(firstAvailable, 3600, "No executable quote inside experiment window");
        uint256 finalPrice = _tokenPrice(venue, token);
        ExitResult memory result = _liquidateAndExit(token, venue);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(capital.outstandingPrincipal(), 0);
        assertEq(capital.interestReceivable(), 0);
        assertTrue(capital.capitalOperationsAllowed());
        if (cascade) assertGt(capital.cumulativeLoss(), 0);
        else assertEq(capital.cumulativeLoss(), 0);
        emit log_named_address("Gap collateral", token);
        emit log_named_uint("Cascade at 900 seconds", cascade ? 1 : 0);
        emit log_named_uint("Initial price after gap bps", initialGapPrice * 10000 / initialPrice);
        emit log_named_uint("Counterfactual immediate loss USDG (mock price)", 0);
        emit log_named_uint("Price at executable quote bps", finalPrice * 10000 / initialPrice);
        emit log_named_uint("First available quote seconds (60s samples)", firstAvailable);
        emit log_named_uint("Blocked samples after initial gap", blockedSamples);
        emit log_named_uint("Loan USDG (6 decimals)", loan);
        emit log_named_uint("Debt paid USDG (6 decimals)", result.paid);
        emit log_named_uint("Exit USDG (6 decimals)", result.usdgOut);
        emit log_named_uint("Recognized loss USDG (6 decimals)", capital.cumulativeLoss());
    }

    function _inactive(address token, address venue) internal {
        (uint256 collateral, uint256 loan, uint256 initialPrice) = _open(token, venue);
        _shock(token, venue, initialPrice / 2);
        _assertBlocked();
        // Waiting a whole window does not repair missing pool observation writes.
        vm.warp(block.timestamp + 3601);
        secondary.setAnswer(int256(_tokenPrice(venue, token)));
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        twap.latestRoundData();
        _assertBlocked();
        uint256 due = engine.positionDebt(borrower);
        IERC20(USDG).transfer(borrower, due - loan);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(engine), due);
        engine.close(due, borrower);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(borrower), collateral);
        assertTrue(capital.capitalOperationsAllowed());
        uint256 returned = capital.redeem(capital.balanceOf(address(this)), address(this), address(this));
        assertGt(returned, 0);
        emit log_named_address("Inactive collateral", token);
        emit log_named_uint("Still oracle-blocked after seconds", 3601);
        emit log_named_uint("Borrower repaid USDG (6 decimals)", due);
        emit log_named_uint("Lender recovered USDG (6 decimals)", returned);
    }

    function _refresh(address input, address venue) internal {
        uint256 chunk = IERC20(input).balanceOf(venue) / 10000;
        assertGt(chunk, 0);
        for (uint256 i; i < 20; ++i) {
            if (input != WETH) deal(input, address(this), IERC20(input).balanceOf(address(this)) + chunk);
            _swap(input, venue, chunk);
            (,, uint16 index,,,,) = IIsolatedV3Pool(venue).slot0();
            (uint32 written,,,) = IIsolatedV3Pool(venue).observations(index);
            if (written == block.timestamp) return;
        }
        assertTrue(false, "No observation write within refresh trade budget");
    }
}
