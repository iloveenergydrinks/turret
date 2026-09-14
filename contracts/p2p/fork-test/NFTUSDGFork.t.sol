// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {TurretNFTLending} from "../src/TurretNFTLending.sol";

/// @dev Real USDG and Cash Cats contracts on an isolated mainnet fork only.
/// deal() seeds test balances in fork storage; no production funds are used.
contract NFTUSDGForkTest is Test {
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    IERC721 constant CATS = IERC721(0xe3b34C4bb0f12C82143745EEe6A6Cf4E3154b1fa);
    function testRealUSDGCashCatsRepayment() public { lifecycle(false); }
    function testRealUSDGCashCatsDefault() public { lifecycle(true); }
    function lifecycle(bool defaults) internal {
        require(block.chainid == 4663, "Requires Robinhood mainnet fork");
        address lender = address(0xABCDEF);
        address borrower = CATS.ownerOf(1);
        uint256 borrowerBefore = USDG.balanceOf(borrower);
        TurretNFTLending market = new TurretNFTLending(USDG, address(this));
        market.setCollectionAllowed(address(CATS), true);
        market.setNewLoansPaused(false);
        deal(address(USDG), lender, 100e6);
        vm.startPrank(lender);
        USDG.approve(address(market), 100e6);
        uint256 id = market.createOffer(TurretNFTLending.Terms(borrower, address(CATS), 1, 100e6, 5e6, 1 days, block.timestamp + 7 days));
        vm.stopPrank();
        assertEq(USDG.balanceOf(market.getOffer(id).vault), 100e6);
        vm.startPrank(borrower);
        CATS.approve(address(market), 1);
        market.acceptOffer(id);
        vm.stopPrank();
        assertEq(USDG.balanceOf(borrower), borrowerBefore + 100e6);
        assertEq(CATS.ownerOf(1), market.getOffer(id).vault);
        market.setNewLoansPaused(true);
        market.setCollectionAllowed(address(CATS), false);
        if (defaults) {
            vm.warp(market.getOffer(id).dueAt + 1 days + 1);
            market.settleDefault(id);
            vm.prank(lender); market.withdrawNFT(id, lender);
            assertEq(CATS.ownerOf(1), lender);
            assertEq(USDG.balanceOf(lender), 0);
        } else {
            deal(address(USDG), borrower, borrowerBefore + 105e6);
            vm.startPrank(borrower);
            USDG.approve(address(market), 105e6);
            market.repay(id);
            market.withdrawNFT(id, borrower);
            vm.stopPrank();
            vm.prank(lender); market.withdrawUSDG(id, 105e6, lender);
            assertEq(CATS.ownerOf(1), borrower);
            assertEq(USDG.balanceOf(lender), 105e6);
        }
        assertEq(USDG.balanceOf(market.getOffer(id).vault), 0);
        assertEq(market.activePrincipal(), 0);
        assertEq(market.totalUSDGCredits(), 0);
    }
}
