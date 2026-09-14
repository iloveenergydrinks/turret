// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/Test.sol";
import {DockyardStockEarnForkTest} from "./DockyardStockEarnFork.t.sol";
import {DockyardStockDirectLiquidator} from "src/research/DockyardStockDirectLiquidator.sol";

interface DirectStockPrice {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// @notice Real token/pool/factory bytecode and liquidity. Loan balances and
/// stock/USDG oracles are simulated; this does not qualify live price providers.
contract DockyardStockDirectExitForkTest is DockyardStockEarnForkTest {
    address keeper = makeAddr("stock direct fork keeper");
    uint256 posted;

    function testNineStockLiquidationsSellThroughRealDirectPoolsAndReplenishKeeper() public {
        string memory markets = vm.readFile("./utils/assets/dockyard-pilot-heartbeat-config.json");
        string memory routes = vm.readFile("./utils/assets/oracle-fixtures/stock-pool-discovery.json");
        address factory = vm.parseJsonAddress(routes, ".factory");
        uint256 succeeded;
        for (uint256 i; i < 10; ++i) {
            string memory path = string.concat(".markets[", vm.toString(i), "]");
            string memory symbol = vm.parseJsonString(markets, string.concat(path, ".symbol"));
            uint256 count = vm.parseJsonUint(routes, string.concat(path, ".poolCount"));
            if (keccak256(bytes(symbol)) == keccak256("ORCL")) {
                // The recorded discovery has no ORCL venue; never count it as a
                // tested successful route or substitute a mock pool.
                assertEq(count, 0);
                console2.log("ORCL: no recorded direct venue; not admitted");
                continue;
            }
            uint256 outer = vm.snapshotState();
            _openGap(i, vm.parseJsonAddress(markets, string.concat(path, ".primaryOracle")));
            assertEq(address(token), vm.parseJsonAddress(routes, string.concat(path, ".collateral")));
            console2.log(symbol);
            bool passed = _findExit(routes, path, count, factory);
            assertTrue(passed, string.concat(symbol, ": no executable direct liquidation route at this block/size"));
            ++succeeded;
            assertTrue(vm.revertToState(outer));
        }
        assertEq(succeeded, 9);
        console2.log("Pinned fork block", block.number);
    }

    function _openGap(uint256 index, address source) private {
        (, int256 answer,,,) = DirectStockPrice(source).latestRoundData();
        assertGt(answer, 0);
        assertEq(DirectStockPrice(source).decimals(), 8);
        _deploy(index, true);
        // Opening price is twice the fork quote. Only the test's loan oracle
        // changes; real DEX liquidity and token transfer behavior are untouched.
        posted = 100e18 * 1e8 / uint256(answer);
        primary.setAnswer(answer * 2);
        deal(address(token), borrower, posted);
        bytes memory health = _health();
        bytes memory live = _live();
        vm.startPrank(borrower);
        token.approve(address(engine), posted);
        engine.depositAndBorrowChecked(posted, 50e6, health, live);
        vm.stopPrank();
        primary.setAnswer(answer);
        engine.setRiskPaused(true);
        deal(address(USDG), keeper, 100e6);
    }

    function _findExit(string memory routes, string memory path, uint256 count, address factory)
        private
        returns (bool)
    {
        for (uint256 j; j < count; ++j) {
            string memory venuePath = string.concat(path, ".pools[", vm.toString(j), "]");
            if (vm.parseJsonAddress(routes, string.concat(venuePath, ".base")) != address(USDG)) continue;
            uint256 snapshot = vm.snapshotState();
            bool passed = _tryExit(vm.parseJsonAddress(routes, string.concat(venuePath, ".pool")), factory);
            assertTrue(vm.revertToState(snapshot));
            if (passed) return true;
        }
        return false;
    }

    function _tryExit(address venue, address factory) private returns (bool) {
        DockyardStockDirectLiquidator executor = new DockyardStockDirectLiquidator(address(engine), venue, factory);
        assertTrue(executor.routeHealthy());
        vm.prank(keeper);
        USDG.approve(address(executor), 60e6);
        bytes memory live = _live();
        vm.prank(keeper);
        try executor.liquidateAndSellChecked{gas: 1500000}(borrower, 60e6, 1, 1e6, block.timestamp + 60, live) returns (
            uint256 paid, uint256 seized, uint256 out
        ) {
            assertEq(paid, 50e6);
            assertGt(seized, 0);
            assertGe(out, paid + 1e6);
            assertEq(USDG.balanceOf(keeper), 100e6 + out - paid);
            assertEq(USDG.allowance(address(executor), address(engine)), 0);
            assertEq(USDG.balanceOf(address(executor)), 0);
            assertEq(token.balanceOf(address(executor)), 0);
            assertEq(engine.positionDebt(borrower), 0);
            assertEq(pool.outstandingPrincipal(), 0);
            (uint256 remaining,,,,) = engine.positions(borrower);
            vm.prank(borrower);
            engine.withdrawCollateral(remaining, borrower);
            assertEq(token.balanceOf(borrower), posted - seized);
            uint256 shares = pool.balanceOf(lender);
            vm.prank(lender);
            assertEq(pool.redeemChecked(shares, lender, lender, 100e6, block.timestamp + 60, "", ""), 100e6);
            console2.log("direct pool", venue);
            console2.log("USDG returned (6 decimals)", out);
            return true;
        } catch {
            return false;
        }
    }
}
