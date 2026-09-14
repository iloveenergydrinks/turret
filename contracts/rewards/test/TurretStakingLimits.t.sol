// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {TurretStaking} from "../src/TurretStaking.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";

contract TurretStakingLimitsTest is Test {
    StakingTokenFixture token;
    StakingTokenFixture usdg;
    TurretStaking staking;
    function setUp() public {
        token = new StakingTokenFixture("TURRET"); usdg = new StakingTokenFixture("USDG");
        staking = new TurretStaking(token, usdg, address(this));
        token.mint(address(this), uint256(type(uint128).max) + 1);
        usdg.mint(address(this), uint256(type(uint128).max) + 1);
        token.approve(address(staking), type(uint256).max);
        usdg.approve(address(staking), type(uint256).max);
    }
    function testMaximumLifetimeFundingWithOneBaseUnitStakeRemainsClaimable() public {
        staking.stake(1);
        staking.distribute(type(uint128).max);
        assertEq(staking.earned(address(this)), type(uint128).max);
        vm.expectRevert(TurretStaking.InvalidAmount.selector); staking.distribute(1);
        staking.claim();
        assertEq(staking.totalClaimed(), type(uint128).max);
        vm.roll(block.number + 1); staking.unstake(1);
        assertEq(staking.totalStaked(), 0);
    }
    function testMaximumStakeRemainsWithdrawableAfterIndexGrowsAtMinimumStake() public {
        staking.stake(1); staking.distribute(type(uint128).max);
        vm.roll(block.number + 1); staking.unstake(1);
        staking.stake(type(uint128).max);
        vm.expectRevert(TurretStaking.InvalidAmount.selector); staking.stake(1);
        staking.claim();
        assertEq(usdg.balanceOf(address(this)), uint256(type(uint128).max) + 1);
        vm.roll(block.number + 1); staking.unstake(type(uint128).max);
        assertEq(token.balanceOf(address(this)), uint256(type(uint128).max) + 1);
    }
    function testZeroActionsCannotResetAnotherUsersDelayOrMoveFunds() public {
        staking.stake(1); vm.roll(block.number + 1);
        vm.expectRevert(TurretStaking.InvalidAmount.selector); staking.stake(0);
        vm.expectRevert(TurretStaking.InvalidAmount.selector); staking.unstake(0);
        assertTrue(staking.canUnstake(address(this)));
        staking.claim(); assertEq(staking.totalClaimed(), 0);
    }
}
