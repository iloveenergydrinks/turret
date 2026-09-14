// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardUSDGCreditVault, IDockyardOracle} from "src/DockyardUSDGCreditVault.sol";

interface IAuditFeedProxy {
    function aggregator() external view returns (address);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Fault injection against deployed code in a LOCAL Foundry fork only.
/// No private key, broadcast, or real oracle changes are used.
contract DockyardVaultSecurityForkTest is Test {
    DockyardUSDGCreditVault internal constant VAULT =
        DockyardUSDGCreditVault(0x576c510e9A268B06448f67598B7BF1ed33388e20);
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true, "Requires the pinned Robinhood mainnet fork");
        assertEq(address(VAULT).codehash, 0x9dc5608ca459e98e7223222fe70e2a3cc0816da25b4889deab6e229d1990ddba);
    }

    function _feeds(address token) internal view returns (IAuditFeedProxy first, IAuditFeedProxy second) {
        (IDockyardOracle primary, IDockyardOracle secondary,,,,,,,,) = VAULT.markets(token);
        first = IAuditFeedProxy(address(primary));
        second = IAuditFeedProxy(address(secondary));
    }

    function testFinding_AllTenPairsUseTheSameUnderlyingAggregator() public view {
        assertEq(VAULT.collateralCount(), 10);
        for (uint256 i; i < 10; i++) {
            (IAuditFeedProxy first, IAuditFeedProxy second) = _feeds(VAULT.collateralAt(i));
            assertTrue(address(first) != address(second));
            assertEq(first.aggregator(), second.aggregator());
        }
    }

    function testFinding_OneAggregatorFailureDisablesBothFeeds() public {
        (IAuditFeedProxy first, IAuditFeedProxy second) = _feeds(AAPL);
        assertEq(first.aggregator(), second.aggregator());
        vm.mockCallRevert(first.aggregator(), abi.encodeWithSignature("latestRoundData()"), "local-audit-fault");
        (bool firstOk,) = address(first).staticcall(abi.encodeWithSignature("latestRoundData()"));
        (bool secondOk,) = address(second).staticcall(abi.encodeWithSignature("latestRoundData()"));
        assertFalse(firstOk);
        assertFalse(secondOk);
        vm.expectRevert(DockyardUSDGCreditVault.OracleUnavailable.selector);
        VAULT.price(AAPL);
    }

    function testFinding_OneAggregatorMispricePassesBothChecksAndEnablesUnderbackedBorrow() public {
        uint256 truePrice = VAULT.price(AAPL);
        (IAuditFeedProxy first, IAuditFeedProxy second) = _feeds(AAPL);
        assertEq(first.aggregator(), second.aggregator());
        uint256 deposit = 1e14; // 0.0001 AAPL.
        assertLt(deposit * truePrice / 1e18, 1e18, "Collateral normally worth less than the 1 USDG loan");
        address borrower = makeAddr("fork-audit-borrower");
        deal(AAPL, borrower, deposit);
        uint256 balanceBefore = USDG.balanceOf(borrower);
        // This is a simulated upstream misreport, NOT an attacker-accessible
        // mainnet oracle setter. Both real proxy contracts consume it.
        vm.mockCall(
            first.aggregator(),
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(uint80(10_000), int256(50_000e8), block.timestamp, block.timestamp, uint80(10_000))
        );
        assertEq(VAULT.price(AAPL), 50_000e18);
        vm.startPrank(borrower);
        IERC20(AAPL).approve(address(VAULT), deposit);
        VAULT.depositAndBorrow(AAPL, deposit, 1e6);
        vm.stopPrank();
        assertEq(USDG.balanceOf(borrower) - balanceBefore, 1e6);
        (, uint128 debt) = VAULT.positions(AAPL, borrower);
        assertEq(debt, 1_005_000);
        assertGt(uint256(debt) * 1e12, deposit * truePrice / 1e18);
    }

    function testFinding_OneDayWithoutUpdatesRejectsAllTenMarketPrices() public {
        assertEq(VAULT.oracleStaleness(), 1 days);
        vm.warp(block.timestamp + 1 days);
        for (uint256 i; i < 10; i++) {
            address token = VAULT.collateralAt(i);
            vm.expectRevert(DockyardUSDGCreditVault.OracleUnavailable.selector);
            VAULT.price(token);
        }
    }
}
