// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {V3TestBase, V3TestToken, TurretP2PLendingV3, TurretP2PVaultV3, IERC20} from "./V3TestSupport.sol";

contract V3CustodyTest is V3TestBase {
    event LoanCreditWithdrawn(uint256 indexed id, address indexed token, address indexed account,
        address recipient, uint256 amount, uint256 writtenOff);

    function testDistinctFixedClonesAndNoPublicVaultTransferAuthority() public {
        uint256 a = _create(LENDER, BORROWER, P);
        uint256 b = _create(PAYER, OTHER, P);
        address va = market.vaults(a); address vb = market.vaults(b);
        assertNotEq(va, vb); assertNotEq(va, market.vaultImplementation());
        assertEq(va.code.length, 45);
        assertEq(TurretP2PVaultV3(va).manager(), address(market));
        assertEq(address(TurretP2PVaultV3(va).loanToken()), address(usd));
        assertEq(address(TurretP2PVaultV3(vb).collateralToken()), address(collateral));
        address[4] memory callers = [LENDER, BORROWER, GUARDIAN, OTHER];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(TurretP2PVaultV3.Unauthorized.selector);
            vm.prank(callers[i]); TurretP2PVaultV3(va).transferTo(usd, callers[i], 1);
        }
        assertEq(usd.balanceOf(va), P); assertEq(usd.balanceOf(vb), P); _assertAccounting();
    }

    function testOpenLoanLossPreventsAcceptanceButDoesNotBlockFreshIsolatedFunding() public {
        uint256 a = _create(LENDER, BORROWER, P);
        usd.removeBalance(market.vaults(a), 60e6);
        uint256 b = _create(PAYER, OTHER, P);
        vm.expectRevert(TurretP2PLendingV3.InsufficientBacking.selector);
        vm.prank(BORROWER); market.acceptOffer(a);
        vm.prank(OTHER); market.acceptOffer(b);
        assertEq(usd.balanceOf(market.vaults(a)), 40e6);
        assertEq(collateral.balanceOf(market.vaults(a)), 0);
        assertEq(collateral.balanceOf(market.vaults(b)), C);
        vm.prank(LENDER); market.cancelOffer(a);
        _assertCredit(a, usd, LENDER, P, 40e6); _assertAccounting();
    }

    function testUnrelatedLenderCanWithdrawInFullWhileAnotherVaultHasLoss() public {
        uint256 a = _credit(LENDER, P);
        usd.removeBalance(market.vaults(a), 60e6);
        uint256 b = _credit(PAYER, 120e6);
        uint256 beforePayer = usd.balanceOf(PAYER);
        vm.prank(PAYER); market.withdrawCredit(b, usd, 120e6, PAYER);
        assertEq(usd.balanceOf(PAYER), beforePayer + 120e6);
        _assertCredit(a, usd, LENDER, P, 40e6);
        vm.expectEmit(true, true, true, true, address(market));
        emit LoanCreditWithdrawn(a, address(usd), LENDER, OTHER, 40e6, 60e6);
        vm.prank(LENDER); market.withdrawAvailableCredit(a, usd, 40e6, OTHER);
        _assertCredit(a, usd, LENDER, 0, 0); _assertAccounting();
    }

    function testPartialWithdrawalPreservesUnbackedFaceAndAllowsVoluntaryRestoration() public {
        uint256 id = _credit(LENDER, P);
        usd.removeBalance(market.vaults(id), 60e6);
        vm.prank(LENDER); market.withdrawCredit(id, usd, 40e6, OTHER);
        _assertCredit(id, usd, LENDER, 60e6, 0);
        usd.mint(market.vaults(id), 20e6);
        _assertCredit(id, usd, LENDER, 60e6, 20e6);
        vm.prank(LENDER); market.withdrawAvailableCredit(id, usd, 20e6, OTHER);
        _assertCredit(id, usd, LENDER, 0, 0); _assertAccounting();
    }

    function testLossAcceptanceMinimumAndFailedTransferPreserveEntireNominalClaim() public {
        uint256 id = _credit(LENDER, P);
        usd.removeBalance(market.vaults(id), 60e6);
        vm.expectRevert(TurretP2PLendingV3.InvalidWithdrawal.selector);
        vm.prank(LENDER); market.withdrawAvailableCredit(id, usd, 40e6 + 1, OTHER);
        usd.setReturnFalse(true);
        vm.expectRevert(); vm.prank(LENDER); market.withdrawAvailableCredit(id, usd, 40e6, OTHER);
        _assertCredit(id, usd, LENDER, P, 40e6); _assertAccounting();
    }

    function testZeroRecoveryRequiresExplicitZeroMinimumAndSkipsZeroTokenTransfer() public {
        uint256 id = _active();
        collateral.removeBalance(market.vaults(id), C);
        vm.warp(market.repaymentDeadline(id) + 1);
        market.claimDefault(id);
        vm.expectRevert(TurretP2PLendingV3.InvalidWithdrawal.selector);
        vm.prank(LENDER); market.withdrawAvailableCredit(id, collateral, 1, OTHER);
        collateral.setReturnFalse(true);
        vm.prank(LENDER); market.withdrawAvailableCredit(id, collateral, 0, OTHER);
        _assertCredit(id, collateral, LENDER, 0, 0); _assertAccounting();
    }

    function testCollateralLossDoesNotReduceAgreedRepaymentOrRedirectBorrowerClaim() public {
        uint256 id = _active();
        collateral.removeBalance(market.vaults(id), 10e18);
        uint256 before = usd.balanceOf(PAYER);
        vm.prank(PAYER); market.repay(id);
        assertEq(usd.balanceOf(PAYER), before - P - I);
        _assertCredit(id, usd, LENDER, P + I, P + I);
        _assertCredit(id, collateral, BORROWER, C, 30e18);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(PAYER); market.withdrawAvailableCredit(id, collateral, 0, PAYER);
        vm.prank(BORROWER); market.withdrawAvailableCredit(id, collateral, 30e18, OTHER);
        _assertAccounting();
    }

    function testDonationsCannotIncreaseFaceCreditOrBeTakenByGuardian() public {
        uint256 id = _credit(LENDER, P);
        usd.mint(market.vaults(id), 9e6);
        _assertCredit(id, usd, LENDER, P, P);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        vm.prank(GUARDIAN); market.withdrawAvailableCredit(id, usd, 0, GUARDIAN);
        vm.prank(LENDER); market.withdrawAvailableCredit(id, usd, P, LENDER);
        assertEq(usd.balanceOf(market.vaults(id)), 9e6);
        _assertCredit(id, usd, LENDER, 0, 0); _assertAccounting();
    }

    function testExactTransfersRejectRecipientFeeSenderFeeAndNoMovement() public {
        uint256 id = _credit(LENDER, P);
        for (uint256 mode; mode < 3; ++mode) {
            usd.setFee(mode == 0 ? 1 : 0); usd.setSenderFee(mode == 1 ? 1 : 0); usd.setSkipTransfer(mode == 2);
            vm.expectRevert(TurretP2PVaultV3.UnsupportedTransfer.selector);
            vm.prank(LENDER); market.withdrawCredit(id, usd, 1e6, OTHER);
            _assertCredit(id, usd, LENDER, P, P);
        }
        _assertAccounting();
    }

    function testFundingAndAcceptanceFailureDoNotPublishIdsOrActiveMembership() public {
        usd.setFee(1);
        vm.expectRevert(TurretP2PLendingV3.UnsupportedTransfer.selector);
        vm.prank(LENDER); market.createOffer(BORROWER, P, C, I, 10 days, block.timestamp + 1 days);
        assertEq(market.nextOfferId(), 1); assertEq(market.vaults(1), address(0));
        usd.setFee(0); uint256 id = _create(LENDER, BORROWER, P);
        collateral.setFee(1);
        vm.expectRevert(TurretP2PLendingV3.UnsupportedTransfer.selector);
        vm.prank(BORROWER); market.acceptOffer(id);
        _assertStatus(id, TurretP2PLendingV3.Status.Open);
        (uint256[] memory active,,) = market.getActiveLoanIds(BORROWER, 0, 50, 0);
        assertEq(active.length, 0); _assertAccounting();
    }

    function testFuzzLossRecoveryIsOrderIndependentAndPreservesAccounting(uint96 x, uint96 y, bool reverse) public {
        uint256 lossA = bound(x, 0, P); uint256 lossB = bound(y, 0, P);
        uint256 a = _credit(LENDER, P); uint256 b = _credit(PAYER, P);
        usd.removeBalance(market.vaults(a), lossA); usd.removeBalance(market.vaults(b), lossB);
        uint256 beforeA = usd.balanceOf(LENDER); uint256 beforeB = usd.balanceOf(PAYER);
        for (uint256 k; k < 2; ++k) {
            bool first = (k == 0) != reverse;
            vm.prank(first ? LENDER : PAYER);
            market.withdrawAvailableCredit(first ? a : b, usd, first ? P - lossA : P - lossB, first ? LENDER : PAYER);
            _assertAccounting();
        }
        assertEq(usd.balanceOf(LENDER) - beforeA, P - lossA);
        assertEq(usd.balanceOf(PAYER) - beforeB, P - lossB);
    }
}
