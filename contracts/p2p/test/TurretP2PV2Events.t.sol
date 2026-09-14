// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {P2PV2TestBase, TurretP2PLendingV2} from "./P2PV2TestSupport.sol";

contract TurretP2PV2EventsTest is P2PV2TestBase {
    event OfferCreated(uint256 indexed id, address indexed lender, address indexed borrower,
        uint256 principal, uint256 collateralAmount, uint256 interest, uint256 duration, uint256 expiresAt);
    event OfferAccepted(uint256 indexed id, uint256 dueAt, uint256 repaymentDeadline);
    event OfferClosed(uint256 indexed id, TurretP2PLendingV2.Status status);
    event LoanRepaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LoanDefaulted(uint256 indexed id);
    event CreditAdded(address indexed token, address indexed account, uint256 amount);
    event Withdrawn(address indexed token, address indexed account, address indexed recipient, uint256 amount);

    function testOfferCreatedReportsExactPublicAndPrivateTerms() public {
        uint256 expiry = block.timestamp + 3 days;
        vm.expectEmit(true, true, true, true, address(market));
        emit OfferCreated(1, lender, address(0), PRINCIPAL, COLLATERAL, INTEREST, 19 days, expiry);
        vm.prank(lender);
        market.createOffer(address(0), PRINCIPAL, COLLATERAL, INTEREST, 19 days, expiry);

        vm.expectEmit(true, true, true, true, address(market));
        emit OfferCreated(2, thirdParty, borrower, 123e6, 7e18, 0, 1 days, expiry + 1);
        vm.prank(thirdParty);
        market.createOffer(borrower, 123e6, 7e18, 0, 1 days, expiry + 1);
    }

    function testOfferAcceptedReportsDueDateFromAcceptanceTimeAndFullGrace() public {
        uint256 id = _create();
        vm.warp(block.timestamp + 17 minutes);
        uint256 dueAt = block.timestamp + 30 days;
        vm.expectEmit(true, false, false, true, address(market));
        emit OfferAccepted(id, dueAt, dueAt + 1 days);
        vm.prank(borrower);
        market.acceptOffer(id);
        assertEq(_offer(id).dueAt, dueAt);
        assertEq(market.repaymentDeadline(id), dueAt + 1 days);
    }

    function testThirdPartyRepaymentReportsPayerAndBothCorrectCreditOwners() public {
        uint256 id = _active();
        vm.expectEmit(true, true, false, true, address(market));
        emit CreditAdded(address(usd), lender, PRINCIPAL + INTEREST);
        vm.expectEmit(true, true, false, true, address(market));
        emit CreditAdded(address(slv), borrower, COLLATERAL);
        vm.expectEmit(true, true, false, true, address(market));
        emit LoanRepaid(id, thirdParty, PRINCIPAL + INTEREST);
        vm.prank(thirdParty);
        market.repay(id);
        assertEq(market.credits(address(usd), thirdParty), 0);
        assertEq(market.credits(address(slv), thirdParty), 0);
    }

    function testPermissionlessDefaultReportsOnlyLenderCollateralCredit() public {
        uint256 id = _active();
        vm.warp(market.repaymentDeadline(id) + 1);
        vm.expectEmit(true, true, false, true, address(market));
        emit CreditAdded(address(slv), lender, COLLATERAL);
        vm.expectEmit(true, false, false, true, address(market));
        emit LoanDefaulted(id);
        vm.prank(thirdParty);
        market.claimDefault(id);
        assertEq(market.credits(address(usd), lender), 0);
        assertEq(market.credits(address(slv), thirdParty), 0);
    }

    function testCancellationReportsLenderRefundAndCancelledStatus() public {
        uint256 id = _create();
        vm.expectEmit(true, true, false, true, address(market));
        emit CreditAdded(address(usd), lender, PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(market));
        emit OfferClosed(id, TurretP2PLendingV2.Status.Cancelled);
        vm.prank(lender);
        market.cancelOffer(id);
    }

    function testPermissionlessExpiryReportsLenderRefundAndExpiredStatus() public {
        uint256 id = _create();
        vm.warp(_offer(id).expiresAt);
        vm.expectEmit(true, true, false, true, address(market));
        emit CreditAdded(address(usd), lender, PRINCIPAL);
        vm.expectEmit(true, false, false, true, address(market));
        emit OfferClosed(id, TurretP2PLendingV2.Status.Expired);
        vm.prank(thirdParty);
        market.expireOffer(id);
        assertEq(market.credits(address(usd), thirdParty), 0);
    }

    function testAlternateRecipientReceivesExactPartialWithdrawalsAndReportedOwnerIsCreditor() public {
        uint256 id = _active();
        vm.prank(thirdParty);
        market.repay(id);
        address recipient = address(0xBEEF);
        uint256 usdAmount = 7e6;
        uint256 collateralAmount = 3e18;
        uint256 recipientUsd = usd.balanceOf(recipient);
        uint256 recipientCollateral = slv.balanceOf(recipient);
        uint256 lenderUsd = usd.balanceOf(lender);
        uint256 borrowerCollateral = slv.balanceOf(borrower);
        uint256 escrowUsd = usd.balanceOf(address(market));
        uint256 escrowCollateral = slv.balanceOf(address(market));

        vm.expectEmit(true, true, true, true, address(market));
        emit Withdrawn(address(usd), lender, recipient, usdAmount);
        vm.prank(lender);
        market.withdraw(usd, usdAmount, recipient);
        assertEq(usd.balanceOf(recipient), recipientUsd + usdAmount);
        assertEq(usd.balanceOf(lender), lenderUsd);
        assertEq(usd.balanceOf(address(market)), escrowUsd - usdAmount);
        assertEq(market.credits(address(usd), lender), PRINCIPAL + INTEREST - usdAmount);
        assertEq(market.totalCredits(address(usd)), PRINCIPAL + INTEREST - usdAmount);

        vm.expectEmit(true, true, true, true, address(market));
        emit Withdrawn(address(slv), borrower, recipient, collateralAmount);
        vm.prank(borrower);
        market.withdraw(slv, collateralAmount, recipient);
        assertEq(slv.balanceOf(recipient), recipientCollateral + collateralAmount);
        assertEq(slv.balanceOf(borrower), borrowerCollateral);
        assertEq(slv.balanceOf(address(market)), escrowCollateral - collateralAmount);
        assertEq(market.credits(address(slv), borrower), COLLATERAL - collateralAmount);
        assertEq(market.totalCredits(address(slv)), COLLATERAL - collateralAmount);
        assertEq(market.credits(address(usd), recipient), 0);
        assertEq(market.credits(address(slv), recipient), 0);
        _assertSolvent();
    }
}
