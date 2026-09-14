// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {DockyardIsolatedCapitalPool} from "capital/research/DockyardIsolatedCapitalPool.sol";
import {TurretFeeRouter} from "../src/TurretFeeRouter.sol";
import {TurretStaking} from "../src/TurretStaking.sol";

contract RouterTokenFixture is ERC20 {
    uint8 private immutable precision;
    constructor(string memory name, uint8 digits) ERC20(name, name) { precision = digits; }
    function decimals() public view override returns (uint8) { return precision; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract SameBlockFeeCapture {
    function attempt(RouterTokenFixture token, TurretStaking staking, TurretFeeRouter router, address pool) external {
        token.approve(address(staking), 100e18);
        staking.stake(100e18);
        router.collect(pool);
        staking.claim();
        staking.unstake(100e18);
    }
}

contract TurretFeeRouterTest is Test {
    RouterTokenFixture token;
    RouterTokenFixture usdg;
    DockyardIsolatedCapitalPool pool;
    TurretFeeRouter router;
    TurretStaking staking;
    address treasury = address(0x7777);
    address alice = address(0xA11CE);
    function capitalOperationsAllowed() external pure returns (bool) { return true; }
    function setUp() public {
        token = new RouterTokenFixture("TURRET", 18);
        usdg = new RouterTokenFixture("USDG", 6);
        pool = new DockyardIsolatedCapitalPool(usdg, address(token), address(this), treasury, 1_000_000e6, 1000, 1000);
        address[] memory pools = new address[](1); pools[0] = address(pool);
        router = new TurretFeeRouter(token, usdg, treasury, pools);
        staking = router.staking();
        token.mint(alice, 100e18);
        vm.startPrank(alice); token.approve(address(staking), 100e18); staking.stake(100e18); vm.stopPrank();
        usdg.mint(address(this), 1_100e6);
        usdg.approve(address(pool), type(uint256).max);
        pool.deposit(1_000e6, address(this));
        pool.draw(address(0xB0B), 1_000e6);
        vm.warp(block.timestamp + 365 days);
        pool.repay(0, 100e6);
    }
    function testSameBlockFeeCaptureRevertsStakeCollectionAndClaimTogether() public {
        SameBlockFeeCapture attacker = new SameBlockFeeCapture();
        token.mint(address(attacker), 100e18);
        vm.prank(treasury); usdg.approve(address(router), 5e6);
        vm.expectRevert(TurretStaking.WaitOneBlock.selector);
        attacker.attempt(token, staking, router, address(pool));
        assertEq(pool.protocolFees(), 10e6);
        assertEq(token.balanceOf(address(attacker)), 100e18);
        assertEq(staking.stakedBalance(address(attacker)), 0);
        assertEq(usdg.balanceOf(address(attacker)), 0);
        assertEq(staking.totalFunded(), 0);
    }

    function testPaidInterestSplits90ToLender5ToStaker5ToTreasury() public {
        vm.prank(treasury); usdg.approve(address(router), 5e6);
        vm.prank(address(0xCA11)); router.collect(address(pool));
        assertEq(pool.protocolFees(), 0);
        assertEq(pool.availableCash(), 90e6);
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertEq(staking.earned(alice), 5e6);
        vm.prank(alice); staking.claim();
        assertEq(usdg.balanceOf(alice), 5e6);
        assertEq(router.totalCollected(), 10e6);
    }
    function testMissingTreasuryApprovalRevertsPoolCollectionAtomically() public {
        vm.expectRevert(); router.collect(address(pool));
        assertEq(pool.protocolFees(), 10e6);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(staking.earned(alice), 0);
        assertEq(router.totalCollected(), 0);
    }

    function testNoStakersLeavesFeesInPoolWithoutChangingSplit() public {
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(100e18);
        vm.expectRevert(TurretFeeRouter.NoStakers.selector); router.collect(address(pool));
        assertEq(pool.protocolFees(), 10e6);
    }

    function testUnknownPoolCannotPullTreasuryFunds() public {
        usdg.mint(treasury, 100e6);
        vm.prank(treasury); usdg.approve(address(router), type(uint256).max);
        vm.expectRevert(TurretFeeRouter.UnsupportedPool.selector); router.collect(address(this));
        assertEq(usdg.balanceOf(treasury), 100e6);
    }

    function testRepeatedCollectionCannotSpendTreasuryBalanceTwice() public {
        vm.prank(treasury); usdg.approve(address(router), type(uint256).max);
        router.collect(address(pool));
        vm.expectRevert(TurretFeeRouter.NoFees.selector); router.collect(address(pool));
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertEq(staking.earned(alice), 5e6);
    }

    function testChangedPoolRuntimeRejected() public {
        vm.etch(address(pool), hex"00");
        vm.expectRevert(TurretFeeRouter.UnsupportedPool.selector); router.collect(address(pool));
    }

    function testTreasuryCanForwardFeesThatWereClaimedOutsideRouter() public {
        pool.claimRevenue(); // Anyone can call the existing pool directly.
        assertEq(usdg.balanceOf(treasury), 10e6);
        vm.startPrank(treasury);
        usdg.approve(address(router), 5e6);
        router.forwardClaimedFees(10e6);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertEq(staking.earned(alice), 5e6);
    }

    function testExternalCallerCannotForwardArbitraryTreasuryFunds() public {
        usdg.mint(treasury, 100e6);
        vm.prank(treasury); usdg.approve(address(router), type(uint256).max);
        vm.expectRevert(TurretFeeRouter.Unauthorized.selector); router.forwardClaimedFees(100e6);
        assertEq(usdg.balanceOf(treasury), 100e6);
    }

    function testOddMicroFeesKeepCumulativeHalfSplit() public {
        usdg.mint(treasury, 2);
        vm.startPrank(treasury); usdg.approve(address(router), 1);
        router.forwardClaimedFees(1); router.forwardClaimedFees(1); vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 1);
        assertEq(staking.earned(alice), 1);
        assertEq(router.totalCollected(), 0);
        assertEq(router.totalTreasuryReported(), 2);
        assertEq(router.totalDistributed(), 1);
    }

}
