// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedMarketsForkFixture} from "./DockyardIsolatedMarketsFork.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardV3TwapFeed} from "src/research/DockyardV3TwapFeed.sol";
import {DockyardCorroboratedV3Feed, ICorroboratingFeed} from "src/research/DockyardCorroboratedV3Feed.sol";

/// @notice Actual TWAP + corroboration policy + engine + atomic DEX exit.
/// The reference is explicitly mocked, NOT an available independent source.
/// A successful case establishes conditional liveness only, not market admission.
contract DockyardCorroboratedGapForkTest is DockyardIsolatedMarketsForkFixture {
    DockyardV3TwapFeed twap;
    DockyardCorroboratedV3Feed policy;

    function _deployFeeds(address token, address venue, uint256 initialPrice)
        internal
        override
        returns (address, address)
    {
        twap = new DockyardV3TwapFeed(
            DockyardV3TwapFeed.Config(token, WETH, USDG, FACTORY, venue, USDG_POOL, 1800, 600, 200, 1e18, 1e15)
        );
        secondary = new DockyardMockOracle(18, int256(initialPrice));
        policy = new DockyardCorroboratedV3Feed(twap, ICorroboratingFeed(address(secondary)), 60, 500);
        return (address(policy), address(secondary));
    }

    function testCashcatCorroboratedGapExitsBeforeHistoryCatchesUp() public {
        _corroborated(CASHCAT, CASHCAT_POOL);
    }

    function testPonsCorroboratedGapExitsBeforeHistoryCatchesUp() public {
        _corroborated(PONS, PONS_POOL);
    }

    function testCashcatDexOnlyMoveCannotForceLiquidation() public {
        _unconfirmed(CASHCAT, CASHCAT_POOL);
    }

    function testPonsDexOnlyMoveCannotForceLiquidation() public {
        _unconfirmed(PONS, PONS_POOL);
    }

    function testCashcatReferenceOutageStillAllowsFullRepayment() public {
        _outage(CASHCAT, CASHCAT_POOL);
    }

    function testPonsReferenceOutageStillAllowsFullRepayment() public {
        _outage(PONS, PONS_POOL);
    }

    function _shock(address token, address venue, uint256 target) internal returns (uint256 price) {
        uint256 chunk = IERC20(token).balanceOf(venue) / 20;
        for (uint256 i; i < 40 && _tokenPrice(venue, token) > target; ++i) {
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + chunk);
            _swap(token, venue, chunk);
        }
        price = _tokenPrice(venue, token);
        assertLe(price, target);
    }

    function _corroborated(address token, address venue) internal {
        (, uint256 principal, uint256 initial) = _open(token, venue);
        uint256 price = _shock(token, venue, initial * 5500 / 10000);
        vm.expectRevert(DockyardV3TwapFeed.SpotDeviation.selector);
        twap.latestRoundData();
        vm.warp(block.timestamp + 5);
        secondary.setAnswer(int256(price));
        (uint256 accepted,, bool gap) = policy.quote();
        assertTrue(gap);
        assertEq(accepted, price);
        uint256 due = engine.positionDebt(borrower);
        assertFalse(capital.capitalOperationsAllowed(), "Unliquidated unsafe position blocks share exit");
        ExitResult memory result = _liquidateAndExit(token, venue);
        assertEq(result.paid, due);
        assertGe(result.paid, principal);
        assertEq(capital.cumulativeLoss(), 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(capital.outstandingPrincipal(), 0);
        assertTrue(capital.capitalOperationsAllowed());
        uint256 recovered = capital.redeem(capital.balanceOf(address(this)), address(this), address(this));
        assertGt(recovered, 0);
        emit log_named_address("Corroborated gap collateral", token);
        emit log_named_uint("Synthetic reference latency seconds", 5);
        emit log_named_uint("Post-gap price bps of initial", price * 10000 / initial);
        emit log_named_uint("Debt repaid USDG (6 decimals)", result.paid);
        emit log_named_uint("Exit proceeds USDG (6 decimals)", result.usdgOut);
        emit log_named_uint("Recognized lender loss USDG (6 decimals)", capital.cumulativeLoss());
    }

    function _unconfirmed(address token, address venue) internal {
        (uint256 collateral, uint256 principal, uint256 initial) = _open(token, venue);
        _shock(token, venue, initial * 5500 / 10000);
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        policy.quote();
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.liquidationQuote(borrower, type(uint256).max);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.liquidate(borrower, type(uint256).max, 1);
        assertEq(engine.positionDebt(borrower), principal);
        assertEq(IERC20(token).balanceOf(address(engine)), collateral);
        assertEq(capital.cumulativeLoss(), 0);
        assertFalse(capital.capitalOperationsAllowed());
    }

    function _outage(address token, address venue) internal {
        (uint256 collateral, uint256 principal, uint256 initial) = _open(token, venue);
        _shock(token, venue, initial * 5500 / 10000);
        secondary.setShouldRevert(true);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        engine.liquidationQuote(borrower, type(uint256).max);
        uint256 due = engine.positionDebt(borrower);
        IERC20(USDG).transfer(borrower, due - principal);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(engine), due);
        engine.close(due, borrower);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(borrower), collateral);
        assertTrue(capital.capitalOperationsAllowed());
        assertGt(capital.redeem(capital.balanceOf(address(this)), address(this), address(this)), 0);
    }
}
