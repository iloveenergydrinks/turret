// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {P2PV2TestBase, P2PToken, P2PNoReturnToken, IERC20, TurretP2PLendingV2} from "./P2PV2TestSupport.sol";

contract TurretP2PV2AdversarialTest is P2PV2TestBase {
    function testRejectedPublicFundingDoesNotPublishPhantomOfferOrIndex() public {
        usd.setFee(1);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.createOffer(address(0), PRINCIPAL, COLLATERAL, INTEREST, 2 days, block.timestamp + 10 days);
        (uint256[] memory publicIds,) = market.getPublicOfferIds(0, 50);
        (uint256[] memory accountIds,) = market.getAccountOfferIds(lender, 0, 50);
        assertEq(publicIds.length, 0);
        assertEq(accountIds.length, 0);
        assertFalse(market.isPublicOffer(1));
        assertEq(market.offerCreatedAt(1), 0);
        assertEq(market.nextOfferId(), 1);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function testTrueReturnWithoutMovingTokensCannotCreateUnbackedPrincipal() public {
        usd.setSkipTransfer(true);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        assertEq(market.nextOfferId(), 1);
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function testTrueReturnWithoutMovingCollateralCannotDisbursePrincipal() public {
        uint256 id = _create();
        slv.setSkipTransfer(true);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.acceptOffer(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Open);
        assertEq(_offer(id).borrower, address(0), "failed acceptance must not bind public borrower");
        (uint256[] memory accountIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(accountIds.length, 0, "failed acceptance must not index public borrower");
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        assertEq(market.lockedCollateral(), 0);
        _assertSolvent();
    }

    function testExactTransferTokensWithNoReturnValueSupportCompleteLifecycle() public {
        usd = new P2PNoReturnToken("USDG", 6);
        slv = new P2PNoReturnToken("SLV", 18);
        market = new TurretP2PLendingV2(usd, slv, guardian);
        _fundAndApprove(lender);
        _fundAndApprove(borrower);
        uint256 id = _active();
        vm.prank(borrower);
        market.repay(id);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        _assertStatus(id, TurretP2PLendingV2.Status.Repaid);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(slv.balanceOf(address(market)), 0);
        _assertSolvent();
    }

    function testFeeOnIncomingPrincipalRollsBackOfferIdFundingAndLiabilities() public {
        uint256 beforeBalance = usd.balanceOf(lender);
        usd.setFee(1);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        assertEq(market.nextOfferId(), 1);
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(usd.balanceOf(lender), beforeBalance);
        _assertStatus(1, TurretP2PLendingV2.Status.None);
    }

    function testExtraSenderFeeRejectedEvenWhenEscrowReceivesExactPrincipal() public {
        uint256 beforeBalance = usd.balanceOf(lender);
        usd.setSenderFee(1);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        assertEq(market.nextOfferId(), 1);
        assertEq(usd.balanceOf(lender), beforeBalance);
        assertEq(usd.balanceOf(address(market)), 0);
    }

    function testFeeOnCollateralRollsBackAcceptanceAndKeepsPrincipalReserved() public {
        uint256 id = _create();
        uint256 beforeUsd = usd.balanceOf(borrower);
        uint256 beforeSlv = slv.balanceOf(borrower);
        slv.setFee(1);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.acceptOffer(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Open);
        assertEq(_offer(id).borrower, address(0), "failed acceptance must not bind public borrower");
        (uint256[] memory accountIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(accountIds.length, 0, "failed acceptance must not index public borrower");
        assertEq(_offer(id).dueAt, 0);
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        assertEq(market.committedPrincipal(), PRINCIPAL);
        assertEq(market.lockedCollateral(), 0);
        assertEq(usd.balanceOf(borrower), beforeUsd);
        assertEq(slv.balanceOf(borrower), beforeSlv);
        _assertSolvent();
    }

    function testFeeOnOutgoingPrincipalRollsBackAlreadyPulledCollateral() public {
        uint256 id = _create();
        uint256 beforeSlv = slv.balanceOf(borrower);
        usd.setFee(1);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.acceptOffer(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Open);
        assertEq(_offer(id).borrower, address(0), "failed acceptance must not bind public borrower");
        (uint256[] memory accountIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(accountIds.length, 0, "failed acceptance must not index public borrower");
        assertEq(slv.balanceOf(borrower), beforeSlv);
        assertEq(slv.balanceOf(address(market)), 0);
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        assertEq(market.lockedCollateral(), 0);
        _assertSolvent();
    }

    function testFeeOnRepaymentRollsBackSettlementAndCredits() public {
        uint256 id = _active();
        uint256 beforeBalance = usd.balanceOf(borrower);
        usd.setFee(1);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.repay(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Active);
        assertEq(market.committedPrincipal(), PRINCIPAL);
        assertEq(market.lockedCollateral(), COLLATERAL);
        assertEq(market.totalCredits(address(usd)), 0);
        assertEq(market.totalCredits(address(slv)), 0);
        assertEq(market.credits(address(usd), lender), 0);
        assertEq(market.credits(address(slv), borrower), 0);
        assertEq(usd.balanceOf(borrower), beforeBalance);
        usd.setFee(0);
        vm.prank(borrower);
        market.repay(id);
        _assertSolvent();
    }

    function testFeeOnWithdrawalsPreservesAllCreditsAndCanRetryAfterTokenRecovers() public {
        uint256 id = _active();
        vm.prank(borrower);
        market.repay(id);
        usd.setFee(1);
        slv.setFee(1);
        uint256 beforeLender = usd.balanceOf(lender);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLendingV2.UnsupportedTransfer.selector);
        market.withdraw(slv, COLLATERAL, borrower);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST);
        assertEq(market.credits(address(slv), borrower), COLLATERAL);
        assertEq(market.totalCredits(address(usd)), PRINCIPAL + INTEREST);
        assertEq(market.totalCredits(address(slv)), COLLATERAL);
        assertEq(usd.balanceOf(lender), beforeLender);
        usd.setFee(0);
        slv.setFee(0);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        _assertSolvent();
    }

    function testFalseReturningTransfersFailWithoutCommittingState() public {
        usd.setReturnFalse(true);
        vm.prank(lender);
        vm.expectRevert("SafeERC20: ERC20 operation did not succeed");
        market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        assertEq(market.nextOfferId(), 1);
        usd.setReturnFalse(false);
        uint256 id = _active();
        usd.setReturnFalse(true);
        vm.prank(borrower);
        vm.expectRevert("SafeERC20: ERC20 operation did not succeed");
        market.repay(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Active);
        assertEq(market.totalCredits(address(usd)), 0);
        usd.setReturnFalse(false);
        vm.prank(borrower);
        market.repay(id);
        usd.setReturnFalse(true);
        vm.prank(lender);
        vm.expectRevert("SafeERC20: ERC20 operation did not succeed");
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST);
        _assertSolvent();
    }

    function testBlockedBorrowerCannotPartiallyAcceptOrLoseCollateral() public {
        uint256 id = _create();
        uint256 beforeSlv = slv.balanceOf(borrower);
        usd.setBlockedRecipient(borrower);
        vm.prank(borrower);
        vm.expectRevert("blocked recipient");
        market.acceptOffer(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Open);
        assertEq(_offer(id).borrower, address(0), "failed acceptance must not bind public borrower");
        (uint256[] memory accountIds,) = market.getAccountOfferIds(borrower, 0, 50);
        assertEq(accountIds.length, 0, "failed acceptance must not index public borrower");
        assertEq(slv.balanceOf(borrower), beforeSlv);
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        vm.prank(lender);
        market.cancelOffer(id);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL, lender);
    }

    function testBlockedRecipientsDoNotPreventRepaymentOrOtherAccountsRecovery() public {
        uint256 id = _active();
        usd.setBlockedRecipient(lender);
        slv.setBlockedRecipient(borrower);
        vm.prank(thirdParty);
        market.repay(id);
        _assertStatus(id, TurretP2PLendingV2.Status.Repaid);
        vm.prank(lender);
        vm.expectRevert("blocked recipient");
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        vm.expectRevert("blocked recipient");
        market.withdraw(slv, COLLATERAL, borrower);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST);
        assertEq(market.credits(address(slv), borrower), COLLATERAL);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, thirdParty);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, thirdParty);
        _assertSolvent();
    }

    function testBlockedLenderCannotPreventDefaultAndOtherBorrowerRecovery() public {
        uint256 defaultId = _active();
        uint256 repaidId = _active();
        slv.setBlockedRecipient(lender);
        vm.prank(borrower);
        market.repay(repaidId);
        vm.warp(market.repaymentDeadline(defaultId) + 1);
        vm.prank(thirdParty);
        market.claimDefault(defaultId);
        assertEq(market.committedPrincipal(), 0);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        vm.prank(lender);
        vm.expectRevert("blocked recipient");
        market.withdraw(slv, COLLATERAL, lender);
        assertEq(market.credits(address(slv), lender), COLLATERAL);
        _assertSolvent();
    }

    function testCallbacksCannotReenterDuringInboundOrOutboundTransfers() public {
        // The loan token is the guardian, so its attempted call would be authorized
        // without the reentrancy guard. Merely failing another access check is insufficient.
        market = new TurretP2PLendingV2(usd, slv, address(usd));
        _fundAndApprove(lender);
        _fundAndApprove(borrower);
        usd.setCallback(address(market), abi.encodeCall(market.setNewLoansPaused, (true)));
        uint256 id = _create();
        _assertBlockedReentry(1);
        vm.prank(borrower);
        market.acceptOffer(id);
        _assertBlockedReentry(2);
        vm.prank(borrower);
        market.repay(id);
        _assertBlockedReentry(3);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        _assertBlockedReentry(4);
        _assertSolvent();
    }

    function testCollateralCallbackCannotSettleAnotherOverdueLoanWhileAccepting() public {
        uint256 overdueId = _active();
        vm.warp(market.repaymentDeadline(overdueId) + 1);
        uint256 newId = _create();
        slv.setCallback(address(market), abi.encodeCall(market.claimDefault, (overdueId)));
        vm.prank(borrower);
        market.acceptOffer(newId);
        assertFalse(slv.callbackSucceeded());
        assertEq(slv.callbackResult(), abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"));
        _assertStatus(overdueId, TurretP2PLendingV2.Status.Active);
        market.claimDefault(overdueId);
        _assertStatus(overdueId, TurretP2PLendingV2.Status.Defaulted);
        _assertSolvent();
    }

    function testDonationsCannotBeWithdrawnByGuardianOrStrangersOrInflateCredit() public {
        usd.mint(address(market), 7e6);
        slv.mint(address(market), 11e18);
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(i == 0 ? guardian : thirdParty);
            vm.expectRevert(TurretP2PLendingV2.InvalidWithdrawal.selector);
            market.withdraw(usd, 1, thirdParty);
        }
        uint256 id = _active();
        vm.prank(borrower);
        market.repay(id);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        assertEq(usd.balanceOf(address(market)), 7e6);
        assertEq(slv.balanceOf(address(market)), 11e18);
        assertEq(market.totalCredits(address(usd)), 0);
        assertEq(market.totalCredits(address(slv)), 0);
    }

    function _assertBlockedReentry(uint256 count) private view {
        assertEq(usd.callbacks(), count);
        assertFalse(usd.callbackSucceeded());
        assertEq(usd.callbackResult(), abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"));
        assertFalse(market.newLoansPaused());
    }
}
