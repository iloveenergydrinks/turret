// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {CashbackUSDG} from "./TurretBorrowerCashback.t.sol";
import {TurretBorrowerCashback} from "../src/TurretBorrowerCashback.sol";
import {TurretPublicBorrowerCashback} from "../src/TurretPublicBorrowerCashback.sol";
contract TurretPublicBorrowerCashbackTest is Test {
    CashbackUSDG token;
    TurretPublicBorrowerCashback campaign;
    address alice=address(100);
    address a=address(101);
    address b=address(102);
    function setUp() public {
        vm.warp(1000); token=new CashbackUSDG(); vm.etch(a,hex"00"); vm.etch(b,hex"00");
        address[] memory engines=new address[](2);engines[0]=a;engines[1]=b;
        campaign=new TurretPublicBorrowerCashback(token,address(this),address(this),1000,2000,3000,4000,engines);
        token.mint(address(this),1001e6);token.approve(address(campaign),1001e6);campaign.fund(1000e6);
    }
    function testPublicJoinReservesOneCapAcrossEveryMarket() public {
        vm.prank(alice);campaign.join();assertTrue(campaign.joined(alice));assertEq(campaign.totalCommitted(),25e6);
        (uint256 capA,uint64 start)=campaign.enrollments(alice,a);(uint256 capB,)=campaign.enrollments(alice,b);
        assertEq(capA,25e6);assertEq(capB,25e6);assertEq(start,1000);
        vm.prank(alice);vm.expectRevert();campaign.join();
    }
    function testFortyReservationsExhaustBudgetEvenWithoutClaims() public {
        for(uint160 i=200;i<240;i++){vm.prank(address(i));campaign.join();}
        assertEq(campaign.totalCommitted(),1000e6);
        vm.prank(alice);vm.expectRevert(TurretBorrowerCashback.InsufficientFunding.selector);campaign.join();
        vm.expectRevert();campaign.fund(1);
    }
    function testOperatorCannotBypassPublicLimits() public {
        vm.expectRevert();campaign.enroll(alice,a,100e6);
        vm.expectRevert();campaign.join();
    }
    function award(address engine,uint256 amount) internal {
        bytes32 root=campaign.leaf(alice,engine,amount);campaign.publish(root,1,bytes32(uint256(1)));
        campaign.claim(root,alice,engine,amount,new bytes32[](0));
    }
    function testClaimsAcrossMarketsShareOneWalletCapAndRemainCumulative() public {
        vm.prank(alice);campaign.join();award(a,20e6);award(b,5e6);
        assertEq(token.balanceOf(alice),25e6);assertEq(campaign.walletClaimed(alice),25e6);
        bytes32 root=campaign.leaf(alice,b,6e6);campaign.publish(root,1,bytes32(uint256(1)));
        vm.expectRevert();campaign.claim(root,alice,b,6e6,new bytes32[](0));
        assertEq(campaign.claimed(alice,b),5e6);
    }
    function testPausedAndExpiredAdmissionDoesNotBlockEarnedClaims() public {
        vm.prank(alice);campaign.join();campaign.setEnrollmentPaused(true);
        vm.prank(address(200));vm.expectRevert();campaign.join();award(a,1e6);
        campaign.setEnrollmentPaused(false);vm.warp(2000);vm.prank(address(200));vm.expectRevert();campaign.join();
        award(a,2e6);assertEq(token.balanceOf(alice),2e6);
    }
    function testTransferFailureRestoresWalletAndMarketClaimLimits() public {
        vm.prank(alice);campaign.join();bytes32 root=campaign.leaf(alice,a,5e6);campaign.publish(root,1,bytes32(uint256(1)));
        token.setFailTransfers(true);vm.expectRevert();campaign.claim(root,alice,a,5e6,new bytes32[](0));
        assertEq(campaign.walletClaimed(alice),0);assertEq(campaign.claimed(alice,a),0);
        token.setFailTransfers(false);campaign.claim(root,alice,a,5e6,new bytes32[](0));assertEq(campaign.walletClaimed(alice),5e6);
    }
}
