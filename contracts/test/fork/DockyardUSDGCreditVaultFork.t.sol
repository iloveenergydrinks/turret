// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardUSDGCreditVault} from "src/DockyardUSDGCreditVault.sol";

/// @notice Integration tests against deployed Robinhood Chain bytecode.
/// @dev Run with --fork-url and a pinned --fork-block-number. The actual-balance
/// canary uses unchanged onchain balances; other tests credit collateral locally
/// with deal(). Emergency tests
/// advance time; the liquidation test replaces external feed answers with a price
/// shock. No key is used or transaction broadcast. Token acquisition and UI signing
/// are not covered by this suite.
contract DockyardUSDGCreditVaultForkTest is Test {
    DockyardUSDGCreditVault internal constant VAULT =
        DockyardUSDGCreditVault(0x576c510e9A268B06448f67598B7BF1ed33388e20);
    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address internal constant ACCOUNT = 0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086;
    address internal constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;
    uint256 internal constant COLLATERAL = 0.1 ether;
    uint256 internal constant LOAN = 1_000_000; // 1 USDG
    uint256 internal constant FULL_DEBT = 1_005_000; // 1 USDG plus the 0.5% fee

    struct Balances {
        uint256 walletUsdg;
        uint256 vaultUsdg;
        uint256 vaultCollateral;
        uint256 globalDebt;
        uint256 marketDebt;
    }

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true, "Requires a Robinhood mainnet fork");
        assertGt(address(VAULT).code.length, 0, "Deployed vault missing at fork block");
        assertFalse(VAULT.paused(), "Canary requires borrowing to be live");
        assertEq(VAULT.originationFeeBps(), 50, "Review canary expectations if fee changes");
    }

    /// @notice Rehearses the requested canary using the account's purchased AAPL.
    /// @dev No deal(), oracle mocks, time changes, keys, or broadcast. Run against
    /// block 52499867 to reproduce the post-purchase wallet state.
    function testActualWalletCanBorrowRepayAndRecoverPurchasedAapl() public {
        IERC20 token = IERC20(AAPL);
        uint256 collateralAmount = 0.005 ether;
        uint256 borrowed = 500_000; // 0.5 USDG
        uint256 repayment = 502_500; // Principal plus 0.0025 USDG fee
        uint256 walletCollateralBefore = token.balanceOf(ACCOUNT);
        Balances memory before_ = Balances({
            walletUsdg: USDG.balanceOf(ACCOUNT),
            vaultUsdg: VAULT.availableLiquidity(),
            vaultCollateral: token.balanceOf(address(VAULT)),
            globalDebt: VAULT.totalDebt(),
            marketDebt: VAULT.marketDebt(AAPL)
        });
        (uint128 previousCollateral, uint128 previousDebt) = VAULT.positions(AAPL, ACCOUNT);
        assertEq(previousCollateral, 0, "Canary requires no existing AAPL position");
        assertEq(previousDebt, 0, "Canary requires no existing AAPL debt");
        assertGe(walletCollateralBefore, collateralAmount, "Purchase AAPL before this canary");
        assertGe(before_.walletUsdg, 2_500, "Retain enough USDG to pay the fee");

        vm.startPrank(ACCOUNT);
        assertTrue(token.approve(address(VAULT), collateralAmount));
        VAULT.depositAndBorrow(AAPL, collateralAmount, borrowed);
        (uint128 deposited, uint128 debt) = VAULT.positions(AAPL, ACCOUNT);
        assertEq(deposited, collateralAmount);
        assertEq(debt, repayment);
        assertEq(token.balanceOf(ACCOUNT), walletCollateralBefore - collateralAmount);
        assertEq(USDG.balanceOf(ACCOUNT), before_.walletUsdg + borrowed);
        assertEq(VAULT.availableLiquidity(), before_.vaultUsdg - borrowed);

        assertTrue(USDG.approve(address(VAULT), repayment));
        (uint256 repaid, uint256 reclaimed) = VAULT.repayAllAndWithdrawCollateral(AAPL, ACCOUNT);
        vm.stopPrank();

        assertEq(repaid, repayment);
        assertEq(reclaimed, collateralAmount);
        (deposited, debt) = VAULT.positions(AAPL, ACCOUNT);
        assertEq(deposited, 0);
        assertEq(debt, 0);
        assertEq(token.balanceOf(ACCOUNT), walletCollateralBefore, "Every purchased AAPL token remains recoverable");
        assertEq(token.balanceOf(address(VAULT)), before_.vaultCollateral, "No stranded collateral");
        assertEq(USDG.balanceOf(ACCOUNT), before_.walletUsdg - 2_500, "Only the fee was spent");
        assertEq(VAULT.availableLiquidity(), before_.vaultUsdg + 2_500);
        assertEq(VAULT.totalDebt(), before_.globalDebt);
        assertEq(VAULT.marketDebt(AAPL), before_.marketDebt);
        assertEq(token.allowance(ACCOUNT, address(VAULT)), 0);
        assertEq(USDG.allowance(ACCOUNT, address(VAULT)), 0);
        emit log_named_uint("Actual-wallet AAPL restored (18 decimals)", token.balanceOf(ACCOUNT));
        emit log_named_uint("Actual-wallet USDG after fee (6 decimals)", USDG.balanceOf(ACCOUNT));
    }

    function testAllTenDeployedMarketsBorrowAndRepayReturnAllCollateral() public {
        assertEq(VAULT.collateralCount(), 10);
        for (uint256 i; i < 10; ++i) {
            address collateral = VAULT.collateralAt(i);
            _roundTrip(collateral, false);
            emit log_named_address("Borrow/repay market passed", collateral);
        }
    }

    function testAllTenMarketsCanExitWhilePausedDisabledAndPricesStale() public {
        for (uint256 i; i < 10; ++i) {
            uint256 snapshot = vm.snapshotState();
            address collateral = VAULT.collateralAt(i);
            _roundTrip(collateral, true);
            assertTrue(vm.revertToStateAndDelete(snapshot));
            emit log_named_address("Emergency exit market passed", collateral);
        }
    }

    function testAllTenUnfundedLoansLeaveCollateralInWallet() public {
        uint256 liquidity = VAULT.availableLiquidity();
        vm.prank(VAULT.owner());
        VAULT.withdrawLiquidity(ACCOUNT, liquidity);
        assertEq(VAULT.availableLiquidity(), 0);
        uint256 globalDebtBefore = VAULT.totalDebt();
        for (uint256 i; i < 10; ++i) {
            address collateral = VAULT.collateralAt(i);
            IERC20 token = IERC20(collateral);
            uint256 vaultCollateralBefore = token.balanceOf(address(VAULT));
            uint256 walletUsdgBefore = USDG.balanceOf(ACCOUNT);
            deal(collateral, ACCOUNT, COLLATERAL);
            vm.startPrank(ACCOUNT);
            assertTrue(token.approve(address(VAULT), COLLATERAL));
            vm.expectRevert(DockyardUSDGCreditVault.InsufficientLiquidity.selector);
            VAULT.depositAndBorrow(collateral, COLLATERAL, LOAN);
            vm.stopPrank();
            (uint128 deposited, uint128 debt) = VAULT.positions(collateral, ACCOUNT);
            assertEq(deposited, 0);
            assertEq(debt, 0);
            assertEq(token.balanceOf(ACCOUNT), COLLATERAL);
            assertEq(token.balanceOf(address(VAULT)), vaultCollateralBefore);
            assertEq(USDG.balanceOf(ACCOUNT), walletUsdgBefore);
        }
        assertEq(VAULT.totalDebt(), globalDebtBefore);
    }

    function testDeployedLiquidationAndRemainingCollateralExitAfterSyntheticPriceDrop() public {
        IERC20 token = IERC20(AAPL);
        address liquidator = makeAddr("fork-liquidator");
        uint256 liquidityBefore = VAULT.availableLiquidity();
        uint256 globalDebtBefore = VAULT.totalDebt();
        deal(AAPL, ACCOUNT, 0.01 ether);
        vm.startPrank(ACCOUNT);
        assertTrue(token.approve(address(VAULT), 0.01 ether));
        VAULT.depositAndBorrow(AAPL, 0.01 ether, LOAN);
        assertTrue(USDG.transfer(liquidator, FULL_DEBT));
        vm.stopPrank();

        vm.startPrank(liquidator);
        assertTrue(USDG.approve(address(VAULT), FULL_DEBT));
        vm.expectRevert(DockyardUSDGCreditVault.PositionIsHealthy.selector);
        VAULT.liquidate(AAPL, ACCOUNT, FULL_DEBT, liquidator);
        vm.stopPrank();

        // External dependency fault injection, on the fork only: both feeds
        // report $150/AAPL. The vault, tokens and transfer logic are untouched.
        _mockPriceDropTo150Dollars();
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = VAULT.liquidate(AAPL, ACCOUNT, FULL_DEBT, liquidator);
        assertEq(repaid, FULL_DEBT);
        assertEq(seized, 0.007035 ether, "1.005 USDG plus 5% bonus at $150/AAPL");
        assertEq(token.balanceOf(liquidator), 0.007035 ether);
        assertEq(USDG.balanceOf(liquidator), 0);
        assertEq(USDG.allowance(liquidator, address(VAULT)), 0);
        assertEq(VAULT.availableLiquidity(), liquidityBefore + 5_000);
        assertEq(VAULT.totalDebt(), globalDebtBefore);

        vm.prank(ACCOUNT);
        (uint256 additionalRepayment, uint256 reclaimed) = VAULT.repayAllAndWithdrawCollateral(AAPL, ACCOUNT);
        assertEq(additionalRepayment, 0);
        assertEq(reclaimed, 0.002965 ether, "Borrower recovers the remaining collateral");
        assertEq(token.balanceOf(ACCOUNT), 0.002965 ether);
        (uint128 collateral, uint128 debt) = VAULT.positions(AAPL, ACCOUNT);
        assertEq(collateral, 0);
        assertEq(debt, 0);
    }

    function _mockPriceDropTo150Dollars() internal {
        (bool success, bytes memory result) = address(VAULT).staticcall(abi.encodeCall(VAULT.markets, (AAPL)));
        assertTrue(success);
        DockyardUSDGCreditVault.Market memory market = abi.decode(result, (DockyardUSDGCreditVault.Market));
        vm.mockCall(
            address(market.primaryOracle),
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(
                uint80(1), int256(150 * 10 ** market.primaryOracleDecimals), block.timestamp, block.timestamp, uint80(1)
            )
        );
        vm.mockCall(
            address(market.secondaryOracle),
            abi.encodeWithSignature("latestRoundData()"),
            abi.encode(
                uint80(1),
                int256(150 * 10 ** market.secondaryOracleDecimals),
                block.timestamp,
                block.timestamp,
                uint80(1)
            )
        );
    }

    function _roundTrip(address collateral, bool emergencyExit) internal {
        IERC20 token = IERC20(collateral);
        (uint128 previousCollateral, uint128 previousDebt) = VAULT.positions(collateral, ACCOUNT);
        assertEq(previousCollateral, 0, "Use a clean position for the canary");
        assertEq(previousDebt, 0, "Use a clean position for the canary");
        Balances memory before_ = Balances({
            walletUsdg: USDG.balanceOf(ACCOUNT),
            vaultUsdg: USDG.balanceOf(address(VAULT)),
            vaultCollateral: token.balanceOf(address(VAULT)),
            globalDebt: VAULT.totalDebt(),
            marketDebt: VAULT.marketDebt(collateral)
        });

        // Local test fixture only: exercise every market independently of holdings.
        deal(collateral, ACCOUNT, COLLATERAL);
        vm.startPrank(ACCOUNT);
        assertTrue(token.approve(address(VAULT), COLLATERAL));
        VAULT.depositAndBorrow(collateral, COLLATERAL, LOAN);

        (uint128 deposited, uint128 debt) = VAULT.positions(collateral, ACCOUNT);
        assertEq(deposited, COLLATERAL);
        assertEq(debt, FULL_DEBT);
        assertEq(USDG.balanceOf(ACCOUNT), before_.walletUsdg + LOAN);
        assertEq(USDG.balanceOf(address(VAULT)), before_.vaultUsdg - LOAN);
        assertEq(token.balanceOf(ACCOUNT), 0);
        assertEq(token.balanceOf(address(VAULT)), before_.vaultCollateral + COLLATERAL);

        if (emergencyExit) {
            vm.stopPrank();
            vm.startPrank(VAULT.owner());
            VAULT.pause();
            VAULT.setMarketEnabled(collateral, false);
            vm.stopPrank();
            vm.warp(block.timestamp + 2 days);
            vm.expectRevert();
            VAULT.price(collateral);
            vm.startPrank(ACCOUNT);
        }

        assertTrue(USDG.approve(address(VAULT), FULL_DEBT));
        (uint256 repaid, uint256 reclaimed) = VAULT.repayAllAndWithdrawCollateral(collateral, ACCOUNT);
        vm.stopPrank();

        assertEq(repaid, FULL_DEBT);
        assertEq(reclaimed, COLLATERAL);
        (deposited, debt) = VAULT.positions(collateral, ACCOUNT);
        assertEq(deposited, 0);
        assertEq(debt, 0);
        assertEq(token.balanceOf(ACCOUNT), COLLATERAL, "All collateral returned");
        assertEq(token.balanceOf(address(VAULT)), before_.vaultCollateral, "No stranded collateral");
        assertEq(USDG.balanceOf(ACCOUNT), before_.walletUsdg - 5_000, "Only the fee was spent");
        assertEq(USDG.balanceOf(address(VAULT)), before_.vaultUsdg + 5_000, "Principal and fee returned");
        assertEq(VAULT.totalDebt(), before_.globalDebt);
        assertEq(VAULT.marketDebt(collateral), before_.marketDebt);
        assertEq(USDG.allowance(ACCOUNT, address(VAULT)), 0);
        assertEq(token.allowance(ACCOUNT, address(VAULT)), 0);
    }
}
