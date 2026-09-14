// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardUSDGCreditVault} from "src/DockyardUSDGCreditVault.sol";

/// @notice Owner-funding rehearsal against actual deployed bytecode and balances.
/// @dev Fork only. No keys, broadcasts, balance overrides, or mocked token calls.
contract DockyardOwnerFundingForkTest is Test {
    DockyardUSDGCreditVault internal constant VAULT =
        DockyardUSDGCreditVault(0x576c510e9A268B06448f67598B7BF1ed33388e20);
    IERC20 internal constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address internal constant OWNER = 0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086;
    uint256 internal constant AMOUNT = 10_000_000; // 10 USDG, six decimals.

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true, "Requires a Robinhood mainnet fork");
        assertEq(VAULT.owner(), OWNER, "Owner changed: review the funding recipient");
        assertEq(address(VAULT.usdg()), address(USDG));
        assertGe(USDG.balanceOf(OWNER), AMOUNT, "Owner needs 10 USDG for this rehearsal");
    }

    function testOwnerCanFundAndRecoverTenUsdg() public {
        _roundTrip(false);
    }

    function testOwnerCanRecoverIdleFundingWhileBorrowingPaused() public {
        _roundTrip(true);
    }

    function testCannotWithdrawMoreThanIdleLiquidity() public {
        uint256 ownerBefore = USDG.balanceOf(OWNER);
        uint256 idleBefore = VAULT.availableLiquidity();
        vm.startPrank(OWNER);
        vm.expectRevert(DockyardUSDGCreditVault.InsufficientLiquidity.selector);
        VAULT.withdrawLiquidity(OWNER, idleBefore + 1);
        vm.stopPrank();
        assertEq(USDG.balanceOf(OWNER), ownerBefore);
        assertEq(VAULT.availableLiquidity(), idleBefore);
    }

    function testOtherAccountsCannotWithdrawOwnerFunding() public {
        address outsider = address(0x123456);
        uint256 idleBefore = VAULT.availableLiquidity();
        vm.prank(outsider);
        vm.expectRevert();
        VAULT.withdrawLiquidity(outsider, AMOUNT);
        assertEq(VAULT.availableLiquidity(), idleBefore);
        assertEq(USDG.balanceOf(outsider), 0);
    }

    function _roundTrip(bool pauseBeforeWithdrawal) internal {
        uint256 ownerBefore = USDG.balanceOf(OWNER);
        uint256 idleBefore = VAULT.availableLiquidity();
        uint256 debtBefore = VAULT.totalDebt();
        vm.startPrank(OWNER);
        assertTrue(USDG.approve(address(VAULT), AMOUNT));
        VAULT.fund(AMOUNT);
        assertEq(USDG.balanceOf(OWNER), ownerBefore - AMOUNT);
        assertEq(VAULT.availableLiquidity(), idleBefore + AMOUNT);
        assertEq(USDG.allowance(OWNER, address(VAULT)), 0, "Exact approval must be consumed");
        if (pauseBeforeWithdrawal && !VAULT.paused()) VAULT.pause();
        VAULT.withdrawLiquidity(OWNER, AMOUNT);
        vm.stopPrank();
        assertEq(USDG.balanceOf(OWNER), ownerBefore, "All 10 USDG returned to owner");
        assertEq(VAULT.availableLiquidity(), idleBefore, "No USDG stranded in vault");
        assertEq(VAULT.totalDebt(), debtBefore, "Funding must not create borrower debt");
    }
}
