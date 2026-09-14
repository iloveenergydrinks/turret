// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";
import {TurretStreamingStaking} from "../src/TurretStreamingStaking.sol";

contract StreamingSequenceHandler is Test {
    StakingTokenFixture public token;
    StakingTokenFixture public usdg;
    TurretStreamingStaking public staking;
    address[4] public users = [address(101), address(102), address(103), address(104)];
    mapping(address => uint256) public creditRay;
    uint256 public referenceReleasedRay;
    uint256 public donations;
    constructor() {
        token = new StakingTokenFixture("TURRET"); usdg = new StakingTokenFixture("USDG");
        staking = new TurretStreamingStaking(token, usdg, address(this));
        usdg.mint(address(this), 1e24); usdg.approve(address(staking), type(uint256).max);
        for (uint256 i; i < 4; ++i) { token.mint(users[i], 1_000e18); vm.prank(users[i]); token.approve(address(staking), type(uint256).max); }
    }
    // Independent direct entitlement ledger, with no global reward index or account checkpoints.
    // Separate Decimal-generated golden cases validate the decay function itself.
    function checkpointReference() public {
        uint256 released = staking.totalFunded() * 1e27 - staking.reserveRay();
        uint256 emission = released - referenceReleasedRay;
        uint256 supply = staking.totalStaked();
        if (supply != 0) for (uint256 i; i < 4; ++i) creditRay[users[i]] += emission * staking.stakedBalance(users[i]) / supply;
        else assertEq(emission, 0);
        referenceReleasedRay = released;
    }
    function stake(uint8 who, uint96 amount) external {
        checkpointReference(); address user = users[who % 4]; uint256 balance = token.balanceOf(user);
        if (balance == 0) return; vm.prank(user); staking.stake(bound(amount, 1, balance));
    }
    function unstake(uint8 who, uint96 amount) external {
        checkpointReference(); address user = users[who % 4]; uint256 balance = staking.stakedBalance(user);
        if (balance == 0) return; vm.roll(block.number + 1); vm.prank(user); staking.unstake(bound(amount, 1, balance));
    }
    function fund(uint64 amount) external { checkpointReference(); staking.distribute(bound(amount, 1, 100e6)); }
    function claim(uint8 who) external { checkpointReference(); vm.prank(users[who % 4]); staking.claim(); }
    function passTime(uint32 secondsElapsed) external { vm.warp(block.timestamp + bound(secondsElapsed, 1, 30 days)); checkpointReference(); }
    function donate(uint64 amount) external { checkpointReference(); uint256 value = bound(amount, 1, 100e6); donations += value; usdg.transfer(address(staking), value); }
}
contract TurretStreamingStakingInvariantTest is StdInvariant, Test {
    StreamingSequenceHandler handler;
    function setUp() public {
        handler = new StreamingSequenceHandler();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.stake.selector; selectors[1] = handler.unstake.selector;
        selectors[2] = handler.fund.selector; selectors[3] = handler.claim.selector;
        selectors[4] = handler.passTime.selector; selectors[5] = handler.donate.selector;
        targetSelector(FuzzSelector({addr:address(handler), selectors:selectors})); targetContract(address(handler));
    }
    function invariantStakeAndClaimsMatchIndependentEntitlementLedger() public view {
        TurretStreamingStaking s = handler.staking(); uint256 supply; uint256 earnedSum;
        for (uint256 i; i < 4; ++i) {
            address user = handler.users(i); supply += s.stakedBalance(user); earnedSum += s.earned(user);
            assertEq(handler.token().balanceOf(user) + s.stakedBalance(user), 1_000e18);
            uint256 actual = s.earned(user) + handler.usdg().balanceOf(user);
            uint256 expected = handler.creditRay(user) / 1e27;
            assertLe(actual, expected); assertLe(expected - actual, 1);
        }
        assertEq(supply, s.totalStaked()); assertEq(handler.token().balanceOf(address(s)), supply);
        assertLe(earnedSum + s.totalClaimed(), s.totalReleased());
        assertLe(s.totalReleased(), s.totalFunded());
        assertEq(handler.usdg().balanceOf(address(s)) + s.totalClaimed(), s.totalFunded() + handler.donations());
    }
}
