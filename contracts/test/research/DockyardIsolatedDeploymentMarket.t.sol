// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployDockyardIsolatedMarket} from "../../script/DeployDockyardIsolatedMarket.s.sol";
import {DockyardIsolatedMarketDeployment as Deployment} from "src/research/DockyardIsolatedMarketDeployment.sol";

contract DockyardIsolatedDeploymentMarketTest is Test {
    function testEntryPointAcceptsOnlyCanonicalChainAndAssets() public {
        DeployDockyardIsolatedMarket script = new DeployDockyardIsolatedMarket();
        Deployment.Config memory c;
        c.chainId = 4663;
        c.credit.usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        c.credit.collateral = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
        script.validateMarket(c);
        c.credit.collateral = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
        script.validateMarket(c);
        c.chainId = 1;
        vm.expectRevert(DeployDockyardIsolatedMarket.UnsupportedMarket.selector);
        script.validateMarket(c);
        c.chainId = 4663;
        c.credit.usdg = address(123);
        vm.expectRevert(DeployDockyardIsolatedMarket.UnsupportedMarket.selector);
        script.validateMarket(c);
        c.credit.usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        c.credit.collateral = address(123);
        vm.expectRevert(DeployDockyardIsolatedMarket.UnsupportedMarket.selector);
        script.validateMarket(c);
    }
}
