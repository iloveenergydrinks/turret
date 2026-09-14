// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretP2PLendingV3} from "../src/TurretP2PLendingV3.sol";

/// @dev Exact mainnet token code and existing balances, pinned to one block.
/// No minting, deal(), token storage edits, broadcasts, or production signatures.
/// Existing holders are impersonated only in the local fork and transfer tokens
/// into fresh local lender/borrower accounts before each lifecycle test.
contract RealTokenV3ForkTest is Test {
    IERC20 cash = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address[] assets;
    address[] holders;
    uint256[] amounts;
    address cashHolder;
    address lender;
    address borrower;
    address otherBorrower;
    uint256 constant PRINCIPAL = 123e6;
    uint256 constant INTEREST = 25e6;

    function setUp() public {
        vm.createSelectFork(vm.envString("P2P_FORK_RPC"), vm.envUint("P2P_FORK_BLOCK"));
        assertEq(block.chainid, 4663);
        assets = vm.envAddress("P2P_FORK_ASSETS", ",");
        holders = vm.envAddress("P2P_FORK_HOLDERS", ",");
        amounts = vm.envUint("P2P_FORK_AMOUNTS", ",");
        cashHolder = vm.envAddress("P2P_FORK_CASH_HOLDER");
        assertEq(assets.length, 19);
        assertEq(holders.length, 19);
        assertEq(amounts.length, 19);
        lender = makeAddr("V3 real-token lender");
        borrower = makeAddr("V3 real-token borrower");
        otherBorrower = makeAddr("V3 competing borrower");
    }

    function testAAPLActualEscrowLifecycle() public { _exerciseAsset(0); }
    function testMSFTActualEscrowLifecycle() public { _exerciseAsset(1); }
    function testGOOGLActualEscrowLifecycle() public { _exerciseAsset(2); }
    function testAMZNActualEscrowLifecycle() public { _exerciseAsset(3); }
    function testMETAActualEscrowLifecycle() public { _exerciseAsset(4); }
    function testNVDAActualEscrowLifecycle() public { _exerciseAsset(5); }
    function testAMDActualEscrowLifecycle() public { _exerciseAsset(6); }
    function testMUActualEscrowLifecycle() public { _exerciseAsset(7); }
    function testTSLAActualEscrowLifecycle() public { _exerciseAsset(8); }
    function testSLVActualEscrowLifecycle() public { _exerciseAsset(9); }
    function testCASHCATActualEscrowLifecycle() public { _exerciseAsset(10); }
    function testPONSActualEscrowLifecycle() public { _exerciseAsset(11); }

    function testSPYActualEscrowLifecycle() public { _exerciseAsset(12); }
    function testQQQActualEscrowLifecycle() public { _exerciseAsset(13); }
    function testGLDActualEscrowLifecycle() public { _exerciseAsset(14); }
    function testCOINActualEscrowLifecycle() public { _exerciseAsset(15); }
    function testPLTRActualEscrowLifecycle() public { _exerciseAsset(16); }
    function testNFLXActualEscrowLifecycle() public { _exerciseAsset(17); }
    function testINDEXActualEscrowLifecycle() public { _exerciseAsset(18); }

    function _transferExisting(IERC20 token, address from, address to, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(from);
        uint256 recipientBefore = token.balanceOf(to);
        assertGe(senderBefore, amount, "Actual existing holder balance required");
        vm.prank(from);
        assertTrue(token.transfer(to, amount));
        assertEq(token.balanceOf(from), senderBefore - amount, "Sender must debit exact units");
        assertEq(token.balanceOf(to), recipientBefore + amount, "Recipient must receive exact units");
    }

    function _create(TurretP2PLendingV3 market, uint256 amount) private returns (uint256 id) {
        vm.startPrank(lender);
        assertTrue(cash.approve(address(market), PRINCIPAL));
        id = market.createOffer(address(0), PRINCIPAL, amount, INTEREST, 31 days, block.timestamp + 2 days);
        vm.stopPrank();
        assertEq(market.reservedPrincipal(), PRINCIPAL);
        assertTrue(market.isPublicOffer(id));
    }

    function _accept(TurretP2PLendingV3 market, IERC20 collateral, uint256 id, uint256 amount) private {
        uint256 beforeCash = cash.balanceOf(borrower);
        uint256 beforeCollateral = collateral.balanceOf(borrower);
        vm.prank(lender);
        vm.expectRevert(TurretP2PLendingV3.Unauthorized.selector);
        market.acceptOffer(id);
        vm.startPrank(borrower);
        assertTrue(collateral.approve(address(market), amount));
        market.acceptOffer(id);
        vm.stopPrank();
        assertEq(cash.balanceOf(borrower), beforeCash + PRINCIPAL);
        assertEq(collateral.balanceOf(borrower), beforeCollateral - amount);
        assertEq(collateral.balanceOf(market.vaults(id)), amount);
        assertEq(collateral.balanceOf(address(market)), 0);
        assertEq(market.reservedPrincipal(), 0);
        (, address boundBorrower,,,,,, uint256 dueAt, TurretP2PLendingV3.Status status) = market.offers(id);
        assertEq(boundBorrower, borrower);
        assertEq(dueAt, block.timestamp + 31 days);
        assertEq(uint256(status), uint256(TurretP2PLendingV3.Status.Active));
        uint256 otherBefore = collateral.balanceOf(otherBorrower);
        vm.prank(otherBorrower);
        vm.expectRevert(TurretP2PLendingV3.WrongStatus.selector);
        market.acceptOffer(id);
        assertEq(collateral.balanceOf(otherBorrower), otherBefore, "Losing acceptance must not move collateral");
    }

    function _exerciseAsset(uint256 index) private {
        IERC20 collateral = IERC20(assets[index]);
        uint256 amount = amounts[index];
        assertGt(amount, 0);
        _transferExisting(cash, cashHolder, lender, 500e6);
        _transferExisting(cash, cashHolder, borrower, INTEREST);
        _transferExisting(collateral, holders[index], borrower, amount);
        TurretP2PLendingV3 market = new TurretP2PLendingV3(cash, collateral, address(this));

        // Open funded offer, cancellation credit, and explicit cash withdrawal.
        uint256 lenderBefore = cash.balanceOf(lender);
        uint256 id = _create(market, amount);
        vm.prank(lender); market.cancelOffer(id);
        assertEq(cash.balanceOf(lender), lenderBefore - PRINCIPAL);
        assertEq(market.credits(address(cash), lender), PRINCIPAL);
        vm.prank(lender); market.withdrawCredit(id, cash, PRINCIPAL, lender);
        assertEq(cash.balanceOf(lender), lenderBefore);

        // Public acceptance and full fixed-interest repayment exactly at final deadline.
        id = _create(market, amount);
        _accept(market, collateral, id, amount);
        uint256 oldDeadline = market.repaymentDeadline(id);
        uint256 newDeadline = oldDeadline + 7 days;
        vm.prank(borrower); market.proposeExtension(id, newDeadline, oldDeadline);
        vm.prank(lender); market.acceptExtension(id, 1, oldDeadline, newDeadline, oldDeadline);
        assertEq(market.repaymentDeadline(id), newDeadline);
        // An owned cancelled offer funds the principal leg; wallet supplies fixed interest.
        vm.startPrank(borrower);
        cash.approve(address(market), PRINCIPAL);
        uint256 creditId = market.createOffer(address(0), PRINCIPAL, amount, 0, 1 days, block.timestamp + 1 hours);
        market.cancelOffer(creditId);
        vm.stopPrank();
        uint256[] memory sourceIds = new uint256[](1); sourceIds[0] = creditId;
        uint256[] memory sourceAmounts = new uint256[](1); sourceAmounts[0] = PRINCIPAL;
        vm.warp(newDeadline);
        market.setNewLoansPaused(true);
        vm.startPrank(borrower);
        assertTrue(cash.approve(address(market), PRINCIPAL + INTEREST));
        market.repayWithCredits(id, sourceIds, sourceAmounts, INTEREST);
        assertEq(cash.balanceOf(market.vaults(creditId)), 0);
        assertEq(collateral.balanceOf(borrower), 0, "Settlement must not pretend withdrawal occurred");
        assertEq(market.credits(address(collateral), borrower), amount);
        market.withdrawCredit(id, collateral, amount, borrower);
        vm.stopPrank();
        vm.prank(lender); market.withdrawCredit(id, cash, PRINCIPAL + INTEREST, lender);
        assertEq(cash.balanceOf(lender), lenderBefore + INTEREST);
        assertEq(collateral.balanceOf(borrower), amount);
        assertEq(market.committedPrincipal(), 0);
        assertEq(collateral.balanceOf(address(market)), 0);
        assertEq(cash.balanceOf(address(market)), 0);

        // Default releases exact collateral units to the lender, with no oracle or swap.
        market.setNewLoansPaused(false);
        id = _create(market, amount);
        _accept(market, collateral, id, amount);
        vm.warp(market.repaymentDeadline(id) + 1);
        market.setNewLoansPaused(true);
        market.claimDefault(id);
        assertEq(market.credits(address(collateral), lender), amount);
        uint256 beforeLenderCollateral = collateral.balanceOf(lender);
        vm.prank(lender); market.withdrawCredit(id, collateral, amount, lender);
        assertEq(collateral.balanceOf(lender), beforeLenderCollateral + amount);
        assertEq(collateral.balanceOf(address(market)), 0);
        assertEq(market.committedPrincipal(), 0);

        // Expiry returns cash credit only to the lender, even when a third party settles.
        market.setNewLoansPaused(false);
        lenderBefore = cash.balanceOf(lender);
        id = _create(market, amount);
        vm.warp(block.timestamp + 2 days);
        vm.prank(otherBorrower); market.expireOffer(id);
        assertEq(market.credits(address(cash), lender), PRINCIPAL);
        assertEq(market.credits(address(cash), otherBorrower), 0);
        vm.prank(lender); market.withdrawCredit(id, cash, PRINCIPAL, lender);
        assertEq(cash.balanceOf(lender), lenderBefore);
        assertEq(market.totalCredits(address(cash)), 0);
        assertEq(market.totalCredits(address(collateral)), 0);
        assertEq(market.lockedCollateral(), 0);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(market.committedPrincipal(), 0);
        assertEq(cash.balanceOf(address(market)), 0);
        assertEq(collateral.balanceOf(address(market)), 0);
        for (uint256 n = 1; n < market.nextOfferId(); ++n) {
            assertEq(cash.balanceOf(market.vaults(n)), 0);
            assertEq(collateral.balanceOf(market.vaults(n)), 0);
        }
    }
}
