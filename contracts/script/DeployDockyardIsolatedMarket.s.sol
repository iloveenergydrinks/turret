// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {DockyardIsolatedMarketDeployment as Deployment} from "src/research/DockyardIsolatedMarketDeployment.sol";

/// @notice Explicit-input deployment entry point; run without --broadcast first.
/// @dev Does not attest to audits or independent oracle sourcing. External release
/// gates must be satisfied before broadcast. Never unpauses or funds the market.
contract DeployDockyardIsolatedMarket is Script {
    error UnsupportedMarket();

    function validateMarket(Deployment.Config memory c) public pure {
        if (
            c.chainId != 4663 || c.credit.usdg != 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
                || (c.credit.collateral != 0x020bfC650A365f8BB26819deAAbF3E21291018b4
                    && c.credit.collateral != 0x39dBED3a2bd333467115dE45665cC57F813C4571)
        ) revert UnsupportedMarket();
    }

    function run() external returns (Deployment deployed) {
        Deployment.Config memory c = abi.decode(vm.envBytes("ISOLATED_DEPLOY_CONFIG"), (Deployment.Config));
        bytes32 expected = vm.envBytes32("ISOLATED_DEPLOY_CONFIG_HASH");
        validateMarket(c);
        vm.startBroadcast();
        deployed = new Deployment(c, expected);
        vm.stopBroadcast();
    }
}
