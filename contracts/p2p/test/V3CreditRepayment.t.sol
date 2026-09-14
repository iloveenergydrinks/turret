// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {V3TestBase, TurretP2PLendingV3, TurretP2PVaultV3} from "./V3TestSupport.sol";

contract V3CreditRepaymentTest is V3TestBase {
    function testAllCreditRepaymentNeedsNoWalletApprovalAndPaysFixedLender() public {
        uint256 source = _credit(BORROWER, P + I);
        uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        vm.prank(BORROWER); usd.approve(address(market), 0);
        uint256 before = usd.balanceOf(BORROWER);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        assertEq(usd.balanceOf(BORROWER), before);
        _assertStatus(target, TurretP2PLendingV3.Status.Repaid);
        _assertCredit(source, usd, BORROWER, 0, 0);
        _assertCredit(target, usd, LENDER, P + I, P + I);
        _assertCredit(target, collateral, BORROWER, C, C); _assertAccounting();
    }

    function testMultipleSourcesAndExactWalletRemainderPreserveLeftoverClaims() public {
        uint256 a = _credit(BORROWER, 40e6); uint256 b = _credit(BORROWER, 70e6);
        uint256 target = _active();
        uint256[] memory ids = new uint256[](2); ids[0] = a; ids[1] = b;
        uint256[] memory amounts = new uint256[](2); amounts[0] = 25e6; amounts[1] = 35e6;
        uint256 before = usd.balanceOf(BORROWER);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 45e6);
        assertEq(usd.balanceOf(BORROWER), before - 45e6);
        _assertCredit(a, usd, BORROWER, 15e6, 15e6);
        _assertCredit(b, usd, BORROWER, 35e6, 35e6);
        _assertCredit(target, usd, LENDER, P + I, P + I); _assertAccounting();
    }

    function testThirdPartyAndLenderMayPayOnlyUsingTheirOwnSourceClaims() public {
        address[2] memory payers = [PAYER, LENDER];
        for (uint256 i; i < payers.length; ++i) {
            uint256 source = _credit(payers[i], P + I); uint256 target = _active();
            (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
            uint256 borrowerBalance = usd.balanceOf(BORROWER);
            vm.prank(payers[i]); market.repayWithCredits(target, ids, amounts, 0);
            assertEq(usd.balanceOf(BORROWER), borrowerBalance);
            _assertCredit(target, collateral, BORROWER, C, C);
            _assertCredit(target, usd, LENDER, P + I, P + I); _assertAccounting();
        }
    }

    function testRepaymentSourceMayBeRepaidOrExpiredButNeverMerelyDue() public {
        uint256 repaidSource = _create(BORROWER, PAYER, P);
        vm.prank(PAYER); market.acceptOffer(repaidSource);
        vm.prank(PAYER); market.repay(repaidSource);
        uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(repaidSource, P + I);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        uint256 expiredSource = _create(BORROWER, PAYER, P + I);
        vm.warp(_offer(expiredSource).expiresAt); market.expireOffer(expiredSource);
        target = _active(); (ids, amounts) = _sources(expiredSource, P + I);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        uint256 dueSource = _create(BORROWER, PAYER, P);
        vm.prank(PAYER); market.acceptOffer(dueSource);
        vm.warp(market.repaymentDeadline(dueSource) + 1);
        target = _active(); (ids, amounts) = _sources(dueSource, P);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, I);
        _assertAccounting();
    }

    function testOtherAccountsCreditAndAllowanceCannotBeSpent() public {
        uint256 source = _credit(LENDER, P + I); uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(PAYER); market.repayWithCredits(target, ids, amounts, 0);
        _assertCredit(source, usd, LENDER, P + I, P + I);
        _assertStatus(target, TurretP2PLendingV3.Status.Active); _assertAccounting();
    }

    function testSourceIdentifiersCannotImportCreditOwnershipFromAnotherManager() public {
        uint256 localSource = _credit(LENDER, P + I);
        uint256 target = _active();
        TurretP2PLendingV3 another = new TurretP2PLendingV3(usd, collateral, GUARDIAN);
        vm.startPrank(BORROWER);
        usd.approve(address(another), P + I);
        uint256 foreignSource = another.createOffer(address(0), P + I, C, I, 10 days, block.timestamp + 1 days);
        another.cancelOffer(foreignSource);
        vm.stopPrank();
        assertEq(foreignSource, localSource);
        (uint256[] memory ids, uint256[] memory amounts) = _sources(foreignSource, P + I);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        (address owner, uint256 face, uint256 available) = another.loanCredit(foreignSource, usd);
        assertEq(owner, BORROWER); assertEq(face, P + I); assertEq(available, P + I);
        _assertCredit(localSource, usd, LENDER, P + I, P + I); _assertAccounting();
    }

    function testCollateralClaimDoesNotGiveCallerTheSameLoansUsdClaim() public {
        uint256 source = _active(); vm.prank(PAYER); market.repay(source);
        uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        _assertCredit(source, collateral, BORROWER, C, C);
        _assertCredit(source, usd, LENDER, P + I, P + I); _assertAccounting();
    }

    function testSourceDonationDoesNotIncreaseSpendableNominalCredit() public {
        uint256 source = _credit(BORROWER, P); uint256 target = _active();
        usd.mint(market.vaults(source), I);
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        vm.expectRevert(TurretP2PLendingV3.InvalidWithdrawal.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        _assertCredit(source, usd, BORROWER, P, P); _assertAccounting();
    }

    function testUnbackedFaceCannotPayAndFreshDepositsDoNotRestoreIt() public {
        uint256 source = _credit(BORROWER, P + I);
        usd.removeBalance(market.vaults(source), 1);
        uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        vm.expectRevert(TurretP2PLendingV3.InsufficientBacking.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        amounts[0] -= 1;
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 1);
        _assertCredit(source, usd, BORROWER, 1, 0);
        _assertCredit(target, usd, LENDER, P + I, P + I); _assertAccounting();
    }

    function testTargetPredonationNeverCountsTowardNewRepayment() public {
        uint256 target = _active(); usd.mint(market.vaults(target), P + I);
        uint256[] memory empty = new uint256[](0);
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, empty, empty, 0);
        uint256 before = usd.balanceOf(BORROWER);
        vm.prank(BORROWER); market.repayWithCredits(target, empty, empty, P + I);
        assertEq(usd.balanceOf(BORROWER), before - P - I);
        assertEq(usd.balanceOf(market.vaults(target)), 2 * (P + I));
        _assertCredit(target, usd, LENDER, P + I, P + I); _assertAccounting();
    }

    function testSecondSourceFailureRollsBackFirstSourceAndTarget() public {
        uint256 a = _credit(BORROWER, 50e6); uint256 b = _credit(BORROWER, 55e6);
        usd.removeBalance(market.vaults(b), 1);
        uint256 target = _active();
        uint256[] memory ids = new uint256[](2); ids[0] = a; ids[1] = b;
        uint256[] memory amounts = new uint256[](2); amounts[0] = 50e6; amounts[1] = 55e6;
        vm.expectRevert(TurretP2PLendingV3.InsufficientBacking.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        _assertCredit(a, usd, BORROWER, 50e6, 50e6);
        _assertCredit(b, usd, BORROWER, 55e6, 55e6 - 1);
        assertEq(usd.balanceOf(market.vaults(target)), 0);
        _assertStatus(target, TurretP2PLendingV3.Status.Active); _assertAccounting();
    }

    function testWalletTransferFailureRollsBackPreviouslyTransferredCredit() public {
        uint256 source = _credit(BORROWER, 50e6); uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, 50e6);
        vm.prank(BORROWER); usd.approve(address(market), 0);
        vm.expectRevert(); vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 55e6);
        _assertCredit(source, usd, BORROWER, 50e6, 50e6);
        assertEq(usd.balanceOf(market.vaults(target)), 0);
        _assertStatus(target, TurretP2PLendingV3.Status.Active); _assertAccounting();
    }

    function testSourceTransferMustHaveExactSenderAndRecipientDeltas() public {
        uint256 source = _credit(BORROWER, P + I); uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, P + I);
        usd.setFee(1);
        vm.expectRevert(TurretP2PVaultV3.UnsupportedTransfer.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        _assertCredit(source, usd, BORROWER, P + I, P + I);
        _assertStatus(target, TurretP2PLendingV3.Status.Active); _assertAccounting();
    }

    function testRejectsDuplicateDescendingZeroSelfAndWrongWalletSourceLists() public {
        uint256 a = _credit(BORROWER, P); uint256 b = _credit(BORROWER, P); uint256 target = _active();
        uint256[] memory ids = new uint256[](2); uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1; amounts[1] = 1;
        for (uint256 mode; mode < 4; ++mode) {
            ids[0] = mode == 0 ? a : mode == 1 ? b : mode == 2 ? 0 : target;
            ids[1] = mode == 0 ? a : mode == 1 ? a : target + 1;
            vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
            vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I - 2);
        }
        (ids, amounts) = _sources(a, 0);
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I);
        amounts[0] = 1;
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I);
        amounts[0] = P + I + 1;
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, 0);
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, new uint256[](0), P + I);
        _assertAccounting();
    }

    function testSourceLimitAllowsSixteenAndRejectsSeventeenBeforeAnyMovement() public {
        uint256[] memory ids = new uint256[](17); uint256[] memory amounts = new uint256[](17);
        for (uint256 i; i < 17; ++i) { ids[i] = _credit(BORROWER, 1e6); amounts[i] = 1e6; }
        uint256 target = _active();
        vm.expectRevert(TurretP2PLendingV3.InvalidCreditSources.selector);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I - 17e6);
        assembly { mstore(ids, 16) mstore(amounts, 16) }
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I - 16e6);
        _assertCredit(17, usd, BORROWER, 1e6, 1e6); _assertAccounting();
    }

    function testFuzzMixedRepaymentConservesEachSourceAndFullDebt(uint96 creditSeed, uint96 lossSeed) public {
        uint256 supplied = bound(creditSeed, 1, P + I);
        uint256 loss = bound(lossSeed, 0, P + I - supplied);
        uint256 source = _credit(BORROWER, P + I);
        usd.removeBalance(market.vaults(source), loss);
        uint256 target = _active();
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, supplied);
        uint256 walletBefore = usd.balanceOf(BORROWER);
        vm.prank(BORROWER); market.repayWithCredits(target, ids, amounts, P + I - supplied);
        assertEq(usd.balanceOf(BORROWER), walletBefore - (P + I - supplied));
        _assertCredit(source, usd, BORROWER, P + I - supplied, P + I - loss - supplied);
        _assertCredit(target, usd, LENDER, P + I, P + I); _assertAccounting();
    }
}
