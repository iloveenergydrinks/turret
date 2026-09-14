// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";
import {TurretStreamingStaking} from "../src/TurretStreamingStaking.sol";
contract TurretStreamingStakingTest is Test {
    StakingTokenFixture token;
    StakingTokenFixture usdg;
    TurretStreamingStaking staking;
    address alice = address(101);
    address bob = address(102);
    function setUp() public {
        token = new StakingTokenFixture("TURRET"); usdg = new StakingTokenFixture("USDG");
        staking = new TurretStreamingStaking(token, usdg, address(this));
        for (uint256 i; i < 2; ++i) {
            address user = i == 0 ? alice : bob;
            token.mint(user, 1_000e18);
            vm.prank(user); token.approve(address(staking), type(uint256).max);
        }
        usdg.mint(address(this), 1_000_000e6); usdg.approve(address(staking), type(uint256).max);
    }
    function testFundingDoesNotPayOutImmediately() public {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(1_000e6);
        assertEq(staking.earned(alice), 0, "funding is a reserve, not an immediate payout");
        vm.prank(alice); staking.claim();
        assertEq(usdg.balanceOf(alice), 0);
    }
    function seed() internal {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(1_000e6);
    }
    function testOnePercentOfRemainingReserveEachDay() public {
        seed();
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(alice), 10e6, 1);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(alice), 19_900_000, 1);
        vm.warp(block.timestamp + 5 days);
        assertApproxEqAbs(staking.earned(alice), 67_934_652, 1);
        assertEq(staking.totalFunded(), 1_000e6);
    }
    function testFundingWhileEmptyAndEmptyIntervalsDoNotAccrue() public {
        staking.distribute(1_000e6);
        vm.warp(block.timestamp + 365 days);
        assertEq(staking.totalReleased(), 0);
        vm.prank(alice); staking.stake(100e18);
        assertEq(staking.earned(alice), 0);
        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(100e18);
        uint256 owed = staking.earned(alice); uint256 reserve = staking.reserveRay();
        vm.warp(block.timestamp + 365 days);
        assertEq(staking.earned(alice), owed); assertEq(staking.reserveRay(), reserve);
        vm.prank(bob); staking.stake(100e18);
        assertEq(staking.earned(bob), 0);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(bob), 9_900_000, 1);
        assertEq(staking.earned(alice), owed);
    }
    function testLateStakerCannotCapturePreviouslyAccruedRewards() public {
        seed(); vm.warp(block.timestamp + 1 days);
        vm.prank(bob); staking.stake(100e18);
        assertEq(staking.earned(bob), 0);
        assertApproxEqAbs(staking.earned(alice), 10e6, 1);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(alice), 14_950_000, 1);
        assertApproxEqAbs(staking.earned(bob), 4_950_000, 1);
    }
    function testTopUpIncreasesFutureRateWithoutAllocatingPrincipal() public {
        seed(); vm.warp(block.timestamp + 1 days);
        uint256 owed = staking.earned(alice);
        staking.distribute(1_000e6);
        assertEq(staking.earned(alice), owed);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(alice), 29_900_000, 1);
    }
    function testFrequentClaimsDoNotChangeEmissionOrLoseFractionalRewards() public {
        seed();
        TurretStreamingStaking untouched = new TurretStreamingStaking(token, usdg, address(this));
        vm.startPrank(alice); token.approve(address(untouched), type(uint256).max); untouched.stake(100e18); vm.stopPrank();
        usdg.approve(address(untouched), type(uint256).max); untouched.distribute(1_000e6);
        uint256 start = block.timestamp;
        for (uint256 i = 1; i <= 1440; ++i) { vm.warp(start + i * 60); vm.prank(alice); staking.claim(); }
        assertEq(staking.reserveRay(), untouched.reserveRay());
        assertEq(usdg.balanceOf(alice) + staking.earned(alice), untouched.earned(alice));
    }
    function testZeroStakeAccountCannotGriefGlobalAccrual() public {
        seed(); uint256 start = block.timestamp;
        for (uint256 i = 1; i <= 100; ++i) { vm.warp(start + i * 864); vm.prank(bob); staking.claim(); }
        assertApproxEqAbs(staking.earned(alice), 10e6, 1);
        assertEq(staking.earned(bob), 0);
    }
    function testDonationDoesNotChangeRewardsOrReserve() public {
        seed(); uint256 reserve = staking.reserveRay();
        usdg.transfer(address(staking), 1_000e6);
        assertEq(staking.reserveRay(), reserve);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.earned(alice), 10e6, 1);
    }
    function testSameTimestampExitCannotEarnFundingAndDelayStillApplies() public {
        seed(); vm.prank(alice); vm.expectRevert(TurretStreamingStaking.WaitOneBlock.selector); staking.unstake(100e18);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(100e18);
        assertEq(staking.earned(alice), 0);
        assertEq(staking.reserveRay(), 1_000e6 * staking.RAY());
    }
    function testFuzzClaimsCannotExceedFundedReserve(uint64 secondsElapsed, uint96 funded) public {
        funded = uint96(bound(funded, 1, 1_000_000e6));
        vm.prank(alice); staking.stake(100e18); staking.distribute(funded);
        vm.warp(block.timestamp + bound(secondsElapsed, 0, 1000 * 365 days));
        vm.prank(alice); staking.claim();
        assertLe(usdg.balanceOf(alice), funded);
        assertEq(usdg.balanceOf(address(staking)) + staking.totalClaimed(), funded);
        assertLe(staking.totalReleased(), funded);
    }
    function testMaximumLifetimeFundingAndTinyStakeRemainClaimable() public {
        usdg.mint(address(this), type(uint128).max);
        vm.prank(alice); staking.stake(1);
        staking.distribute(type(uint128).max);
        vm.warp(block.timestamp + 1000 * 365 days);
        vm.prank(alice); staking.claim();
        assertEq(usdg.balanceOf(alice), type(uint128).max);
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(1);
    }
    function testIndependentDecimalDecayReference() public {
        vm.prank(alice); staking.stake(100e18); staking.distribute(1_000_000e6);
        uint256 start = block.timestamp;
        uint256[12] memory secondsElapsed = [uint256(1), 37, 1234, 3600, 43200, 86400, 172800, 604800, 2592000, 8640000, 31536000, 315360000];
        uint256[12] memory expected = [uint256(116323), 4303954, 143532689, 418676324, 5012562893, 10000000000, 19900000000, 67934652093, 260299626611, 633967658726, 974482035547, 999999999999];
        for (uint256 i; i < secondsElapsed.length; ++i) {
            vm.warp(start + secondsElapsed[i]); assertApproxEqAbs(staking.earned(alice), expected[i], 1);
        }
    }
}
