// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretStaking} from "../src/TurretStaking.sol";

interface IWithdrawalEligibility { function canUnstake(address account) external view returns (bool); }

contract StakingTokenFixture is ERC20 {
    constructor(string memory name) ERC20(name, name) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract TurretStakingTest is Test {
    StakingTokenFixture token;
    StakingTokenFixture usdg;
    TurretStaking staking;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new StakingTokenFixture("TURRET");
        usdg = new StakingTokenFixture("USDG");
        staking = new TurretStaking(token, usdg, address(this));
        token.mint(alice, 1_000e18);
        token.mint(bob, 1_000e18);
        usdg.mint(address(this), 1_000e6);
        usdg.approve(address(staking), type(uint256).max);
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        vm.prank(bob); token.approve(address(staking), type(uint256).max);
    }

    function testWithdrawalEligibilityUsesTheContractsClockAndResetsOnTopUp() public {
        IWithdrawalEligibility eligibility = IWithdrawalEligibility(address(staking));
        assertFalse(eligibility.canUnstake(alice));
        vm.prank(alice); staking.stake(10e18);
        assertFalse(eligibility.canUnstake(alice));
        vm.roll(block.number + 1);
        assertTrue(eligibility.canUnstake(alice));
        vm.prank(alice); staking.stake(1e18);
        assertFalse(eligibility.canUnstake(alice));
        vm.roll(block.number + 1);
        vm.prank(alice); staking.unstake(11e18);
        assertFalse(eligibility.canUnstake(alice));
    }

    function testStakeEarnClaimAndWithdrawAfterOneBlock() public {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(5e6);
        assertEq(staking.earned(alice), 5e6);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(100e18);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(staking.earned(alice), 5e6);
        vm.prank(alice); staking.claim();
        assertEq(usdg.balanceOf(alice), 5e6);
        assertEq(staking.earned(alice), 0);
    }
    function testNewStakeCannotClaimEarlierDistributionAndPartialExitKeepsRewards() public {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(10e6);
        vm.prank(bob); staking.stake(100e18);
        assertEq(staking.earned(bob), 0);
        staking.distribute(20e6);
        assertEq(staking.earned(alice), 20e6);
        assertEq(staking.earned(bob), 10e6);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(50e18);
        staking.distribute(30e6);
        assertEq(staking.earned(alice), 30e6);
        assertEq(staking.earned(bob), 30e6);
        vm.prank(alice); staking.claim();
        vm.prank(alice); staking.claim();
        assertEq(usdg.balanceOf(alice), 30e6);
    }

    function testOnlyRouterCanAllocateFeesAndNoStakeLeavesFundsWithRouter() public {
        vm.expectRevert(TurretStaking.NoStakers.selector); staking.distribute(10e6);
        assertEq(usdg.balanceOf(address(this)), 1_000e6);
        vm.prank(alice); staking.stake(100e18);
        vm.prank(bob); vm.expectRevert(TurretStaking.Unauthorized.selector); staking.distribute(10e6);
        assertEq(staking.earned(alice), 0);
    }

    function testFractionalRewardsSurviveClaimsAndStakeChanges() public {
        vm.prank(alice); staking.stake(1e18);
        vm.prank(bob); staking.stake(1e18);
        staking.distribute(1); // Half a USDG base unit each.
        vm.prank(alice); staking.claim();
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(1e18);
        vm.prank(alice); staking.stake(1e18);
        staking.distribute(1);
        assertEq(staking.earned(alice), 1);
        assertEq(staking.earned(bob), 1);
    }

    function testDonationsDoNotBecomeClaimableByNextStaker() public {
        usdg.transfer(address(staking), 20e6);
        vm.prank(alice); staking.stake(1e18);
        assertEq(staking.earned(alice), 0);
        staking.distribute(5e6);
        assertEq(staking.earned(alice), 5e6);
    }

    function testFuzzAllClaimsAndExitsRemainBacked(uint96 a, uint96 b, uint64 first, uint64 second) public {
        uint256 aliceStake = bound(a, 1, 1_000e18);
        uint256 bobStake = bound(b, 1, 1_000e18);
        uint256 fee1 = bound(first, 1, 100e6);
        uint256 fee2 = bound(second, 1, 100e6);
        vm.prank(alice); staking.stake(aliceStake);
        staking.distribute(fee1);
        vm.prank(bob); staking.stake(bobStake);
        vm.prank(alice); staking.claim();
        staking.distribute(fee2);
        vm.roll(block.number + 1); vm.prank(bob); staking.unstake(bobStake);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(aliceStake);
        vm.prank(alice); staking.claim();
        vm.prank(bob); staking.claim();
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(token.balanceOf(bob), 1_000e18);
        assertEq(staking.totalStaked(), 0);
        assertLe(usdg.balanceOf(alice) + usdg.balanceOf(bob), fee1 + fee2);
        assertEq(usdg.balanceOf(address(staking)) + staking.totalClaimed(), staking.totalFunded());
    }

    function testSameBlockExitCannotCompleteAFlashLoanRoundTrip() public {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(5e6);
        vm.prank(alice); vm.expectRevert(TurretStaking.WaitOneBlock.selector); staking.unstake(100e18);
        vm.roll(block.number + 1);
        vm.prank(alice); staking.unstake(100e18);
        assertEq(token.balanceOf(alice), 1_000e18);
    }

}
