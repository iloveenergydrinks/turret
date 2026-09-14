// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {TurretNFTLending} from "../src/TurretNFTLending.sol";

/// @dev Real USDG, deployed lending manager and real collection contracts on an isolated mainnet fork only.
/// deal() seeds test balances in fork storage; no production funds are used.
contract NFTLiveCollectionsForkTest is Test {
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);

    function testLiveCashCatsRepayment() public { lifecycle(0xe3b34C4bb0f12C82143745EEe6A6Cf4E3154b1fa, false); }
    function testLiveCashCatsDefault() public { lifecycle(0xe3b34C4bb0f12C82143745EEe6A6Cf4E3154b1fa, true); }
    function testLivePyoRepayment() public { lifecycle(0x08DC7Cb3f4CcC8Eea782e2924d151e2130F22b28, false); }
    function testLivePyoDefault() public { lifecycle(0x08DC7Cb3f4CcC8Eea782e2924d151e2130F22b28, true); }
    function testLiveHoodiesRepayment() public { lifecycle(0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45, false); }
    function testLiveHoodiesDefault() public { lifecycle(0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45, true); }
    function lifecycle(address collection, bool defaults) internal {
        lifecycleToken(collection, defaults, 1);
    }
    function lifecycleToken(address collection, bool defaults, uint256 tokenId) internal {
        IERC721 CATS = IERC721(collection);
        require(block.chainid == 4663, "Requires Robinhood mainnet fork");
        address lender = address(0xABCDEF);
        address borrower = CATS.ownerOf(tokenId);
        uint256 borrowerBefore = USDG.balanceOf(borrower);
        TurretNFTLending market = TurretNFTLending(0x79F986A54965EB4AB2eB317d9c5e33074793Dd28);
        _prepareCollection(collection, address(market));
        uint256 activeBefore = market.activePrincipal();
        uint256 creditsBefore = market.totalUSDGCredits();
        vm.startPrank(market.owner());
        market.setCollectionAllowed(address(CATS), true);
        market.setNewLoansPaused(false);
        vm.stopPrank();
        deal(address(USDG), lender, 100e6);
        vm.startPrank(lender);
        USDG.approve(address(market), 100e6);
        uint256 id = market.createOffer(TurretNFTLending.Terms(borrower, address(CATS), tokenId, 100e6, 5e6, 1 days, block.timestamp + 7 days));
        vm.stopPrank();
        _prepareVault(collection, market.getOffer(id).vault);
        assertEq(USDG.balanceOf(market.getOffer(id).vault), 100e6);
        vm.startPrank(borrower);
        CATS.approve(address(market), tokenId);
        market.acceptOffer(id);
        vm.stopPrank();
        assertEq(USDG.balanceOf(borrower), borrowerBefore + 100e6);
        assertEq(CATS.ownerOf(tokenId), market.getOffer(id).vault);
        vm.startPrank(market.owner());
        market.setNewLoansPaused(true);
        market.setCollectionAllowed(address(CATS), false);
        vm.stopPrank();
        if (defaults) {
            vm.warp(market.getOffer(id).dueAt + 1 days + 1);
            market.settleDefault(id);
            vm.prank(lender); market.withdrawNFT(id, lender);
            assertEq(CATS.ownerOf(tokenId), lender);
            assertEq(USDG.balanceOf(lender), 0);
        } else {
            deal(address(USDG), borrower, borrowerBefore + 105e6);
            vm.startPrank(borrower);
            USDG.approve(address(market), 105e6);
            market.repay(id);
            market.withdrawNFT(id, borrower);
            vm.stopPrank();
            vm.prank(lender); market.withdrawUSDG(id, 105e6, lender);
            assertEq(CATS.ownerOf(tokenId), borrower);
            assertEq(USDG.balanceOf(lender), 105e6);
        }
        assertEq(USDG.balanceOf(market.getOffer(id).vault), 0);
        assertEq(market.activePrincipal(), activeBefore);
        assertEq(market.totalUSDGCredits(), creditsBefore);
    }
    function _prepareCollection(address, address) internal virtual {}
    function _prepareVault(address, address) internal virtual {}
}
