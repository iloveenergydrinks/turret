// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretLenderRewards} from "../src/TurretLenderRewards.sol";
contract TestToken is ERC20 {
    bool public failTransfers;
    constructor(string memory n) ERC20(n,n) {}
    function mint(address to,uint256 amount) external { _mint(to,amount); }
    function setFail(bool f) external { failTransfers=f; }
    function _beforeTokenTransfer(address a,address b,uint256 v) internal override { require(!failTransfers,"transfer disabled");super._beforeTokenTransfer(a,b,v); }
}
contract TurretLenderRewardsTest is Test {
    TestToken shares; TestToken token; TurretLenderRewards rewards;
    address alice=address(0xA11CE);address bob=address(0xB0B);
    function setUp() public {
        vm.warp(1000);shares=new TestToken("shares");token=new TestToken("TURRET");
        rewards=new TurretLenderRewards(shares,token,address(this),20_000_000e18);
        token.mint(address(this),20_000_000e18);token.approve(address(rewards),type(uint256).max);
        shares.mint(alice,1000e18);shares.mint(bob,1000e18);
        vm.prank(alice);shares.approve(address(rewards),type(uint256).max);
        vm.prank(bob);shares.approve(address(rewards),type(uint256).max);
    }
    function fund(uint256 amount) internal {rewards.fundCampaign(amount,1000,1100);}
    function stake(address who,uint256 amount) internal {vm.prank(who);rewards.stake(amount);}
    function testStaggeredStakeAndRepeatedClaims() public {
        fund(1000e18);stake(alice,100e18);vm.warp(1050);stake(bob,100e18);vm.warp(1100);
        assertEq(rewards.earned(alice),750e18);assertEq(rewards.earned(bob),250e18);
        vm.startPrank(alice);rewards.claim();rewards.claim();rewards.unstake(100e18);vm.stopPrank();
        vm.prank(bob);rewards.claim();assertEq(token.balanceOf(alice),750e18);
        assertEq(rewards.totalClaimed(),1000e18);assertEq(rewards.reserved(),0);assertEq(shares.balanceOf(alice),1000e18);
    }
    function testNoStakeIntervalCannotBeCaptured() public {
        fund(1000e18);vm.warp(1050);stake(alice,100e18);vm.warp(1100);
        assertEq(rewards.earned(alice),500e18);rewards.recoverUnallocated();
        assertEq(token.balanceOf(address(rewards)),500e18);vm.prank(alice);rewards.claim();
        assertEq(token.balanceOf(alice),500e18);
    }
    function testStopPreservesEarnedAndReturnsOnlyUnearned() public {
        fund(1000e18);stake(alice,100e18);vm.warp(1050);rewards.stopCampaign();
        vm.warp(1200);assertEq(rewards.earned(alice),500e18);rewards.recoverUnallocated();
        assertEq(token.balanceOf(address(rewards)),500e18);vm.prank(alice);rewards.claim();
    }
    function testRewardFailureCannotTrapSharesOrEraseClaim() public {
        fund(1000e18);stake(alice,100e18);vm.warp(1050);token.setFail(true);
        vm.prank(alice);vm.expectRevert();rewards.claim();assertEq(rewards.earned(alice),500e18);
        vm.prank(alice);rewards.unstake(100e18);assertEq(shares.balanceOf(alice),1000e18);
        token.setFail(false);vm.prank(alice);rewards.claim();assertEq(token.balanceOf(alice),500e18);
    }
    function testLaterCampaignKeepsOldClaims() public {
        fund(1000e18);stake(alice,100e18);vm.warp(1100);
        rewards.fundCampaign(500e18,1100,1200);vm.warp(1200);
        assertEq(rewards.earned(alice),1500e18);vm.prank(alice);rewards.claim();assertEq(rewards.totalClaimed(),1500e18);
    }
    function testNoRetroactiveRewardsOrSameBlockFarm() public {
        fund(1000e18);vm.warp(1050);stake(alice,100e18);vm.prank(alice);rewards.unstake(100e18);
        assertEq(rewards.earned(alice),0);vm.warp(1100);stake(bob,100e18);assertEq(rewards.earned(bob),0);
    }
    function testFundingLimitsAndAccessControl() public {
        vm.prank(alice);vm.expectRevert(TurretLenderRewards.Unauthorized.selector);rewards.fundCampaign(1,1000,1100);
        vm.expectRevert(TurretLenderRewards.InvalidCampaign.selector);rewards.fundCampaign(20_000_001e18,1000,1100);
        fund(1000e18);vm.expectRevert(TurretLenderRewards.InvalidCampaign.selector);rewards.fundCampaign(1,1000,1100);
        vm.prank(alice);vm.expectRevert(TurretLenderRewards.Unauthorized.selector);rewards.stopCampaign();
    }
    function testPendingCampaignCannotPayEarly() public {
        rewards.fundCampaign(1000e18,1050,1150);stake(alice,100e18);vm.warp(1049);assertEq(rewards.earned(alice),0);
        rewards.stopCampaign();rewards.recoverUnallocated();assertEq(token.balanceOf(address(rewards)),0);
        vm.prank(alice);rewards.unstake(100e18);
    }
    function testFuzzSolvencyAndShareBacking(uint128 a,uint128 b,uint64 when,uint128 budget) public {
        uint256 x=bound(a,1,1000e18);uint256 y=bound(b,1,1000e18);uint256 t=bound(when,1000,1100);uint256 r=bound(budget,1,20_000_000e18);
        fund(r);stake(alice,x);vm.warp(t);stake(bob,y);vm.warp(1100);
        assertLe(rewards.earned(alice)+rewards.earned(bob),r);
        vm.prank(alice);rewards.claim();vm.prank(bob);rewards.claim();rewards.recoverUnallocated();
        assertLe(rewards.totalClaimed(),rewards.totalFunded());assertGe(token.balanceOf(address(rewards)),rewards.reserved());
        assertEq(shares.balanceOf(address(rewards)),rewards.totalStaked());
        vm.prank(alice);rewards.unstake(x);vm.prank(bob);rewards.unstake(y);assertEq(rewards.totalStaked(),0);
    }
}
