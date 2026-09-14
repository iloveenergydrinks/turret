// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretP2PLending} from "../src/TurretP2PLending.sol";

/// @dev Optional pinned, read-only fork. No minting, dealing or edits to token storage.
///      Impersonation and time travel occur only in Foundry's local EVM.
contract RealTokenForkTest is Test {
    TurretP2PLending market;
    IERC20 cash;
    IERC20 collateral;
    address lender;
    address borrower;

    function setUp() public {
        vm.createSelectFork(vm.envString("P2P_FORK_RPC"), vm.envUint("P2P_FORK_BLOCK"));
        assertEq(block.chainid, 4663);
        cash = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
        collateral = IERC20(0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f);
        lender = vm.envAddress("P2P_FORK_FUNDED_ACCOUNT");
        borrower = vm.envAddress("P2P_FORK_COLLATERAL_ACCOUNT");
        assertGe(cash.balanceOf(lender), 25e6, "Actual funding required");
        assertGe(collateral.balanceOf(borrower), 2e18, "Actual collateral required");
        address[] memory lenders = new address[](1);
        lenders[0] = lender;
        market = new TurretP2PLending(cash, collateral, address(this), 100e6, 1000e6, lenders);
    }

    function _accept() private returns (uint256 id) {
        vm.startPrank(lender);
        assertTrue(cash.approve(address(market), 25e6));
        id = market.createOffer(borrower, 25e6, 2e18, 0, 7 days, block.timestamp + 30 minutes);
        vm.stopPrank();
        vm.startPrank(borrower);
        assertTrue(collateral.approve(address(market), 2e18));
        market.acceptOffer(id);
        vm.stopPrank();
    }

    function testRealUSDGAndSLVRepayAndWithdraw() public {
        uint256 lenderBefore = cash.balanceOf(lender);
        uint256 borrowerBefore = cash.balanceOf(borrower);
        uint256 collateralBefore = collateral.balanceOf(borrower);
        uint256 id = _accept();
        assertEq(cash.balanceOf(borrower), borrowerBefore + 25e6);
        assertEq(collateral.balanceOf(address(market)), 2e18);
        market.setNewLoansPaused(true);
        vm.startPrank(borrower);
        assertTrue(cash.approve(address(market), 25e6));
        market.repay(id);
        market.withdraw(collateral, 2e18, borrower);
        vm.stopPrank();
        vm.prank(lender);
        market.withdraw(cash, 25e6, lender);
        assertEq(cash.balanceOf(lender), lenderBefore);
        assertEq(cash.balanceOf(borrower), borrowerBefore);
        assertEq(collateral.balanceOf(borrower), collateralBefore);
        assertEq(market.committedPrincipal(), 0);
        assertEq(cash.balanceOf(address(market)), 0);
        assertEq(collateral.balanceOf(address(market)), 0);
    }

    function testRealSLVDefaultAndWithdraw() public {
        uint256 lenderBefore = collateral.balanceOf(lender);
        uint256 id = _accept();
        vm.warp(market.repaymentDeadline(id) + 1);
        market.setNewLoansPaused(true);
        market.claimDefault(id);
        vm.prank(lender);
        market.withdraw(collateral, 2e18, lender);
        assertEq(collateral.balanceOf(lender), lenderBefore + 2e18);
        assertEq(market.committedPrincipal(), 0);
        assertEq(collateral.balanceOf(address(market)), 0);
    }

    function testRealUSDGCancelAndRefund() public {
        uint256 beforeBalance = cash.balanceOf(lender);
        vm.startPrank(lender);
        assertTrue(cash.approve(address(market), 25e6));
        uint256 id = market.createOffer(borrower, 25e6, 2e18, 0, 7 days, block.timestamp + 30 minutes);
        market.cancelOffer(id);
        market.withdraw(cash, 25e6, lender);
        vm.stopPrank();
        assertEq(cash.balanceOf(lender), beforeBalance);
        assertEq(market.committedPrincipal(), 0);
    }
}
