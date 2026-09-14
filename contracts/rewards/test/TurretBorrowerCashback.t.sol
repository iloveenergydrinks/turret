// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretBorrowerCashback} from "../src/TurretBorrowerCashback.sol";

contract CashbackUSDG is ERC20 {
    bool public failTransfers;
    constructor() ERC20("Test USDG", "USDG") {}
    function setFailTransfers(bool value) external { failTransfers = value; }
    function _beforeTokenTransfer(address, address, uint256) internal view override { require(!failTransfers, "disabled"); }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract TurretBorrowerCashbackTest is Test {
    CashbackUSDG token;
    TurretBorrowerCashback campaign;
    address alice = address(0xA11CE);
    address engine = address(0xE001);

    function setUp() public {
        vm.warp(1000);
        token = new CashbackUSDG();
        campaign = new TurretBorrowerCashback(token, address(this), address(this), 1000, 2000, 3000, 4000);
        token.mint(address(this), 100e6);
        token.approve(address(campaign), 100e6);
    }

    function testFundedEnrollmentPaysBorrowerEvenWhenSomeoneElseClaims() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        vm.prank(address(0xB0B));
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        assertEq(token.balanceOf(alice), 4e6);
        assertEq(token.balanceOf(address(0xB0B)), 0);
        assertEq(campaign.claimed(alice, engine), 4e6);
        assertEq(campaign.totalClaimed(), 4e6);
        assertEq(campaign.remainingCommitment(), 6e6);
    }
    function testPausingEnrollmentPreservesFundedClaims() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        campaign.setEnrollmentPaused(true);
        vm.expectRevert(TurretBorrowerCashback.EnrollmentPaused.selector);
        campaign.enroll(address(0xB0B), engine, 10e6);
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        assertEq(token.balanceOf(alice), 4e6);
    }

    function testOnlyExpiredFundsCanReturnToTreasury() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        vm.warp(4000);
        vm.expectRevert(TurretBorrowerCashback.ClaimsStillOpen.selector);
        campaign.recoverExpired();
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        vm.warp(4001);
        vm.prank(alice);
        vm.expectRevert(TurretBorrowerCashback.Unauthorized.selector);
        campaign.recoverExpired();
        campaign.recoverExpired();
        assertEq(token.balanceOf(address(this)), 96e6);
        assertEq(token.balanceOf(alice), 4e6);
        vm.expectRevert(TurretBorrowerCashback.Expired.selector);
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
    }

    function testEnrollmentCannotOversubscribeFundingOrChangeAnAcceptedCap() public {
        vm.expectRevert(TurretBorrowerCashback.InsufficientFunding.selector);
        campaign.enroll(alice, engine, 1);
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 60e6);
        vm.expectRevert(TurretBorrowerCashback.InsufficientFunding.selector);
        campaign.enroll(address(0xB0B), engine, 41e6);
        campaign.enroll(address(0xB0B), engine, 40e6);
        vm.expectRevert(TurretBorrowerCashback.InvalidEnrollment.selector);
        campaign.enroll(alice, engine, 1e6);
        assertEq(campaign.totalCommitted(), 100e6);
    }

    function testCumulativeClaimsKeepOldRootsButNeverPayTwice() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 oldRoot = campaign.leaf(alice, engine, 4e6);
        bytes32 newRoot = campaign.leaf(alice, engine, 7e6);
        campaign.publish(oldRoot, 1, bytes32(uint256(123)));
        campaign.publish(newRoot, 2, bytes32(uint256(124)));
        campaign.claim(oldRoot, alice, engine, 4e6, new bytes32[](0));
        vm.expectRevert(TurretBorrowerCashback.InvalidAmount.selector);
        campaign.claim(oldRoot, alice, engine, 4e6, new bytes32[](0));
        campaign.claim(newRoot, alice, engine, 7e6, new bytes32[](0));
        assertEq(token.balanceOf(alice), 7e6);
        assertEq(campaign.remainingCommitment(), 3e6);
        vm.expectRevert(TurretBorrowerCashback.InvalidAmount.selector);
        campaign.claim(oldRoot, alice, engine, 4e6, new bytes32[](0));
    }

    function testOperatorRootCannotPayAboveReservedCap() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 root = campaign.leaf(alice, engine, 11e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        vm.expectRevert(TurretBorrowerCashback.InvalidAmount.selector);
        campaign.claim(root, alice, engine, 11e6, new bytes32[](0));
        assertEq(campaign.totalClaimed(), 0);
        assertEq(token.balanceOf(address(campaign)), 100e6);
    }

    function testClaimsCannotBeReplayedForAnotherBorrowerEngineOrChain() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        vm.expectRevert(TurretBorrowerCashback.InvalidProof.selector);
        campaign.claim(root, address(0xB0B), engine, 4e6, new bytes32[](0));
        vm.expectRevert(TurretBorrowerCashback.InvalidProof.selector);
        campaign.claim(root, alice, address(0xE002), 4e6, new bytes32[](0));
        vm.chainId(block.chainid + 1);
        vm.expectRevert(TurretBorrowerCashback.InvalidProof.selector);
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
    }

    function testTransferFailureKeepsClaimAvailable() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        token.setFailTransfers(true);
        vm.expectRevert();
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        assertEq(campaign.claimed(alice, engine), 0);
        token.setFailTransfers(false);
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        assertEq(token.balanceOf(alice), 4e6);
    }

    function testEnrollmentAndFundingCloseAtCampaignEndWhileClaimsRemainOpen() public {
        campaign.fund(100e6);
        campaign.enroll(alice, engine, 10e6);
        vm.warp(2000);
        vm.expectRevert(TurretBorrowerCashback.Expired.selector);
        campaign.enroll(address(0xB0B), engine, 1e6);
        vm.expectRevert(TurretBorrowerCashback.Expired.selector);
        campaign.fund(1);
        vm.warp(3500);
        bytes32 root = campaign.leaf(alice, engine, 4e6);
        campaign.publish(root, 1, bytes32(uint256(123)));
        campaign.claim(root, alice, engine, 4e6, new bytes32[](0));
        assertEq(token.balanceOf(alice), 4e6);
    }

    function testNonOperatorCannotEnrollPauseOrPublish() public {
        vm.startPrank(alice);
        vm.expectRevert(TurretBorrowerCashback.Unauthorized.selector);
        campaign.enroll(alice, engine, 1e6);
        vm.expectRevert(TurretBorrowerCashback.Unauthorized.selector);
        campaign.setEnrollmentPaused(true);
        vm.expectRevert(TurretBorrowerCashback.Unauthorized.selector);
        campaign.publish(bytes32(uint256(1)), 1, bytes32(uint256(123)));
        vm.stopPrank();
    }

    function testFuzzClaimCannotExceedCommittedFunds(uint96 cap, uint96 earned) public {
        cap = uint96(bound(cap, 1, 100e6));
        earned = uint96(bound(earned, 1, cap));
        campaign.fund(100e6);
        campaign.enroll(alice, engine, cap);
        bytes32 root = campaign.leaf(alice, engine, earned);
        campaign.publish(root, 1, bytes32(uint256(123)));
        campaign.claim(root, alice, engine, earned, new bytes32[](0));
        assertLe(campaign.totalClaimed(), campaign.totalCommitted());
        assertGe(token.balanceOf(address(campaign)), campaign.remainingCommitment());
    }

}
