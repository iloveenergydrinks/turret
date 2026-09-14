// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardIsolatedMarketsForkFixture, IForkWrappedEther} from "./DockyardIsolatedMarketsFork.t.sol";
import {DockyardAtomicLiquidator} from "src/research/DockyardAtomicLiquidator.sol";

/// @notice Read-only economic stress experiment with real tokens/pools and mock
/// current spot oracles. Passing tests classify blocked exits as blocked, not safe.
/// Synthetic local WETH funds larger acquisitions; no user assets or broadcast.
abstract contract DockyardLiquidationSizingFixture is DockyardIsolatedMarketsForkFixture {
    struct Attempt {
        bool executable;
        uint256 paid;
        uint256 seized;
        uint256 out;
    }

    function _poolDebtLimit() internal pure override returns (uint256) {
        return 1000000e6;
    }

    function _fund() internal {
        vm.deal(address(this), address(this).balance + 1000 ether);
        IForkWrappedEther(WETH).deposit{value: 1000 ether}();
    }

    function _refreshReference(address token, address venue) internal returns (uint256 value) {
        value = _tokenPrice(venue, token);
        primary.setAnswer(int256(value));
        secondary.setAnswer(int256(value));
    }

    function _shock(address token, address venue, uint256 target) internal returns (uint256 value) {
        uint256 chunk = IERC20(token).balanceOf(venue) / 20;
        for (uint256 i; i < 60 && _tokenPrice(venue, token) > target; ++i) {
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + chunk);
            _swap(token, venue, chunk);
        }
        value = _refreshReference(token, venue);
        assertLe(value, target, "Shock target not reached");
    }

    function _attempt(address token, address venue, uint256 maxRepay) internal returns (Attempt memory a) {
        return _attemptWithFloor(token, venue, maxRepay, 1);
    }

    function _attemptWithFloor(address token, address venue, uint256 maxRepay, uint256 minProfit)
        internal
        returns (Attempt memory a)
    {
        DockyardAtomicLiquidator exit = new DockyardAtomicLiquidator(address(engine), WETH, venue, USDG_POOL, FACTORY);
        (uint256 quoted, uint256 collateral) = engine.liquidationQuote(borrower, maxRepay);
        IERC20(USDG).approve(address(exit), quoted);
        uint256 debt = engine.positionDebt(borrower);
        uint256 loss = capital.cumulativeLoss();
        uint256 cash = IERC20(USDG).balanceOf(address(this));
        uint256 held = IERC20(token).balanceOf(address(engine));
        try exit.liquidateAndSell(borrower, quoted, collateral, minProfit, block.timestamp + 60) returns (
            uint256 paid, uint256 seized, uint256 out
        ) {
            assertEq(paid, quoted);
            assertEq(seized, collateral);
            assertGt(out, paid);
            assertEq(IERC20(USDG).balanceOf(address(this)), cash + out - paid);
            assertEq(IERC20(token).balanceOf(address(exit)), 0);
            assertEq(IERC20(WETH).balanceOf(address(exit)), 0);
            assertEq(IERC20(USDG).balanceOf(address(exit)), 0);
            a = Attempt(true, paid, seized, out);
        } catch (bytes memory reason) {
            assertEq(
                bytes4(reason),
                DockyardAtomicLiquidator.InsufficientReturn.selector,
                "Unexpected failure, not price impact"
            );
            assertEq(engine.positionDebt(borrower), debt);
            assertEq(capital.cumulativeLoss(), loss);
            assertEq(IERC20(USDG).balanceOf(address(this)), cash);
            assertEq(IERC20(token).balanceOf(address(engine)), held);
        }
        IERC20(USDG).approve(address(exit), 0);
    }

    function _curve(address token, address venue, uint256 crashBps) internal {
        uint256[4] memory sizes = [uint256(0.1 ether), 1 ether, 10 ether, 100 ether];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            _fund();
            (, uint256 loan, uint256 initial) = _openSized(token, venue, 250 ether, sizes[i]);
            uint256 price = _shock(token, venue, initial * crashBps / 10000);
            Attempt memory full = _attempt(token, venue, type(uint256).max);
            Attempt memory smaller;
            if (!full.executable) {
                assertEq(engine.positionDebt(borrower), loan);
                smaller = _attempt(token, venue, loan / 4);
                if (smaller.executable) assertGt(engine.positionDebt(borrower), 0, "Partial is not a closed position");
            } else {
                assertEq(engine.positionDebt(borrower), 0);
            }
            if (i == 0) assertTrue(full.executable, "Small baseline must execute");
            emit log_named_address("Sizing token", token);
            emit log_named_uint("Collateral acquisition WETH", sizes[i]);
            emit log_named_uint("Post-gap price bps", price * 10000 / initial);
            emit log_named_uint("Principal USDG (6 decimals)", loan);
            emit log_named_uint("Full exit executable", full.executable ? 1 : 0);
            emit log_named_uint("Quarter-debt fallback executable", smaller.executable ? 1 : 0);
            emit log_named_uint("Paid USDG (6 decimals)", full.executable ? full.paid : smaller.paid);
            emit log_named_uint(
                "Gross margin USDG before gas (6 decimals)",
                full.executable ? full.out - full.paid : smaller.out - smaller.paid
            );
            emit log_named_uint("Recognized loss USDG (6 decimals)", capital.cumulativeLoss());
            emit log_named_uint("Remaining debt USDG (6 decimals)", engine.positionDebt(borrower));
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function _multiple(address token, address venue) internal {
        _fund();
        _openSized(token, venue, 250 ether, 5 ether);
        address[8] memory borrowers;
        borrowers[0] = borrower;
        for (uint256 i = 1; i < borrowers.length; ++i) {
            address owner = address(uint160(0xdead0000 + i));
            borrowers[i] = owner;
            uint256 collateral = _swap(WETH, venue, 5 ether);
            uint256 price = _refreshReference(token, venue);
            uint256 loan = collateral * price / 1e18 * 4000 / 10000 / 1e12;
            IERC20(token).transfer(owner, collateral);
            vm.startPrank(owner);
            IERC20(token).approve(address(engine), collateral);
            engine.depositAndBorrow(collateral, loan);
            vm.stopPrank();
        }
        uint256 beforeDebt = capital.outstandingPrincipal();
        _shock(token, venue, _tokenPrice(venue, token) * 5500 / 10000);
        uint256 fullCount;
        uint256 partialCount;
        for (uint256 i; i < borrowers.length; ++i) {
            borrower = borrowers[i];
            _refreshReference(token, venue);
            Attempt memory full = _attempt(token, venue, type(uint256).max);
            if (full.executable) ++fullCount;
            else if (_attempt(token, venue, engine.positionDebt(borrower) / 4).executable) ++partialCount;
        }
        uint256 reconciled;
        for (uint256 i; i < borrowers.length; ++i) {
            (, uint256 principal,,,) = engine.positions(borrowers[i]);
            reconciled += principal;
        }
        assertEq(capital.outstandingPrincipal(), reconciled);
        assertLt(reconciled, beforeDebt, "No liquidation made progress");
        emit log_named_address("Multi-borrower token", token);
        emit log_named_uint("Initial aggregate principal USDG (6 decimals)", beforeDebt);
        emit log_named_uint("Fully closed positions", fullCount);
        emit log_named_uint("Partially liquidated positions", partialCount);
        emit log_named_uint("Remaining principal USDG (6 decimals)", reconciled);
        emit log_named_uint("Recognized loss USDG (6 decimals)", capital.cumulativeLoss());
    }
}

contract DockyardLiquidationSizingForkTest is DockyardLiquidationSizingFixture {
    function testCashcatHalfPriceSizeCurve() public {
        _curve(CASHCAT, CASHCAT_POOL, 5500);
    }

    function testPonsHalfPriceSizeCurve() public {
        _curve(PONS, PONS_POOL, 5500);
    }

    function testCashcatQuarterPriceSizeCurve() public {
        _curve(CASHCAT, CASHCAT_POOL, 2500);
    }

    function testPonsQuarterPriceSizeCurve() public {
        _curve(PONS, PONS_POOL, 2500);
    }

    function testCashcatEightBorrowersShareAnExitRoute() public {
        _multiple(CASHCAT, CASHCAT_POOL);
    }

    function testPonsEightBorrowersShareAnExitRoute() public {
        _multiple(PONS, PONS_POOL);
    }
}
