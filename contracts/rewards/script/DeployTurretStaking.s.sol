// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TurretFeeRouter} from "../src/TurretFeeRouter.sol";
interface IFeeConfiguration { function revenueFeeBps() external view returns(uint16); }

/// @notice Run without --broadcast first. Use an encrypted Foundry account for any authorized deployment.
/// Deploys contracts only; does not approve treasury funds, collect fees, or stake user tokens.
contract DeployTurretStaking is Script {
    function run() external returns (TurretFeeRouter router) {
        string memory config = vm.readFile("config/staking-pools.json");
        require(block.chainid == vm.parseJsonUint(config, ".chainId"), "Wrong chain");
        address token = vm.parseJsonAddress(config, ".stakingToken");
        address usdg = vm.parseJsonAddress(config, ".rewardToken");
        address treasury = vm.parseJsonAddress(config, ".treasury");
        address[] memory pools = vm.parseJsonAddressArray(config, ".pools");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(config, ".poolHashes");
        require(token.codehash == vm.parseJsonBytes32(config, ".stakingTokenHash"), "TURRET runtime changed");
        require(usdg.codehash == vm.parseJsonBytes32(config, ".rewardTokenHash"), "USDG runtime changed");
        require(IERC20Metadata(token).decimals() == 18 && IERC20Metadata(usdg).decimals() == 6, "Wrong token precision");
        require(pools.length == hashes.length && pools.length == 13, "Wrong pool manifest");
        for (uint256 i; i < pools.length; ++i) {
            require(pools[i].codehash == hashes[i], "Pool runtime changed");
            require(IFeeConfiguration(pools[i]).revenueFeeBps() == 1000, "Pool fee changed");
        }
        vm.startBroadcast(vm.envAddress("STAKING_DEPLOYER"));
        router = new TurretFeeRouter(IERC20Metadata(token), IERC20Metadata(usdg), treasury, pools);
        vm.stopBroadcast();
        console2.log("Fee router", address(router));
        console2.log("TURRET staking", address(router.staking()));
        console2.log("Staker share (bps)", router.STAKER_SHARE_BPS());
    }
}
