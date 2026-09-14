// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {P2PToken} from "../test/P2PTestSupport.sol";
import {TurretNFTLending} from "../src/TurretNFTLending.sol";

/// @dev Read-only mainnet fork: real collection storage and real token #1 ownership.
/// Only the loan currency is synthetic. Impersonation and every mutation stay in Foundry's fork.
contract NFTCollectionsForkTest is Test {
    address constant CATS = 0xe3b34C4bb0f12C82143745EEe6A6Cf4E3154b1fa;
    address constant PYO = 0x08DC7Cb3f4CcC8Eea782e2924d151e2130F22b28;
    address constant HOODIES = 0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45;
    function testCashCatsRepayment() public { lifecycle(CATS, false); }
    function testCashCatsDefault() public { lifecycle(CATS, true); }
    function testPyoRepayment() public { lifecycle(PYO, false); }
    function testPyoDefault() public { lifecycle(PYO, true); }
    function testHoodiesRepayment() public { lifecycle(HOODIES, false); }
    function testHoodiesDefault() public { lifecycle(HOODIES, true); }
    function lifecycle(address collection, bool defaults) internal {
        require(block.chainid == 4663, "Requires a Robinhood mainnet fork");
        IERC721 nft = IERC721(collection);
        address borrower = nft.ownerOf(1);
        address lender = address(0xABCDEF);
        P2PToken usd = new P2PToken("Local fork currency", 6);
        TurretNFTLending market = new TurretNFTLending(usd, address(this));
        market.setCollectionAllowed(collection, true);
        market.setNewLoansPaused(false);
        usd.mint(lender, 100e6);
        vm.startPrank(lender);
        usd.approve(address(market), 100e6);
        uint256 id = market.createOffer(TurretNFTLending.Terms(borrower, collection, 1, 100e6, 5e6, 30 days, block.timestamp + 7 days));
        vm.stopPrank();
        vm.startPrank(borrower);
        nft.approve(address(market), 1);
        market.acceptOffer(id);
        vm.stopPrank();
        assertEq(nft.ownerOf(1), market.getOffer(id).vault);
        assertEq(usd.balanceOf(borrower), 100e6);
        market.setCollectionAllowed(collection, false);
        market.setNewLoansPaused(true);
        if (defaults) {
            vm.warp(market.getOffer(id).dueAt + 1 days + 1);
            market.settleDefault(id);
            vm.prank(lender); market.withdrawNFT(id, lender);
            assertEq(nft.ownerOf(1), lender);
        } else {
            usd.mint(borrower, 5e6);
            vm.startPrank(borrower);
            usd.approve(address(market), 105e6);
            market.repay(id);
            market.withdrawNFT(id, borrower);
            vm.stopPrank();
            vm.prank(lender); market.withdrawUSDG(id, 105e6, lender);
            assertEq(nft.ownerOf(1), borrower);
            assertEq(usd.balanceOf(lender), 105e6);
        }
    }
}
