// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Script} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderRewards} from "../src/TurretLenderRewards.sol";

/// @notice User-run deployment. Never supply a private key in source or command arguments.
/// Use an encrypted Foundry account and inspect the dry run before broadcasting.
contract DeployEarnRewards is Script {
 function run() external {
  require(block.chainid==4663,"Wrong chain");
  address admin=0xD6Db8d5d228f8D381F2D1bBbFb41fDE73696735C;
  IERC20 token=IERC20(0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7);
  uint256 budget=20_000_000e18;
  require(token.balanceOf(admin)>=budget,"Insufficient reward tokens");
  address[12] memory pools=[
   0x853CA2c511690A6A5beB7F16B240b9602160D97C,0xcc73CEc0680e8c8EdDe702404dfDF50511FFcdfC,
   0x65209681089Aca6A1Fd127422bEb717764CC47c6,0xD804Cd41816FE850426156ccaF4B418084cF4fa1,
   0x2B9f699253cf0f6B6486EF41d16e3808ee4F2385,0x455d2E72Cfc6C43e99056419F47c8e47d4704a1F,
   0x7b3e1c0cdBba6824EE4211804E2A1fDd880cfA64,0xb643e1A97C0a83Af30504E0cFd27EA232d121dD7,
   0x55216CBD97b0391B439dE683189E590F75F2128f,0x5714DBc5D5c3C94c2155884C45fEA823a33bc39E,
   0xce2faFf543A5dE59a9967971EEe9D00E12b67B10,0x226a29d6F8026b367e409C332af70C318958cfe3];
  // One shared window. The hour before launch allows receipt verification and UI activation.
  uint256 start=block.timestamp+1 hours;
  vm.startBroadcast(admin);
  for(uint256 i;i<pools.length;i++){
   uint256 amount=budget/12+(i<budget%12?1:0);
   TurretLenderRewards rewards=new TurretLenderRewards(IERC20(pools[i]),token,admin,amount);
   require(token.approve(address(rewards),amount),"Approval failed");
   rewards.fundCampaign(amount,start,start+14 days);
  }
  vm.stopBroadcast();
 }
}
