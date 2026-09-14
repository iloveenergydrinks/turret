// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";
import {P2PToken} from "./P2PTestSupport.sol";
import {TurretNFTLending} from "../src/TurretNFTLending.sol";
import {TurretNFTVault} from "../src/TurretNFTVault.sol";

contract TestNFT is ERC721 {
    bool public frozen;
    bool public skip;
    address public callback;
    bytes public data;
    bool public reentered;
    uint256 public callbackCount;
    constructor() ERC721("Test collection", "NFT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
    function setFrozen(bool value) external { frozen = value; }
    function setSkip(bool value) external { skip = value; }
    function setCallback(address target, bytes calldata callData) external { callback = target; data = callData; }
    function _transfer(address from, address to, uint256 id) internal override {
        require(!frozen, "frozen");
        if (!skip) super._transfer(from, to, id);
        if (callback != address(0)) {
            callbackCount++;
            (reentered,) = callback.call(data);
        }
    }
}

contract RejectNFT is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("rejected");
    }
}

contract TurretNFTLendingTest is Test {
    P2PToken usd;
    TestNFT nft;
    TurretNFTLending market;
    address lender = address(0xA11CE);
    address borrower = address(0xB0B);
    address payer = address(0xCA11);
    uint256 constant P = 100e6;
    uint256 constant I = 5e6;

    function setUp() public {
        vm.warp(1_788_900_000);
        usd = new P2PToken("USDG", 6);
        nft = new TestNFT();
        market = new TurretNFTLending(usd, address(this));
        market.setCollectionAllowed(address(nft), true);
        market.setNewLoansPaused(false);
        usd.mint(lender, 1_000_000e6);
        usd.mint(payer, 1_000_000e6);
        vm.prank(lender); usd.approve(address(market), type(uint256).max);
        vm.prank(payer); usd.approve(address(market), type(uint256).max);
        nft.mint(borrower, 0);
        nft.mint(borrower, 1);
        vm.prank(borrower); nft.setApprovalForAll(address(market), true);
    }
    function terms(uint256 tokenId) internal view returns (TurretNFTLending.Terms memory) {
        return TurretNFTLending.Terms(borrower, address(nft), tokenId, P, I, 30 days, block.timestamp + 7 days);
    }
    function create(uint256 tokenId) internal returns (uint256 id) {
        TurretNFTLending.Terms memory t = terms(tokenId);
        vm.prank(lender); id = market.createOffer(t);
    }
    function active(uint256 tokenId) internal returns (uint256 id) {
        id = create(tokenId);
        vm.prank(borrower); market.acceptOffer(id);
    }
    function testRepaymentSettlesAndSeparateClaimsReturnExactAssets() public {
        uint256 id = active(0);
        TurretNFTLending.Offer memory o = market.getOffer(id);
        assertEq(nft.ownerOf(0), o.vault);
        assertEq(usd.balanceOf(borrower), P);
        assertEq(market.activePrincipal(), P);
        vm.prank(payer); market.repay(id);
        o = market.getOffer(id);
        assertEq(uint8(o.status), uint8(TurretNFTLending.Status.Repaid));
        assertEq(o.nftBeneficiary, borrower);
        assertEq(o.usdgCredit, P + I);
        vm.prank(borrower); market.withdrawNFT(id, borrower);
        vm.prank(lender); market.withdrawUSDG(id, P + I, lender);
        assertEq(nft.ownerOf(0), borrower);
        assertEq(usd.balanceOf(lender), 1_000_000e6 + I);
        assertEq(usd.balanceOf(o.vault), 0);
        assertEq(market.activePrincipal(), 0);
        assertEq(market.totalUSDGCredits(), 0);
    }
    function testDefaultTransfersWholeNFTOnlyToLender() public {
        uint256 id = active(0);
        vm.warp(market.getOffer(id).dueAt + 1 days + 1);
        market.settleDefault(id);
        vm.expectRevert(TurretNFTLending.Unauthorized.selector);
        vm.prank(borrower); market.withdrawNFT(id, borrower);
        vm.prank(lender); market.withdrawNFT(id, lender);
        assertEq(nft.ownerOf(0), lender);
        assertEq(market.getOffer(id).usdgCredit, 0);
        vm.expectRevert(TurretNFTLending.WrongStatus.selector);
        vm.prank(payer); market.repay(id);
    }
    function testRepaymentInclusiveFinalSecondAndDefaultExclusive() public {
        uint256 id = active(0);
        vm.warp(market.getOffer(id).dueAt + 1 days);
        vm.expectRevert(TurretNFTLending.TooEarly.selector); market.settleDefault(id);
        vm.prank(payer); market.repay(id);
    }
    function testLateRepaymentRejectedEvenBeforeDefaultIsSettled() public {
        uint256 id = active(0);
        vm.warp(market.getOffer(id).dueAt + 1 days + 1);
        vm.expectRevert(TurretNFTLending.DeadlinePassed.selector);
        vm.prank(payer); market.repay(id);
    }
    function testRemovalAndPausePreserveRepaymentWithdrawalAndRefund() public {
        uint256 id = active(0);
        uint256 open = create(1);
        market.setCollectionAllowed(address(nft), false);
        market.setNewLoansPaused(true);
        vm.prank(payer); market.repay(id);
        vm.prank(borrower); market.withdrawNFT(id, borrower);
        vm.prank(lender); market.cancelOffer(open);
        vm.prank(lender); market.withdrawUSDG(open, P, lender);
        assertEq(nft.ownerOf(0), borrower);
    }
    function testRemovedCollectionCannotAcceptExistingOffer() public {
        uint256 id = create(0);
        market.setCollectionAllowed(address(nft), false);
        vm.expectRevert(TurretNFTLending.CollectionNotAllowed.selector);
        vm.prank(borrower); market.acceptOffer(id);
    }
    function testPauseAndRemovalPreserveDefault() public {
        uint256 id = active(0);
        market.setCollectionAllowed(address(nft), false);
        market.setNewLoansPaused(true);
        vm.warp(market.getOffer(id).dueAt + 1 days + 1);
        market.settleDefault(id);
        vm.prank(lender); market.withdrawNFT(id, payer);
        assertEq(nft.ownerOf(0), payer);
    }
    function testBlockedLenderDoesNotBlockRepayment() public {
        uint256 id = active(0);
        usd.setBlockedRecipient(lender);
        vm.prank(payer); market.repay(id);
        vm.expectRevert("blocked recipient"); vm.prank(lender); market.withdrawUSDG(id, P + I, lender);
        assertEq(market.getOffer(id).usdgCredit, P + I);
        vm.prank(lender); market.withdrawUSDG(id, P + I, payer);
        vm.prank(borrower); market.withdrawNFT(id, borrower);
    }
    function testFrozenNFTDoesNotBlockDebtSettlementAndCanRecoverLater() public {
        uint256 id = active(0);
        nft.setFrozen(true);
        vm.prank(payer); market.repay(id);
        vm.expectRevert("frozen"); vm.prank(borrower); market.withdrawNFT(id, borrower);
        assertEq(market.getOffer(id).nftBeneficiary, borrower);
        nft.setFrozen(false);
        vm.prank(borrower); market.withdrawNFT(id, borrower);
    }
    function testReceiverRejectionPreservesNFTClaim() public {
        uint256 id = active(0);
        vm.prank(payer); market.repay(id);
        RejectNFT rejector = new RejectNFT();
        vm.expectRevert("rejected"); vm.prank(borrower); market.withdrawNFT(id, address(rejector));
        assertEq(market.getOffer(id).nftBeneficiary, borrower);
        vm.prank(borrower); market.withdrawNFT(id, payer);
        assertEq(nft.ownerOf(0), payer);
    }
    function testPublicOfferBindsActualOwnerAndIndexesOnce() public {
        TurretNFTLending.Terms memory t = terms(0); t.borrower = address(0);
        vm.prank(lender); uint256 id = market.createOffer(t);
        vm.expectRevert(TurretNFTLending.WrongOwner.selector); vm.prank(payer); market.acceptOffer(id);
        vm.prank(borrower); market.acceptOffer(id);
        assertEq(market.getOffer(id).terms.borrower, borrower);
        (uint256[] memory ids, uint256 cursor) = market.accountOffers(borrower, 0, 50);
        assertEq(ids.length, 1); assertEq(ids[0], id); assertEq(cursor, 1);
    }
    function testAcceptanceExpiryBoundaryAndPermissionlessRefundSettlement() public {
        uint256 id = create(0);
        vm.warp(market.getOffer(id).terms.expiresAt);
        vm.expectRevert(TurretNFTLending.OfferExpired.selector); vm.prank(borrower); market.acceptOffer(id);
        vm.prank(payer); market.expireOffer(id);
        vm.expectRevert(TurretNFTLending.Unauthorized.selector); vm.prank(payer); market.withdrawUSDG(id, P, payer);
        vm.prank(lender); market.withdrawUSDG(id, P, lender);
    }
    function testStaleOwnershipDoesNotLockLenderMoney() public {
        uint256 id = create(0);
        vm.prank(borrower); nft.transferFrom(borrower, payer, 0);
        vm.expectRevert(TurretNFTLending.WrongOwner.selector); vm.prank(borrower); market.acceptOffer(id);
        vm.prank(lender); market.cancelOffer(id);
        vm.prank(lender); market.withdrawUSDG(id, P, lender);
    }
    function testCannotFundNamedOfferForNonOwner() public {
        TurretNFTLending.Terms memory t = terms(0); t.borrower = payer;
        vm.expectRevert(TurretNFTLending.WrongOwner.selector); vm.prank(lender); market.createOffer(t);
    }
    function testNoOpNFTTransferCannotReceiveUSDG() public {
        uint256 id = create(0); nft.setSkip(true);
        vm.expectRevert(TurretNFTLending.UnsupportedTransfer.selector); vm.prank(borrower); market.acceptOffer(id);
        assertEq(usd.balanceOf(borrower), 0);
        assertEq(uint8(market.getOffer(id).status), uint8(TurretNFTLending.Status.Open));
    }
    function testFeeTokenFundingAndRepaymentRevertAtomically() public {
        usd.setFee(1);
        TurretNFTLending.Terms memory t = terms(0);
        vm.expectRevert(TurretNFTLending.UnsupportedTransfer.selector); vm.prank(lender); market.createOffer(t);
        assertEq(market.nextOfferId(), 1); assertEq(market.reservedPrincipal(), 0);
        usd.setFee(0); uint256 id = active(0); usd.setFee(1);
        vm.expectRevert(TurretNFTLending.UnsupportedTransfer.selector); vm.prank(payer); market.repay(id);
        assertEq(uint8(market.getOffer(id).status), uint8(TurretNFTLending.Status.Active));
    }
    function testNFTCallbackCannotReenterAcceptance() public {
        uint256 id = create(0);
        nft.setCallback(address(market), abi.encodeCall(market.acceptOffer, (id)));
        vm.prank(borrower); market.acceptOffer(id);
        assertFalse(nft.reentered());
        assertEq(nft.callbackCount(), 1);
        assertEq(usd.balanceOf(borrower), P);
    }
    function testUSDGCallbackCannotReenterRepayment() public {
        uint256 id = active(0);
        usd.setCallback(address(market), abi.encodeCall(market.repay, (id)));
        vm.prank(payer); market.repay(id);
        assertFalse(usd.callbackSucceeded());
        assertEq(market.totalUSDGCredits(), P + I);
    }
    function testIndependentVaultsAndNoDirectVaultAccess() public {
        uint256 a = create(0); uint256 b = create(1);
        address va = market.getOffer(a).vault; address vb = market.getOffer(b).vault;
        assertTrue(va != vb);
        vm.expectRevert(TurretNFTVault.Unauthorized.selector);
        TurretNFTVault(va).transferUSDG(payer, P);
        vm.expectRevert(TurretNFTVault.Unauthorized.selector);
        TurretNFTVault(va).initialize(IERC721(address(nft)), 1);
        vm.prank(lender); market.cancelOffer(a);
        vm.prank(lender); market.withdrawUSDG(a, P, lender);
        assertEq(usd.balanceOf(vb), P);
    }
    function testGuardianCannotTakeNFTOrUSDGAndOwnershipIsTwoStep() public {
        uint256 id = active(0);
        vm.expectRevert(TurretNFTLending.Unauthorized.selector); market.withdrawNFT(id, address(this));
        vm.expectRevert(TurretNFTLending.Unauthorized.selector); market.withdrawUSDG(id, P, address(this));
        market.nominateOwner(payer);
        assertEq(market.owner(), address(this));
        vm.expectRevert(TurretNFTLending.Unauthorized.selector); vm.prank(lender); market.acceptOwnership();
        vm.prank(payer); market.acceptOwnership();
        assertEq(market.owner(), payer);
    }
    function testRejectsUnsupportedCollectionAndNonOwnerAdmin() public {
        vm.expectRevert(TurretNFTLending.InvalidConfiguration.selector); market.setCollectionAllowed(address(usd), true);
        vm.expectRevert(TurretNFTLending.Unauthorized.selector); vm.prank(payer); market.setNewLoansPaused(true);
    }
    function testBatchReadsPreserveOrderAndBoundWork() public {
        uint256 first = create(0); uint256 second = create(1);
        uint256[] memory ids = new uint256[](3); ids[0] = second; ids[1] = first; ids[2] = 999;
        TurretNFTLending.Offer[] memory rows = market.getOfferBatch(ids);
        assertEq(rows.length, 3); assertEq(rows[0].terms.tokenId, 1); assertEq(rows[1].terms.tokenId, 0);
        assertEq(uint8(rows[2].status), uint8(TurretNFTLending.Status.None));
        assertEq(market.getOfferBatch(new uint256[](0)).length, 0);
        vm.expectRevert(TurretNFTLending.InvalidPagination.selector); market.getOfferBatch(new uint256[](51));
        (uint256[] memory page, uint256 cursor) = market.accountOffers(lender, 0, 1);
        assertEq(page[0], first); assertEq(cursor, 1);
        (page, cursor) = market.accountOffers(lender, cursor, 1); assertEq(page[0], second); assertEq(cursor, 2);
        (page, cursor) = market.accountOffers(lender, cursor, 1); assertEq(page.length, 0); assertEq(cursor, 2);
        vm.expectRevert(TurretNFTLending.InvalidPagination.selector); market.accountOffers(lender, 3, 1);
    }
    function testFuzzLifecycleConservesFunds(uint96 principal, uint96 interest, uint16 days_, bool defaults) public {
        principal = uint96(bound(principal, 1, 100_000e6));
        interest = uint96(bound(interest, 0, 100_000e6));
        days_ = uint16(bound(days_, 1, 3650));
        TurretNFTLending.Terms memory t = terms(0);
        t.principal = principal; t.interest = interest; t.duration = uint256(days_) * 1 days;
        vm.prank(lender); uint256 id = market.createOffer(t);
        vm.prank(borrower); market.acceptOffer(id);
        if (defaults) {
            vm.warp(market.getOffer(id).dueAt + 1 days + 1); market.settleDefault(id);
            vm.prank(lender); market.withdrawNFT(id, lender);
            assertEq(usd.balanceOf(lender), 1_000_000e6 - principal);
            assertEq(nft.ownerOf(0), lender);
        } else {
            vm.prank(payer); market.repay(id);
            vm.prank(lender); market.withdrawUSDG(id, uint256(principal) + interest, lender);
            vm.prank(borrower); market.withdrawNFT(id, borrower);
            assertEq(usd.balanceOf(lender), 1_000_000e6 + interest);
            assertEq(nft.ownerOf(0), borrower);
        }
        assertEq(market.reservedPrincipal(), 0);
        assertEq(market.activePrincipal(), 0);
        assertEq(market.totalUSDGCredits(), 0);
        assertEq(usd.balanceOf(market.getOffer(id).vault), 0);
    }
}
