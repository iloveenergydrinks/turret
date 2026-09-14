// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {P2PTestBase, P2PToken, IERC20, TurretP2PLending} from "./P2PTestSupport.sol";

contract TurretP2PLendingTest is P2PTestBase {
    function testLifecycleImmediateRepaymentOwesAllInterestAndWithdrawsExactly() public {
        uint256 lenderUsd = usd.balanceOf(lender);
        uint256 borrowerUsd = usd.balanceOf(borrower);
        uint256 borrowerSlv = slv.balanceOf(borrower);
        uint256 id = _create();
        assertEq(usd.balanceOf(address(market)), PRINCIPAL);
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        assertEq(market.committedPrincipal(), PRINCIPAL);
        assertEq(market.repaymentDeadline(id), 0);
        vm.prank(borrower);
        market.acceptOffer(id);
        assertEq(usd.balanceOf(borrower), borrowerUsd + PRINCIPAL);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(market.lockedCollateral(), COLLATERAL);
        assertEq(market.repaymentDeadline(id), block.timestamp + 31 days);
        vm.prank(borrower);
        market.repay(id);
        _assertStatus(id, TurretP2PLending.Status.Repaid);
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.lockedCollateral(), 0);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST);
        assertEq(market.credits(address(slv), borrower), COLLATERAL);
        assertEq(usd.balanceOf(borrower), borrowerUsd - INTEREST);
        assertEq(usd.balanceOf(lender), lenderUsd - PRINCIPAL);
        vm.prank(lender);
        market.withdraw(usd, PRINCIPAL + INTEREST, lender);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        assertEq(usd.balanceOf(lender), lenderUsd + INTEREST);
        assertEq(slv.balanceOf(borrower), borrowerSlv);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(slv.balanceOf(address(market)), 0);
        _assertSolvent();
    }

    function testRepayInclusiveDeadlineAndDefaultStrictlyAfter() public {
        uint256 id = _active();
        vm.warp(market.repaymentDeadline(id));
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.TooEarly.selector);
        market.claimDefault(id);
        vm.prank(borrower);
        market.repay(id);
        _assertStatus(id, TurretP2PLending.Status.Repaid);
    }

    function testAfterDeadlineRepayFailsAndLenderReceivesAllCollateralInFullSettlement() public {
        uint256 id = _active();
        vm.warp(market.repaymentDeadline(id) + 1);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.RepaymentDeadlinePassed.selector);
        market.repay(id);
        vm.prank(thirdParty);
        market.claimDefault(id);
        assertEq(market.credits(address(slv), thirdParty), 0);
        _assertStatus(id, TurretP2PLending.Status.Defaulted);
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.lockedCollateral(), 0);
        assertEq(market.credits(address(slv), lender), COLLATERAL);
        assertEq(market.credits(address(slv), borrower), 0);
        assertEq(market.credits(address(usd), lender), 0);
        vm.prank(lender);
        market.withdraw(slv, COLLATERAL, thirdParty);
        _assertSolvent();
    }

    function testBorrowerCanRepayThroughoutGracePeriod() public {
        uint256 id = _active();
        vm.warp(_offer(id).dueAt + 12 hours);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.TooEarly.selector);
        market.claimDefault(id);
        vm.prank(borrower);
        market.repay(id);
    }

    function testOfferExpiryBoundaryPreventsAcceptanceAndAllowsAnyoneToReleaseOnlyLenderCredit() public {
        uint256 id = _create();
        vm.warp(_offer(id).expiresAt - 1);
        vm.expectRevert(TurretP2PLending.TooEarly.selector);
        market.expireOffer(id);
        vm.warp(_offer(id).expiresAt);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.OfferExpired.selector);
        market.acceptOffer(id);
        vm.prank(thirdParty);
        market.expireOffer(id);
        _assertStatus(id, TurretP2PLending.Status.Expired);
        assertEq(market.credits(address(usd), lender), PRINCIPAL);
        assertEq(market.credits(address(usd), thirdParty), 0);
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.reservedPrincipal(), 0);
    }

    function testAcceptanceOneSecondBeforeExpirySucceeds() public {
        uint256 id = _create();
        vm.warp(_offer(id).expiresAt - 1);
        vm.prank(borrower);
        market.acceptOffer(id);
        _assertStatus(id, TurretP2PLending.Status.Active);
    }

    function testNamedBorrowerOnlyAndCancelFirstPreventsAcceptance() public {
        uint256 id = _create();
        vm.prank(thirdParty);
        vm.expectRevert(TurretP2PLending.Unauthorized.selector);
        market.acceptOffer(id);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.Unauthorized.selector);
        market.cancelOffer(id);
        vm.prank(lender);
        market.cancelOffer(id);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.acceptOffer(id);
        assertEq(market.credits(address(usd), lender), PRINCIPAL);
    }

    function testAcceptFirstPreventsLenderCancellingOrExpiring() public {
        uint256 id = _active();
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.cancelOffer(id);
        vm.warp(_offer(id).expiresAt);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.expireOffer(id);
        _assertStatus(id, TurretP2PLending.Status.Active);
    }

    function testLenderCanCancelExpiredOffer() public {
        uint256 id = _create();
        vm.warp(_offer(id).expiresAt);
        vm.prank(lender);
        market.cancelOffer(id);
        assertEq(market.credits(address(usd), lender), PRINCIPAL);
    }

    function testThirdPartyRepaysFromOwnFundsNeverBorrowerAllowance() public {
        uint256 id = _active();
        uint256 borrowerBalance = usd.balanceOf(borrower);
        uint256 thirdPartyBalance = usd.balanceOf(thirdParty);
        vm.prank(borrower);
        usd.approve(address(market), 0);
        vm.prank(thirdParty);
        market.repay(id);
        assertEq(usd.balanceOf(borrower), borrowerBalance);
        assertEq(usd.balanceOf(thirdParty), thirdPartyBalance - PRINCIPAL - INTEREST);
        assertEq(market.credits(address(slv), borrower), COLLATERAL);
        assertEq(market.credits(address(slv), thirdParty), 0);
    }

    function testThirdPartyWithoutFundsCannotUseBorrowerApproval() public {
        uint256 id = _active();
        uint256 borrowerBalance = usd.balanceOf(borrower);
        address unfunded = address(0xBAD);
        vm.prank(unfunded);
        usd.approve(address(market), type(uint256).max);
        vm.prank(unfunded);
        vm.expectRevert();
        market.repay(id);
        assertEq(usd.balanceOf(borrower), borrowerBalance);
        assertEq(market.credits(address(usd), lender), 0);
        assertEq(market.credits(address(slv), borrower), 0);
        _assertStatus(id, TurretP2PLending.Status.Active);
    }

    function testPauseBlocksCreationAndAcceptanceButPreservesAllRecoveryPaths() public {
        uint256 cancelId = _create();
        uint256 expireId = _create();
        uint256 repayId = _active();
        uint256 defaultId = _active();
        vm.prank(guardian);
        market.setNewLoansPaused(true);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.NewLoansPaused.selector);
        market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.NewLoansPaused.selector);
        market.acceptOffer(cancelId);
        vm.prank(lender);
        market.cancelOffer(cancelId);
        vm.prank(borrower);
        market.repay(repayId);
        vm.warp(market.repaymentDeadline(defaultId) + 1);
        market.expireOffer(expireId);
        vm.prank(lender);
        market.claimDefault(defaultId);
        vm.prank(lender);
        market.withdraw(usd, 3 * PRINCIPAL + INTEREST, lender);
        vm.prank(lender);
        market.withdraw(slv, COLLATERAL, lender);
        vm.prank(borrower);
        market.withdraw(slv, COLLATERAL, borrower);
        assertEq(market.committedPrincipal(), 0);
        _assertSolvent();
    }

    function testOnlyGuardianCanPauseAndUnpause() public {
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.Unauthorized.selector);
        market.setNewLoansPaused(true);
        vm.prank(guardian);
        market.setNewLoansPaused(true);
        vm.prank(borrower);
        vm.expectRevert(TurretP2PLending.Unauthorized.selector);
        market.setNewLoansPaused(false);
        vm.prank(guardian);
        market.setNewLoansPaused(false);
        _active();
    }

    function testWithdrawalRequiresOwnCreditAndSupportsPartialAndAlternateRecipient() public {
        uint256 id = _create();
        vm.prank(lender);
        market.cancelOffer(id);
        vm.prank(thirdParty);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, PRINCIPAL, thirdParty);
        vm.startPrank(lender);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, 0, lender);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, PRINCIPAL, address(0));
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, PRINCIPAL, address(market));
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(slv, PRINCIPAL, lender);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(IERC20(address(0x1234)), PRINCIPAL, lender);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, PRINCIPAL + 1, lender);
        market.withdraw(usd, 1, thirdParty);
        assertEq(market.credits(address(usd), lender), PRINCIPAL - 1);
        market.withdraw(usd, PRINCIPAL - 1, thirdParty);
        vm.expectRevert(TurretP2PLending.InvalidWithdrawal.selector);
        market.withdraw(usd, 1, lender);
        vm.stopPrank();
    }

    function testPendingAndActivePrincipalShareCapButCreditsDoNotConsumeCap() public {
        market = new TurretP2PLending(usd, slv, guardian, PRINCIPAL, 2 * PRINCIPAL, _lenders());
        _fundAndApprove(lender);
        _fundAndApprove(borrower);
        uint256 first = _active();
        uint256 second = _create();
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.ExposureLimit.selector);
        market.createOffer(borrower, 1, COLLATERAL, 0, 7 days, block.timestamp + 1 hours);
        vm.prank(borrower);
        market.repay(first);
        uint256 third = _create();
        assertEq(market.committedPrincipal(), 2 * PRINCIPAL);
        assertEq(market.reservedPrincipal(), 2 * PRINCIPAL);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST);
        vm.prank(lender);
        market.cancelOffer(second);
        vm.prank(lender);
        market.cancelOffer(third);
        assertEq(market.committedPrincipal(), 0);
        _assertSolvent();
    }

    function testTwoPairsHaveIndependentEscrowPauseAndLimits() public {
        P2PToken otherCollateral = new P2PToken("GOLD", 18);
        TurretP2PLending second = new TurretP2PLending(usd, otherCollateral, guardian, PRINCIPAL, PRINCIPAL, _lenders());
        otherCollateral.mint(borrower, COLLATERAL);
        vm.prank(lender);
        usd.approve(address(second), PRINCIPAL);
        vm.prank(borrower);
        otherCollateral.approve(address(second), COLLATERAL);
        uint256 firstId = _active();
        vm.prank(lender);
        uint256 secondId = second.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
        vm.prank(guardian);
        market.setNewLoansPaused(true);
        vm.prank(borrower);
        second.acceptOffer(secondId);
        assertFalse(second.newLoansPaused());
        assertEq(market.committedPrincipal(), PRINCIPAL);
        assertEq(second.committedPrincipal(), PRINCIPAL);
        vm.prank(borrower);
        market.repay(firstId);
        assertEq(second.lockedCollateral(), COLLATERAL);
        assertEq(second.committedPrincipal(), PRINCIPAL);
        assertEq(second.totalCredits(address(usd)), 0);
    }

    function testNoDoubleSettlementAcrossTerminalStates() public {
        uint256 repaidId = _active();
        uint256 defaultId = _active();
        uint256 cancelledId = _create();
        uint256 expiredId = _create();
        vm.prank(borrower);
        market.repay(repaidId);
        vm.prank(lender);
        market.cancelOffer(cancelledId);
        vm.warp(market.repaymentDeadline(defaultId) + 1);
        vm.prank(lender);
        market.claimDefault(defaultId);
        market.expireOffer(expiredId);
        for (uint256 id = 1; id <= 4; id++) {
            vm.expectRevert(TurretP2PLending.WrongStatus.selector);
            market.repay(id);
            vm.prank(lender);
            vm.expectRevert(TurretP2PLending.WrongStatus.selector);
            market.claimDefault(id);
            vm.prank(lender);
            vm.expectRevert(TurretP2PLending.WrongStatus.selector);
            market.cancelOffer(id);
            vm.expectRevert(TurretP2PLending.WrongStatus.selector);
            market.expireOffer(id);
            vm.prank(borrower);
            vm.expectRevert(TurretP2PLending.WrongStatus.selector);
            market.acceptOffer(id);
        }
        assertEq(market.credits(address(usd), lender), 3 * PRINCIPAL + INTEREST);
        assertEq(market.credits(address(slv), lender), COLLATERAL);
        assertEq(market.credits(address(slv), borrower), COLLATERAL);
        _assertSolvent();
    }

    function testUnknownIdsCannotBeUsed() public {
        assertEq(market.repaymentDeadline(999), 0);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.acceptOffer(999);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.cancelOffer(999);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.expireOffer(999);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.repay(999);
        vm.expectRevert(TurretP2PLending.WrongStatus.selector);
        market.claimDefault(999);
    }

    function testHundredDistinctBorrowersStaySolventThroughMixedSettlements() public {
        for (uint256 i = 0; i < 100; i++) {
            address l = lender;
            address b = address(uint160(2000 + i));
            _fundAndApprove(l);
            _fundAndApprove(b);
            vm.prank(l);
            uint256 id = market.createOffer(b, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours);
            vm.prank(b);
            market.acceptOffer(id);
        }
        assertEq(market.committedPrincipal(), 100 * PRINCIPAL);
        assertEq(market.lockedCollateral(), 100 * COLLATERAL);
        for (uint256 id = 1; id <= 100; id += 2) {
            vm.prank(_offer(id).borrower);
            market.repay(id);
            _assertSolvent();
        }
        vm.warp(market.repaymentDeadline(2) + 1);
        for (uint256 id = 2; id <= 100; id += 2) {
            vm.prank(_offer(id).lender);
            market.claimDefault(id);
            _assertSolvent();
        }
        for (uint256 id = 1; id <= 100; id++) {
            TurretP2PLending.Offer memory o = _offer(id);
            if (id % 2 == 1) {
                vm.prank(o.lender);
                market.withdraw(usd, PRINCIPAL + INTEREST, o.lender);
                vm.prank(o.borrower);
                market.withdraw(slv, COLLATERAL, o.borrower);
            } else {
                vm.prank(o.lender);
                market.withdraw(slv, COLLATERAL, o.lender);
            }
        }
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.lockedCollateral(), 0);
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(slv.balanceOf(address(market)), 0);
    }

    function testFuzzTermsAndFullRepaymentAcrossDecimals(uint256 p, uint256 c, uint256 interestSeed, uint8 termSeed) public {
        p = bound(p, 1, market.maxPrincipalPerLoan());
        c = bound(c, 1, 1_000_000e18);
        uint256 interest = bound(interestSeed, 0, p / 10);
        uint256 duration = termSeed % 3 == 0 ? 7 days : termSeed % 3 == 1 ? 14 days : 30 days;
        vm.prank(lender);
        uint256 id = market.createOffer(borrower, p, c, interest, duration, block.timestamp + 1);
        vm.prank(borrower);
        market.acceptOffer(id);
        vm.prank(borrower);
        market.repay(id);
        assertEq(market.credits(address(usd), lender), p + interest);
        assertEq(market.credits(address(slv), borrower), c);
        assertEq(market.committedPrincipal(), 0);
        _assertSolvent();
    }

    function testFuzzRejectInterestAboveTenPercent(uint256 p, uint256 excess) public {
        p = bound(p, 1, market.maxPrincipalPerLoan());
        excess = bound(excess, 1, type(uint128).max);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.InvalidTerms.selector);
        market.createOffer(borrower, p, COLLATERAL, p / 10 + excess, 7 days, block.timestamp + 1 hours);
    }

    function testInvalidTerms() public {
        _invalid(address(0), PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1);
        _invalid(address(market), PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1);
        _invalid(lender, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1);
        _invalid(borrower, 0, COLLATERAL, 0, 7 days, block.timestamp + 1);
        _invalid(borrower, market.maxPrincipalPerLoan() + 1, COLLATERAL, 0, 7 days, block.timestamp + 1);
        _invalid(borrower, PRINCIPAL, 0, INTEREST, 7 days, block.timestamp + 1);
        _invalid(borrower, PRINCIPAL, COLLATERAL, INTEREST, 1 days, block.timestamp + 1);
        _invalid(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp);
        _invalid(borrower, PRINCIPAL, COLLATERAL, INTEREST, 7 days, block.timestamp + 1 hours + 1);
    }

    function _invalid(address b, uint256 p, uint256 c, uint256 i, uint256 duration, uint256 expiry) private {
        vm.prank(lender);
        vm.expectRevert(TurretP2PLending.InvalidTerms.selector);
        market.createOffer(b, p, c, i, duration, expiry);
        assertEq(market.nextOfferId(), 1);
    }

    function testRejectInvalidConstructorConfiguration() public {
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(IERC20(address(0)), slv, guardian, 1, 1, _lenders());
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(usd, IERC20(borrower), guardian, 1, 1, _lenders());
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(usd, usd, guardian, 1, 1, _lenders());
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(usd, slv, address(0), 1, 1, _lenders());
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(usd, slv, guardian, 0, 1, _lenders());
        vm.expectRevert(TurretP2PLending.InvalidConfiguration.selector);
        new TurretP2PLending(usd, slv, guardian, 2, 1, _lenders());
    }
}
