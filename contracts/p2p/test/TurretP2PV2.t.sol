// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {P2PToken} from "./P2PTestSupport.sol";
import {TurretP2PLendingV2} from "../src/TurretP2PLendingV2.sol";

contract TurretP2PV2Test is Test {
    function testAnyFundedWalletCanPublishPublicOfferAbovePilotLimits() public {
        vm.warp(1_800_000_000);
        P2PToken usd = new P2PToken("USDG", 6);
        P2PToken slv = new P2PToken("SLV", 18);
        TurretP2PLendingV2 market = new TurretP2PLendingV2(usd, slv, address(this));
        address lender = address(0xA11CE);
        address borrower = address(0xB0B);
        usd.mint(lender, 50_000e6);
        slv.mint(borrower, 2e18);
        vm.startPrank(lender);
        usd.approve(address(market), 50_000e6);
        uint256 id = market.createOffer(address(0), 50_000e6, 2e18, 8_000e6, 19 days, block.timestamp + 10 days);
        vm.stopPrank();
        assertEq(usd.balanceOf(address(market)), 50_000e6);
        vm.startPrank(borrower);
        slv.approve(address(market), 2e18);
        market.acceptOffer(id);
        vm.stopPrank();
        assertEq(usd.balanceOf(borrower), 50_000e6);
        assertEq(slv.balanceOf(address(market)), 2e18);
    }
}

import {P2PV2TestBase, IERC20} from "./P2PV2TestSupport.sol";
import {TurretP2PBatchDeployerV2} from "../src/TurretP2PBatchDeployerV2.sol";

contract TurretP2PV2FeatureTest is P2PV2TestBase {
    function testFuzzPublicOfferHasExactlyOneWinnerAndFailedSecondAcceptanceMovesNothing(bool borrowerWins) public {
        uint256 id = _create();
        address winner = borrowerWins ? borrower : thirdParty;
        address loser = borrowerWins ? thirdParty : borrower;
        assertTrue(market.isPublicOffer(id));
        assertEq(_offer(id).borrower, address(0));
        vm.prank(winner);
        market.acceptOffer(id);
        uint256 beforeUsd = usd.balanceOf(loser);
        uint256 beforeSlv = slv.balanceOf(loser);
        uint256 beforeAllowance = slv.allowance(loser, address(market));
        vm.prank(loser);
        vm.expectRevert(TurretP2PLendingV2.WrongStatus.selector);
        market.acceptOffer(id);
        assertEq(usd.balanceOf(loser), beforeUsd);
        assertEq(slv.balanceOf(loser), beforeSlv);
        assertEq(slv.allowance(loser, address(market)), beforeAllowance);
        assertEq(_offer(id).borrower, winner);
        (uint256[] memory loserIds,) = market.getAccountOfferIds(loser, 0, 50);
        assertEq(loserIds.length, 0);
        assertEq(market.lockedCollateral(), COLLATERAL);
        assertEq(market.reservedPrincipal(), 0);
        _assertSolvent();
    }

    function testLenderCannotTakeOwnPublicOffer() public {
        uint256 id = _create();
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.Unauthorized.selector);
        market.acceptOffer(id);
        assertEq(_offer(id).borrower, address(0));
        _assertStatus(id, TurretP2PLendingV2.Status.Open);
    }

    function testPrivateOfferExcludedFromMarketplaceAndOnlyNamedBorrowerCanAccept() public {
        vm.prank(lender);
        uint256 id = market.createOffer(borrower, PRINCIPAL, COLLATERAL, 0, 2 days, block.timestamp + 90 days);
        (uint256[] memory publicIds, uint256 next) = market.getPublicOfferIds(0, 50);
        assertEq(publicIds.length, 0);
        assertEq(next, 0);
        assertFalse(market.isPublicOffer(id));
        (uint256[] memory lenderIds,) = market.getAccountOfferIds(lender, 0, 50);
        (uint256[] memory borrowerIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(lenderIds.length, 1);
        assertEq(borrowerIds.length, 1);
        assertEq(borrowerIds[0], id);
        vm.prank(thirdParty);
        vm.expectRevert(TurretP2PLendingV2.Unauthorized.selector);
        market.acceptOffer(id);
        vm.prank(borrower);
        market.acceptOffer(id);
        (borrowerIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(borrowerIds.length, 1, "private borrower must not be indexed twice");
        assertFalse(market.isPublicOffer(id));
    }

    function testPublicVisibilityCreationTimeAndHistorySurviveSettlement() public {
        uint256 created = block.timestamp;
        uint256 id = _create();
        assertEq(market.offerCreatedAt(id), created);
        (uint256[] memory ids,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(ids.length, 0);
        (ids,) = market.getAccountOfferIds(address(0), 0, 50);
        assertEq(ids.length, 0);
        vm.warp(created + 10);
        vm.prank(borrower);
        market.acceptOffer(id);
        vm.prank(thirdParty);
        market.repay(id);
        assertTrue(market.isPublicOffer(id));
        assertEq(market.offerCreatedAt(id), created);
        (ids,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
        (ids,) = market.getPublicOfferIds(0, 50);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }

    function testPublicCancelFirstReturnsFundingAndPreventsAcceptance() public {
        uint256 id = _create();
        vm.prank(lender);
        market.cancelOffer(id);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.WrongStatus.selector);
        market.acceptOffer(id);
        assertEq(_offer(id).borrower, address(0));
        assertEq(market.credits(address(usd), lender), PRINCIPAL);
        assertEq(slv.balanceOf(address(market)), 0);
    }

    function testIndependentLenderCanFundDespiteLargeExistingCommitments() public {
        vm.prank(lender);
        uint256 id = market.createOffer(address(0), 2_000_000e6, 1, 0, 1 days, block.timestamp + 365 days);
        vm.prank(borrower);
        market.acceptOffer(id);
        vm.prank(thirdParty);
        market.createOffer(address(0), 3_000_000e6, 1, 9_000_000e6, 555 days, block.timestamp + 10 days);
        assertEq(market.committedPrincipal(), 5_000_000e6);
        assertEq(market.reservedPrincipal(), 3_000_000e6);
        _assertSolvent();
    }

    function testZeroInterestAndOneDayTermRemainZeroThroughGrace() public {
        vm.prank(thirdParty);
        uint256 id = market.createOffer(address(0), 25e6, 2e18, 0, 1 days, block.timestamp + 30 days);
        vm.prank(borrower);
        market.acceptOffer(id);
        assertEq(market.repaymentDeadline(id), block.timestamp + 2 days);
        vm.warp(market.repaymentDeadline(id));
        vm.prank(borrower);
        market.repay(id);
        assertEq(market.credits(address(usd), thirdParty), 25e6);
    }

    function testFuzzCustomTermsAndEarlyRepayment(uint256 p, uint256 c, uint256 fee, uint256 daysSeed, bool privateOffer) public {
        p = bound(p, 1, 2_000_000e6);
        c = bound(c, 1, 1_000_000e18);
        fee = bound(fee, 0, 5_000_000e6);
        uint256 duration = bound(daysSeed, 1, 10_000) * 1 days;
        vm.prank(thirdParty);
        uint256 id = market.createOffer(privateOffer ? borrower : address(0), p, c, fee, duration, block.timestamp + 100 days);
        vm.prank(borrower);
        market.acceptOffer(id);
        assertEq(_offer(id).dueAt, block.timestamp + duration);
        vm.prank(borrower);
        market.repay(id);
        assertEq(market.credits(address(usd), thirdParty), p + fee);
        assertEq(market.credits(address(slv), borrower), c);
        assertEq(market.isPublicOffer(id), !privateOffer);
        _assertSolvent();
    }

    function testMaximumRepresentableRepaymentHasNoHiddenUint128Cap() public {
        usd = new P2PToken("USDG", 6);
        slv = new P2PToken("SLV", 18);
        market = new TurretP2PLendingV2(usd, slv, guardian);
        uint256 p = type(uint256).max - 7;
        usd.mint(lender, p);
        usd.mint(borrower, 7);
        slv.mint(borrower, 1);
        vm.startPrank(lender);
        usd.approve(address(market), p);
        uint256 id = market.createOffer(address(0), p, 1, 7, 1 days, block.timestamp + 1 days);
        vm.stopPrank();
        vm.startPrank(borrower);
        slv.approve(address(market), 1);
        market.acceptOffer(id);
        usd.approve(address(market), type(uint256).max);
        market.repay(id);
        vm.stopPrank();
        assertEq(market.credits(address(usd), lender), type(uint256).max);
        vm.prank(lender);
        market.withdraw(usd, type(uint256).max, lender);
        assertEq(usd.balanceOf(lender), type(uint256).max);
        assertEq(market.committedPrincipal(), 0);
    }

    function testLatestRepresentableDeadlineWorksAtExactBoundary() public {
        uint256 expiry = 8_640_000_000_000 - 2 days;
        vm.prank(lender);
        uint256 id = market.createOffer(address(0), PRINCIPAL, COLLATERAL, INTEREST, 1 days, expiry);
        vm.warp(expiry - 1);
        vm.prank(borrower);
        market.acceptOffer(id);
        assertEq(market.repaymentDeadline(id), 8_640_000_000_000 - 1);
        vm.warp(8_640_000_000_000);
        market.claimDefault(id);
        assertEq(market.credits(address(slv), lender), COLLATERAL);
    }

    function testInvalidTermsRejectBeforeFunding() public {
        _invalid(address(market), 1, 1, 0, 1 days, block.timestamp + 1);
        _invalid(lender, 1, 1, 0, 1 days, block.timestamp + 1);
        _invalid(address(0), 0, 1, 0, 1 days, block.timestamp + 1);
        _invalid(address(0), 1, 0, 0, 1 days, block.timestamp + 1);
        _invalid(address(0), 1, 1, type(uint256).max, 1 days, block.timestamp + 1);
        _invalid(address(0), 1, 1, 0, 0, block.timestamp + 1);
        _invalid(address(0), 1, 1, 0, 1 days + 1, block.timestamp + 1);
        _invalid(address(0), 1, 1, 0, 1 days, block.timestamp);
        _invalid(address(0), 1, 1, 0, 1 days, uint256(type(uint64).max) + 1);
        _invalid(address(0), 1, 1, 0, 1 days, uint256(type(uint64).max) - 2 days + 1);
        _invalid(address(0), 1, 1, 0, 1 days, 8_640_000_000_000 - 2 days + 1);
        _invalid(address(0), 1, 1, 0, type(uint256).max, block.timestamp + 1);
        (uint256[] memory ids,) = market.getPublicOfferIds(0, 50);
        assertEq(ids.length, 0);
        assertEq(market.offerCreatedAt(1), 0);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function testFuzzOverflowInterestRejected(uint256 principal, uint256 excess) public {
        principal = bound(principal, 1, type(uint256).max);
        excess = bound(excess, 1, principal);
        _invalid(address(0), principal, 1, type(uint256).max - principal + excess, 1 days, block.timestamp + 1);
    }

    function testRejectInvalidConstructorConfiguration() public {
        vm.expectRevert(TurretP2PLendingV2.InvalidConfiguration.selector);
        new TurretP2PLendingV2(IERC20(address(0)), slv, guardian);
        vm.expectRevert(TurretP2PLendingV2.InvalidConfiguration.selector);
        new TurretP2PLendingV2(usd, IERC20(borrower), guardian);
        vm.expectRevert(TurretP2PLendingV2.InvalidConfiguration.selector);
        new TurretP2PLendingV2(usd, usd, guardian);
        vm.expectRevert(TurretP2PLendingV2.InvalidConfiguration.selector);
        new TurretP2PLendingV2(usd, slv, address(0));
    }

    function _invalid(address b, uint256 p, uint256 c, uint256 fee, uint256 duration, uint256 expiry) private {
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.InvalidTerms.selector);
        market.createOffer(b, p, c, fee, duration, expiry);
        assertEq(market.nextOfferId(), 1);
    }
}

contract TurretP2PV2IndexTest is P2PV2TestBase {
    function testPagesFindOldOpenOfferBeyondMoreThanHundredClosedOffers() public {
        _create(); // Oldest available public loan must remain discoverable.
        for (uint256 i; i < 125; ++i) {
            uint256 id = _create();
            vm.prank(lender);
            market.cancelOffer(id);
        }
        uint256 cursor;
        uint256 expectedId = 126;
        uint256 openCount;
        uint256 pages;
        do {
            (uint256[] memory ids, uint256 next) = market.getPublicOfferIds(cursor, 50);
            assertLe(ids.length, 50);
            for (uint256 i; i < ids.length; ++i) {
                assertEq(ids[i], expectedId--);
                if (_offer(ids[i]).status == TurretP2PLendingV2.Status.Open) {
                    openCount++;
                    assertEq(ids[i], 1);
                }
            }
            cursor = next;
            pages++;
        } while (cursor != 0);
        assertEq(pages, 3);
        assertEq(expectedId, 0);
        assertEq(openCount, 1);
    }

    function testSavedCursorIsStableWhenNewOffersArrive() public {
        for (uint256 i; i < 60; ++i) _create();
        (uint256[] memory page, uint256 cursor) = market.getPublicOfferIds(0, 50);
        assertEq(page[0], 60);
        assertEq(page[49], 11);
        assertEq(cursor, 10);
        for (uint256 i; i < 5; ++i) _create();
        (page, cursor) = market.getPublicOfferIds(cursor, 50);
        assertEq(page.length, 10);
        assertEq(page[0], 10);
        assertEq(page[9], 1);
        assertEq(cursor, 0);
    }

    function testAccountHistorySurvivesUnrelatedTrafficAndDoesNotDuplicateRoles() public {
        uint256 mine = _active();
        address stranger = address(0x5151);
        _fundAndApprove(stranger);
        for (uint256 i; i < 70; ++i) {
            vm.prank(thirdParty);
            market.createOffer(stranger, 1, 1, 0, 1 days, block.timestamp + 1 days);
        }
        (uint256[] memory ids, uint256 cursor) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(ids.length, 1);
        assertEq(ids[0], mine);
        assertEq(cursor, 0);
        (ids,) = market.getAccountOfferIds(stranger, 0, 50);
        assertEq(ids.length, 50);
        (ids, cursor) = market.getAccountOfferIds(stranger, 20, 50);
        assertEq(ids.length, 20);
        assertEq(cursor, 0);
    }

    function testAccountCursorUsesAssociationOrderForOlderPublicOfferAcceptedLater() public {
        uint256 publicId = _create();
        vm.prank(lender);
        uint256 privateId = market.createOffer(borrower, 1, 1, 0, 1 days, block.timestamp + 1 days);
        (uint256[] memory ids,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(ids[0], privateId);
        vm.prank(borrower);
        market.acceptOffer(publicId);
        (ids,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(ids.length, 2);
        assertEq(ids[0], publicId);
        assertEq(ids[1], privateId);
    }

    function testEmptyPagesAndInvalidCursorsOrLimits() public {
        (uint256[] memory ids, uint256 cursor) = market.getAccountOfferIds(lender, 0, 50);
        assertEq(ids.length, 0);
        assertEq(cursor, 0);
        vm.expectRevert(TurretP2PLendingV2.InvalidPagination.selector);
        market.getPublicOfferIds(0, 0);
        vm.expectRevert(TurretP2PLendingV2.InvalidPagination.selector);
        market.getPublicOfferIds(0, 51);
        vm.expectRevert(TurretP2PLendingV2.InvalidPagination.selector);
        market.getAccountOfferIds(lender, 1, 50);
        _create();
        vm.expectRevert(TurretP2PLendingV2.InvalidPagination.selector);
        market.getPublicOfferIds(2, 50);
        (ids, cursor) = market.getPublicOfferIds(1, 1);
        assertEq(ids.length, 1);
        assertEq(ids[0], 1);
        assertEq(cursor, 0);
    }
}

contract TurretP2PV2BatchTest is P2PV2TestBase {
    function testBatchDeploysTwelveIndependentPairsWithNoHelperPowers() public {
        IERC20[] memory tokens = new IERC20[](12);
        for (uint256 i; i < tokens.length; ++i) tokens[i] = new P2PToken("ASSET", uint8(6 + i));
        TurretP2PBatchDeployerV2 helper = new TurretP2PBatchDeployerV2(usd, tokens, guardian);
        address[] memory markets = helper.getMarkets();
        assertEq(markets.length, 12);
        for (uint256 i; i < markets.length; ++i) {
            TurretP2PLendingV2 pair = TurretP2PLendingV2(markets[i]);
            assertEq(address(pair.loanToken()), address(usd));
            assertEq(address(pair.collateralToken()), address(tokens[i]));
            assertEq(pair.guardian(), guardian);
            assertEq(pair.nextOfferId(), 1);
            assertEq(helper.markets(i), markets[i]);
            vm.prank(address(helper));
            vm.expectRevert(TurretP2PLendingV2.Unauthorized.selector);
            pair.setNewLoansPaused(true);
        }
    }

    function testBatchRejectsEmptyDuplicateAndInvalidPairsAtomically() public {
        IERC20[] memory tokens = new IERC20[](0);
        vm.expectRevert(TurretP2PBatchDeployerV2.InvalidCollateralList.selector);
        new TurretP2PBatchDeployerV2(usd, tokens, guardian);
        tokens = new IERC20[](2);
        tokens[0] = slv;
        tokens[1] = slv;
        vm.expectRevert(TurretP2PBatchDeployerV2.InvalidCollateralList.selector);
        new TurretP2PBatchDeployerV2(usd, tokens, guardian);
        tokens[1] = usd;
        vm.expectRevert(TurretP2PLendingV2.InvalidConfiguration.selector);
        new TurretP2PBatchDeployerV2(usd, tokens, guardian);
    }
}
