// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {TurretFeeRouter} from "../src/TurretFeeRouter.sol";
import {TurretStaking} from "../src/TurretStaking.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";

contract AccumulatingFeePool {
    StakingTokenFixture public immutable asset;
    address public immutable feeRecipient;
    uint256 public protocolFees;
    constructor(StakingTokenFixture usdg, address treasury) { asset = usdg; feeRecipient = treasury; }
    function accrue(uint256 fee) external { asset.mint(address(this), fee); protocolFees += fee; }
    function claimRevenue() external {
        uint256 fee = protocolFees; protocolFees = 0; asset.transfer(feeRecipient, fee);
    }
}
contract RouterSequenceHandler is Test {
    StakingTokenFixture public token;
    StakingTokenFixture public usdg;
    TurretFeeRouter public router;
    TurretStaking public staking;
    address public treasury = address(0x7777);
    address[4] public users = [address(101), address(102), address(103), address(104)];
    AccumulatingFeePool[2] public pools;
    uint256 public generated;
    uint256 public unforwarded;
    uint256 public accepted;
    uint256 public stakingDonations;
    uint256 public routerDonations;
    mapping(address => uint256) public referenceCredit;
    constructor() {
        token = new StakingTokenFixture("TURRET"); usdg = new StakingTokenFixture("USDG");
        address[] memory allowlist = new address[](2);
        for (uint256 i; i < 2; i++) {
            pools[i] = new AccumulatingFeePool(usdg, treasury); allowlist[i] = address(pools[i]);
        }
        router = new TurretFeeRouter(token, usdg, treasury, allowlist); staking = router.staking();
        vm.prank(treasury); usdg.approve(address(router), type(uint256).max);
        for (uint256 i; i < 4; i++) {
            token.mint(users[i], 1_000e18); vm.prank(users[i]); token.approve(address(staking), type(uint256).max);
        }
    }
    function stake(uint8 who, uint96 raw) external {
        address user = users[who % 4]; uint256 balance = token.balanceOf(user); if (balance == 0) return;
        vm.prank(user); staking.stake(bound(raw, 1, balance));
    }
    function unstake(uint8 who, uint96 raw) external {
        address user = users[who % 4]; uint256 balance = staking.stakedBalance(user); if (balance == 0) return;
        vm.roll(block.number + 1); vm.prank(user); staking.unstake(bound(raw, 1, balance));
    }
    function claim(uint8 who) external { vm.prank(users[who % 4]); staking.claim(); }
    function accrue(uint8 which, uint64 raw) external {
        uint256 fee = bound(raw, 1, 100e6); pools[which % 2].accrue(fee); generated += fee;
    }
    function toggleAllowance(bool enabled) external {
        vm.prank(treasury); usdg.approve(address(router), enabled ? type(uint256).max : 0);
    }
    function collect(uint8 which) external {
        AccumulatingFeePool pool = pools[which % 2]; uint256 fee = pool.protocolFees();
        if (staking.totalStaked() == 0) {
            vm.expectRevert(TurretFeeRouter.NoStakers.selector); router.collect(address(pool)); return;
        }
        if (fee == 0) {
            vm.expectRevert(TurretFeeRouter.NoFees.selector); router.collect(address(pool)); return;
        }
        // The cumulative entitlement determines whether even an odd micro-fee needs allowance.
        uint256 nextShare = (accepted + fee) / 2 - accepted / 2;
        if (usdg.allowance(treasury, address(router)) < nextShare) {
            vm.expectRevert("ERC20: insufficient allowance"); router.collect(address(pool)); return;
        }
        router.collect(address(pool)); accepted += fee; _credit(nextShare);
    }
    function claimOutsideRouter(uint8 which) external {
        AccumulatingFeePool pool = pools[which % 2]; uint256 fee = pool.protocolFees();
        pool.claimRevenue(); unforwarded += fee;
    }
    function forward(uint64 raw) external {
        if (unforwarded == 0 || staking.totalStaked() == 0) return;
        uint256 fee = bound(raw, 1, unforwarded);
        uint256 nextShare = (accepted + fee) / 2 - accepted / 2;
        if (usdg.allowance(treasury, address(router)) < nextShare) return;
        vm.prank(treasury); router.forwardClaimedFees(fee);
        unforwarded -= fee; accepted += fee; _credit(nextShare);
    }
    function donate(bool toStaking, uint64 raw) external {
        uint256 amount = bound(raw, 1, 100e6);
        if (toStaking) { usdg.mint(address(staking), amount); stakingDonations += amount; }
        else { usdg.mint(address(router), amount); routerDonations += amount; }
    }
    function _credit(uint256 fee) private {
        uint256 total = staking.totalStaked();
        for (uint256 i; i < 4; i++) referenceCredit[users[i]] += fee * staking.stakedBalance(users[i]) * 1e36 / total;
    }
}
contract TurretFeeRouterInvariantTest is StdInvariant, Test {
    RouterSequenceHandler h;
    function setUp() public {
        h = new RouterSequenceHandler(); bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = h.stake.selector; selectors[1] = h.unstake.selector; selectors[2] = h.claim.selector;
        selectors[3] = h.accrue.selector; selectors[4] = h.toggleAllowance.selector;
        selectors[5] = h.collect.selector; selectors[6] = h.claimOutsideRouter.selector;
        selectors[7] = h.forward.selector; selectors[8] = h.donate.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors})); targetContract(address(h));
    }
    function invariantCumulativeSplitBackingAndIndividualEntitlements() public view {
        TurretFeeRouter r = h.router(); TurretStaking s = h.staking(); StakingTokenFixture u = h.usdg();
        uint256 pending = h.pools(0).protocolFees() + h.pools(1).protocolFees();
        assertEq(h.generated(), h.accepted() + h.unforwarded() + pending);
        assertEq(r.totalCollected() + r.totalTreasuryReported(), h.accepted());
        assertEq(r.totalDistributed(), h.accepted() / 2);
        assertEq(u.balanceOf(h.treasury()), h.generated() - pending - r.totalDistributed());
        assertEq(u.balanceOf(address(r)), h.routerDonations());
        assertEq(s.totalFunded(), r.totalDistributed());
        assertEq(u.balanceOf(address(s)) + s.totalClaimed(), s.totalFunded() + h.stakingDonations());
        uint256 stakeSum; uint256 claimable; uint256 claimed;
        for (uint256 i; i < 4; i++) {
            address user = h.users(i); uint256 stake = s.stakedBalance(user); uint256 earned = s.earned(user);
            uint256 actual = u.balanceOf(user) + earned; uint256 expected = h.referenceCredit(user) / 1e36;
            assertLe(actual, expected); assertLe(expected - actual, 1);
            assertEq(h.token().balanceOf(user) + stake, 1_000e18);
            stakeSum += stake; claimable += earned; claimed += u.balanceOf(user);
        }
        assertEq(stakeSum, s.totalStaked()); assertEq(stakeSum, h.token().balanceOf(address(s)));
        assertEq(claimed, s.totalClaimed()); assertLe(claimable + claimed, s.totalFunded());
    }
}
