// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderRewards} from "../src/TurretLenderRewards.sol";
contract TurretLenderRewardsForkTest is Test {
 function testLiveTokenAndPoolTransfersOnLocalFork() public {
  string memory rpc=vm.envOr("REWARDS_FORK_RPC",string(""));
  if(bytes(rpc).length==0){vm.skip(true);return;}
  vm.createSelectFork(rpc);
  assertEq(block.chainid,4663);
  IERC20 token=IERC20(0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7);
  IERC20 pool=IERC20(0x853CA2c511690A6A5beB7F16B240b9602160D97C);
  address owner=0xD6Db8d5d228f8D381F2D1bBbFb41fDE73696735C;
  address lender=address(0xA11CE);
  TurretLenderRewards reward=new TurretLenderRewards(pool,token,owner,20_000_000e18);
  vm.startPrank(owner);token.approve(address(reward),20_000_000e18);
  reward.fundCampaign(20_000_000e18,block.timestamp,block.timestamp+14 days);vm.stopPrank();
  deal(address(pool),lender,100e12);
  vm.startPrank(lender);pool.approve(address(reward),100e12);reward.stake(100e12);vm.stopPrank();
  vm.warp(block.timestamp+7 days);assertEq(reward.earned(lender),10_000_000e18);
  vm.startPrank(lender);reward.claim();reward.unstake(100e12);vm.stopPrank();
  assertEq(token.balanceOf(lender),10_000_000e18);assertEq(pool.balanceOf(lender),100e12);
 }
}
