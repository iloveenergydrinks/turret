// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {TurretStaking} from "../src/TurretStaking.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";

contract StakingSequenceHandler is Test {
    StakingTokenFixture public token;
    StakingTokenFixture public usdg;
    TurretStaking public staking;
    // Independent per-distribution ledger: no reward index, checkpoints or claim-time accounting.
    // Credit each user's proportional share directly, retaining 36 decimal fractional base units.
    mapping(address => uint256) public referenceCredit;
    uint256 public referenceDistributions;
    address[4] public users = [address(101), address(102), address(103), address(104)];
    constructor() {
        token = new StakingTokenFixture("TURRET"); usdg = new StakingTokenFixture("USDG");
        staking = new TurretStaking(token, usdg, address(this));
        usdg.mint(address(this), 1e24); usdg.approve(address(staking), type(uint256).max);
        for (uint256 i; i < users.length; i++) {
            token.mint(users[i], 1_000e18);
            vm.prank(users[i]); token.approve(address(staking), type(uint256).max);
        }
    }
    function stake(uint8 who, uint96 amount) external {
        address user = users[who % 4]; uint256 balance = token.balanceOf(user);
        if (balance == 0) return;
        vm.prank(user); staking.stake(bound(amount, 1, balance));
    }
    function unstake(uint8 who, uint96 amount) external {
        address user = users[who % 4]; uint256 balance = staking.stakedBalance(user);
        if (balance == 0) return;
        vm.roll(block.number + 1);
        vm.prank(user); staking.unstake(bound(amount, 1, balance));
    }
    function distribute(uint64 amount) external {
        if (staking.totalStaked() == 0) return;
        uint256 fee = bound(amount, 1, 100e6);
        uint256 supply = staking.totalStaked();
        for (uint256 i; i < users.length; i++) {
            referenceCredit[users[i]] += fee * staking.stakedBalance(users[i]) * 1e36 / supply;
        }
        referenceDistributions++;
        staking.distribute(fee);
    }
    function claim(uint8 who) external { vm.prank(users[who % 4]); staking.claim(); }
}
contract TurretStakingInvariantTest is StdInvariant, Test {
    StakingSequenceHandler handler;
    function setUp() public {
        handler = new StakingSequenceHandler();
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.stake.selector; selectors[1] = handler.unstake.selector;
        selectors[2] = handler.distribute.selector; selectors[3] = handler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors})); targetContract(address(handler));
    }
    function invariantPrincipalAndAllRewardsRemainBacked() public view {
        TurretStaking s = handler.staking();
        uint256 stakeSum; uint256 claimable;
        for (uint256 i; i < 4; i++) {
            address user = handler.users(i);
            stakeSum += s.stakedBalance(user); claimable += s.earned(user);
            assertEq(handler.token().balanceOf(user) + s.stakedBalance(user), 1_000e18);
            uint256 actual = s.earned(user) + handler.usdg().balanceOf(user);
            uint256 expected = handler.referenceCredit(user) / 1e36;
            // The global-index implementation rounds before multiplying by stake; the independent
            // ledger rounds after. With <=1e21 stake/user, <1e15 distributions lose <1 base unit.
            assertLe(handler.referenceDistributions(), 1e15);
            assertLe(actual, expected);
            assertLe(expected - actual, 1);
        }
        assertEq(stakeSum, s.totalStaked());
        assertEq(handler.token().balanceOf(address(s)), stakeSum);
        assertLe(claimable, handler.usdg().balanceOf(address(s)));
        assertEq(handler.usdg().balanceOf(address(s)) + s.totalClaimed(), s.totalFunded());
    }
}
