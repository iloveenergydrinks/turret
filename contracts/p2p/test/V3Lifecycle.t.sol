// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {V3TestBase, TurretP2PLendingV3} from "./V3TestSupport.sol";

contract V3LifecycleTest is V3TestBase {
    function _proposal(uint256 id) internal view returns (TurretP2PLendingV3.ExtensionProposal memory p) {
        (bool ok, bytes memory data) = address(market).staticcall(abi.encodeCall(market.extensionProposals, (id)));
        require(ok); return abi.decode(data, (TurretP2PLendingV3.ExtensionProposal));
    }
    function _propose(uint256 id, address who) internal returns (TurretP2PLendingV3.ExtensionProposal memory) {
        uint256 newDeadline = market.repaymentDeadline(id) + 5 days;
        vm.prank(who); market.proposeExtension(id, newDeadline, block.timestamp + 1 days);
        return _proposal(id);
    }
    function _accept(uint256 id, address who, TurretP2PLendingV3.ExtensionProposal memory p) internal {
        vm.prank(who); market.acceptExtension(id, p.nonce, p.oldDeadline, p.newDeadline, p.expiresAt);
    }

    function testPublicOfferBindsOnlyFirstEligibleBorrowerAndPrivateOfferEnforcesTarget() public {
        uint256 id = _create(LENDER, address(0), P);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(LENDER); market.acceptOffer(id);
        vm.prank(PAYER); market.acceptOffer(id);
        assertEq(_offer(id).borrower, PAYER); assertTrue(market.isPublicOffer(id));
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector);
        vm.prank(BORROWER); market.acceptOffer(id);
        uint256 privateId = _create(LENDER, BORROWER, P);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(PAYER); market.acceptOffer(privateId);
        vm.prank(BORROWER); market.acceptOffer(privateId); _assertAccounting();
    }

    function testOfferExpiryBoundaryRejectsAcceptanceAndAllowsRefundOnlyToLender() public {
        uint256 id = _create(LENDER, BORROWER, P);
        vm.expectRevert(TurretP2PLendingV3.TooEarly.selector); market.expireOffer(id);
        vm.warp(_offer(id).expiresAt);
        vm.expectRevert(TurretP2PLendingV3.OfferExpired.selector);
        vm.prank(BORROWER); market.acceptOffer(id);
        vm.prank(OTHER); market.expireOffer(id);
        _assertCredit(id, usd, LENDER, P, P);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(OTHER); market.withdrawCredit(id, usd, P, OTHER); _assertAccounting();
    }

    function testInvalidRecipientsAndForeignTokenNeverConsumeOwnerCredit() public {
        uint256 id = _credit(LENDER, P);
        address[3] memory invalid = [address(0), address(market), market.vaults(id)];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(); vm.prank(LENDER); market.withdrawCredit(id, usd, 1, invalid[i]);
            _assertCredit(id, usd, LENDER, P, P);
        }
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(LENDER); market.withdrawCredit(id, collateral, 1, LENDER);
        vm.expectRevert(TurretP2PLendingV3.InvalidWithdrawal.selector);
        vm.prank(LENDER); market.withdrawCredit(id, usd, 0, LENDER); _assertAccounting();
    }

    function testRepaymentAllowedAtExactFinalDeadlineAndDefaultStrictlyLater() public {
        uint256 id = _active(); vm.warp(market.repaymentDeadline(id));
        vm.expectRevert(TurretP2PLendingV3.TooEarly.selector); market.claimDefault(id);
        vm.prank(PAYER); market.repay(id);
        _assertStatus(id, TurretP2PLendingV3.Status.Repaid);
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector); market.claimDefault(id);
        _assertAccounting();
    }

    function testAfterFinalDeadlineCannotRepayButAnyoneCanSettleDefault() public {
        uint256 id = _active(); vm.warp(market.repaymentDeadline(id) + 1);
        vm.expectRevert(TurretP2PLendingV3.RepaymentDeadlinePassed.selector);
        vm.prank(PAYER); market.repay(id);
        vm.prank(OTHER); market.claimDefault(id);
        _assertCredit(id, collateral, LENDER, C, C);
        _assertCredit(id, usd, address(0), 0, 0);
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector);
        vm.prank(BORROWER); market.repay(id); _assertAccounting();
    }

    function testMutualExtensionChangesOnlyDeadlineInEitherProposalDirection() public {
        address[2] memory proposers = [LENDER, BORROWER];
        for (uint256 i; i < proposers.length; ++i) {
            uint256 id = _active(); TurretP2PLendingV3.Offer memory before = _offer(id);
            TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, proposers[i]);
            assertEq(market.repaymentDeadline(id), p.oldDeadline);
            _accept(id, i == 0 ? BORROWER : LENDER, p);
            TurretP2PLendingV3.Offer memory after_ = _offer(id);
            assertEq(after_.dueAt, p.newDeadline - 1 days);
            before.dueAt = after_.dueAt;
            assertEq(keccak256(abi.encode(before)), keccak256(abi.encode(after_)));
            assertEq(_proposal(id).proposer, address(0)); _assertAccounting();
        }
    }

    function testExtensionRequiresCounterpartyAndEveryExactProposalField() public {
        uint256 id = _active(); TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, LENDER);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector); _accept(id, LENDER, p);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector); _accept(id, OTHER, p);
        for (uint256 mode; mode < 4; ++mode) {
            vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector);
            vm.prank(BORROWER);
            market.acceptExtension(id, p.nonce + (mode == 0 ? 1 : 0), p.oldDeadline + (mode == 1 ? 1 : 0),
                p.newDeadline + (mode == 2 ? 1 : 0), p.expiresAt + (mode == 3 ? 1 : 0));
        }
        _accept(id, BORROWER, p);
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector); _accept(id, BORROWER, p);
        _assertAccounting();
    }

    function testProposalExpirationIsExclusiveAndDoesNotMoveDeadline() public {
        uint256 id = _active(); TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, BORROWER);
        vm.warp(p.expiresAt);
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector); _accept(id, LENDER, p);
        assertEq(market.repaymentDeadline(id), p.oldDeadline);
    }

    function testProposalCanBeAcceptedOneSecondBeforeExpiration() public {
        uint256 id = _active(); TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, LENDER);
        vm.warp(p.expiresAt - 1); _accept(id, BORROWER, p);
        assertEq(market.repaymentDeadline(id), p.newDeadline);
    }

    function testRevocationReplacementAndOldNonceCannotSupplyConsent() public {
        uint256 id = _active(); TurretP2PLendingV3.ExtensionProposal memory a = _propose(id, LENDER);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(BORROWER); market.cancelExtension(id, a.nonce);
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector);
        vm.prank(LENDER); market.cancelExtension(id, a.nonce + 1);
        vm.prank(LENDER); market.cancelExtension(id, a.nonce);
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector); _accept(id, BORROWER, a);
        TurretP2PLendingV3.ExtensionProposal memory b = _propose(id, BORROWER);
        assertGt(b.nonce, a.nonce);
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector); _accept(id, LENDER, a);
        _accept(id, LENDER, b);
        TurretP2PLendingV3.ExtensionProposal memory c = _propose(id, LENDER);
        assertGt(c.nonce, b.nonce); assertEq(c.oldDeadline, b.newDeadline);
        _accept(id, BORROWER, c); _assertAccounting();
    }

    function testUnclaimedOverdueLoanMayBeExtendedOnlyBeforeDefaultSettles() public {
        uint256 id = _active(); vm.warp(market.repaymentDeadline(id) + 1);
        TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, BORROWER);
        _accept(id, LENDER, p);
        vm.expectRevert(TurretP2PLendingV3.TooEarly.selector); market.claimDefault(id);
        vm.prank(PAYER); market.repay(id); _assertAccounting();
    }

    function testPendingProposalNeverBlocksDefaultAndSettledLoanCannotReopen() public {
        uint256 id = _active(); vm.warp(market.repaymentDeadline(id));
        TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, BORROWER);
        vm.warp(block.timestamp + 1); market.claimDefault(id);
        assertEq(_proposal(id).proposer, address(0));
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector); _accept(id, LENDER, p);
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector);
        vm.prank(BORROWER); market.proposeExtension(id, p.newDeadline, p.expiresAt);
        _assertAccounting();
    }

    function testRepaymentClearsPendingExtensionAndCannotBeReopened() public {
        uint256 id = _active(); TurretP2PLendingV3.ExtensionProposal memory p = _propose(id, LENDER);
        vm.prank(BORROWER); market.repay(id);
        assertEq(_proposal(id).proposer, address(0));
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector); _accept(id, BORROWER, p);
    }

    function testExtensionValidatesGrowthFutureExpiryAndMaximumTimestamp() public {
        uint256 id = _active(); uint256 old = market.repaymentDeadline(id);
        uint256[4] memory deadlines = [old, old - 1, market.MAX_TIMESTAMP() + 1, old + 1 days];
        for (uint256 i; i < 4; ++i) {
            vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector);
            vm.prank(LENDER); market.proposeExtension(id, deadlines[i], i == 3 ? block.timestamp : block.timestamp + 1);
        }
        vm.expectRevert(TurretP2PLendingV3.InvalidExtension.selector);
        vm.prank(LENDER); market.proposeExtension(id, old + 1 days, old + 1 days + 1);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(GUARDIAN); market.proposeExtension(id, old + 1 days, block.timestamp + 1);
        uint256 maximum = market.MAX_TIMESTAMP();
        vm.prank(LENDER); market.proposeExtension(id, maximum, block.timestamp + 1 days);
        _accept(id, BORROWER, _proposal(id));
        assertEq(market.repaymentDeadline(id), market.MAX_TIMESTAMP());
    }

    function testPauseDoesNotBlockExtensionSettlementRefundOrOwnedWithdrawal() public {
        uint256 creditId = _credit(BORROWER, P + I);
        uint256 id = _active(); uint256 pending = _create(LENDER, BORROWER, P);
        vm.prank(GUARDIAN); market.setNewLoansPaused(true);
        vm.expectRevert(TurretP2PLendingV3.NewLoansPaused.selector);
        vm.prank(BORROWER); market.acceptOffer(pending);
        vm.expectRevert(TurretP2PLendingV3.NewLoansPaused.selector);
        vm.prank(LENDER); market.createOffer(BORROWER, P, C, I, 10 days, block.timestamp + 1);
        _accept(id, BORROWER, _propose(id, LENDER));
        (uint256[] memory ids, uint256[] memory amounts) = _sources(creditId, P + I);
        vm.prank(BORROWER); market.repayWithCredits(id, ids, amounts, 0);
        vm.prank(LENDER); market.cancelOffer(pending);
        vm.prank(BORROWER); market.withdrawCredit(id, collateral, C, BORROWER);
        vm.prank(LENDER); market.withdrawCredit(pending, usd, P, LENDER); _assertAccounting();
    }

    function testGuardianRotationIsTwoStepRevocableAndLimitedToPause() public {
        uint256 creditId = _credit(LENDER, P); uint256 id = _active();
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(OTHER); market.nominateGuardian(OTHER);
        vm.prank(GUARDIAN); market.nominateGuardian(OTHER);
        assertEq(market.guardian(), GUARDIAN);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(OTHER); market.setNewLoansPaused(true);
        vm.prank(GUARDIAN); market.cancelGuardianNomination();
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(OTHER); market.acceptGuardian();
        vm.prank(GUARDIAN); market.nominateGuardian(PAYER);
        vm.prank(GUARDIAN); market.nominateGuardian(OTHER);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(PAYER); market.acceptGuardian();
        vm.prank(OTHER); market.acceptGuardian();
        assertEq(market.guardian(), OTHER); assertEq(market.pendingGuardian(), address(0));
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(GUARDIAN); market.setNewLoansPaused(true);
        vm.prank(OTHER); market.setNewLoansPaused(true);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(OTHER); market.withdrawCredit(creditId, usd, P, OTHER);
        vm.prank(BORROWER); market.repay(id); _assertAccounting();
    }

    function testGuardianCannotNominateZeroManagerOrSelf() public {
        address[3] memory invalid = [address(0), address(market), GUARDIAN];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(TurretP2PLendingV3.InvalidConfiguration.selector);
            vm.prank(GUARDIAN); market.nominateGuardian(invalid[i]);
        }
    }

    function testActiveIndexSurvivesEightyCancelledTargetedOffersAndRejectsStalePages() public {
        uint256 a = _active();
        for (uint256 i; i < 80; ++i) {
            uint256 id = _create(PAYER, BORROWER, 1e6);
            vm.prank(PAYER); market.cancelOffer(id);
        }
        (uint256[] memory active,, uint256 revision) = market.getActiveLoanIds(BORROWER, 0, 50, 0);
        assertEq(active.length, 1); assertEq(active[0], a);
        (uint256[] memory history,) = market.getAccountOfferIds(BORROWER, 0, 50);
        assertEq(history.length, 1); assertEq(history[0], a);
        (uint256[] memory incoming, uint256 cursor) = market.getIncomingOfferIds(BORROWER, 0, 50);
        assertEq(incoming.length, 50); assertGt(cursor, 0);
        uint256 b = _active(); uint256 c = _active();
        vm.expectRevert(TurretP2PLendingV3.StalePagination.selector);
        market.getActiveLoanIds(BORROWER, 0, 1, revision);
        (active, cursor, revision) = market.getActiveLoanIds(BORROWER, 0, 1, 0);
        assertEq(active[0], a); assertEq(cursor, 1);
        vm.prank(BORROWER); market.repay(b);
        vm.expectRevert(TurretP2PLendingV3.StalePagination.selector);
        market.getActiveLoanIds(BORROWER, cursor, 1, revision);
        (active,,) = market.getActiveLoanIds(BORROWER, 0, 50, 0);
        assertEq(active.length, 2); assertEq(active[0], a); assertEq(active[1], c); _assertAccounting();
    }

    function testTokenCallbackCannotSettleAnotherLoanDuringFunding() public {
        uint256 id = _active(); vm.warp(market.repaymentDeadline(id) + 1);
        usd.setCallback(address(market), abi.encodeCall(market.claimDefault, (id)));
        _create(PAYER, OTHER, P);
        assertFalse(usd.callbackSucceeded());
        assertEq(usd.callbackResult(), abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"));
        _assertStatus(id, TurretP2PLendingV3.Status.Active);
        market.claimDefault(id); _assertAccounting();
    }
}
