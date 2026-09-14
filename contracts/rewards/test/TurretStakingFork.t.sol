// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretFeeRouter} from "../src/TurretFeeRouter.sol";
import {TurretStaking} from "../src/TurretStaking.sol";
interface ILiveStakingPool {
    function creditEngine() external view returns(address);
    function protocolFees() external view returns(uint256);
    function deposit(uint256,address) external returns(uint256);
    function draw(address,uint256) external;
    function repay(uint256,uint256) external;
}
contract TurretStakingForkTest is Test {
    function testRealTokenAndExistingPoolRevenueOnFork() public {
        string memory rpc = vm.envOr("STAKING_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) { vm.skip(true); return; }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);
        IERC20 token = IERC20(0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7);
        IERC20 usdg = IERC20(address(bytes20(hex"5fc5360d0400a0fd4f2af552add042d716f1d168")));
        address treasury = 0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086;
        address holder = 0xD6Db8d5d228f8D381F2D1bBbFb41fDE73696735C;
        address[] memory pools = new address[](1); pools[0] = 0x853CA2c511690A6A5beB7F16B240b9602160D97C;
        TurretFeeRouter router = new TurretFeeRouter(token, usdg, treasury, pools);
        TurretStaking staking = router.staking();
        vm.startPrank(holder); token.approve(address(staking), 100e18); staking.stake(100e18); vm.stopPrank();
        ILiveStakingPool pool = ILiveStakingPool(pools[0]);
        address engine = pool.creditEngine();
        // Isolate the real pool's accounting/transfer boundary from market oracle availability.
        vm.mockCall(engine, abi.encodeWithSignature("capitalOperationsAllowed()"), abi.encode(true));
        deal(address(usdg), address(this), 1_000e6);
        usdg.approve(pools[0], 1_000e6); pool.deposit(1_000e6, address(this));
        vm.prank(engine); pool.draw(address(this), 10e6);
        vm.warp(block.timestamp + 365 days);
        deal(address(usdg), engine, 1e6);
        vm.startPrank(engine); usdg.approve(pools[0], 1e6); pool.repay(0, 1e6); vm.stopPrank();
        uint256 fee = pool.protocolFees();
        assertGe(fee, 100_000);
        uint256 treasuryBefore = usdg.balanceOf(treasury);
        vm.prank(treasury); usdg.approve(address(router), fee / 2);
        router.collect(pools[0]);
        assertEq(usdg.balanceOf(treasury), treasuryBefore + fee - fee / 2);
        uint256 rewards = staking.earned(holder);
        assertEq(rewards, fee / 2);
        uint256 beforeUSDG = usdg.balanceOf(holder);
        uint256 beforeToken = token.balanceOf(holder);
        vm.roll(block.number + 1); vm.startPrank(holder); staking.unstake(100e18); staking.claim(); vm.stopPrank();
        assertEq(token.balanceOf(holder), beforeToken + 100e18);
        assertEq(usdg.balanceOf(holder), beforeUSDG + rewards);
    }
}
