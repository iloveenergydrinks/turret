// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {P2PToken, IERC20} from "./P2PTestSupport.sol";
import {TurretP2PBatchDeployerV3} from "../src/TurretP2PBatchDeployerV3.sol";
import {TurretP2PLendingV3} from "../src/TurretP2PLendingV3.sol";
import {TurretP2PVaultV3} from "../src/TurretP2PVaultV3.sol";

contract BatchV3DeploymentTest is Test {
    function testNineteenMarketsHaveExactIndependentBindings() public {
        P2PToken cash = new P2PToken("USDG", 6);
        IERC20[] memory collateral = new IERC20[](19);
        for (uint256 i; i < collateral.length; ++i) collateral[i] = new P2PToken("ASSET", 18);
        address guardian = address(0x600D);
        TurretP2PBatchDeployerV3 batch = new TurretP2PBatchDeployerV3(cash, collateral, guardian);
        address[] memory markets = batch.getMarkets();
        assertEq(markets.length, 19);
        for (uint256 i; i < markets.length; ++i) {
            TurretP2PLendingV3 market = TurretP2PLendingV3(markets[i]);
            assertEq(address(market.loanToken()), address(cash));
            assertEq(address(market.collateralToken()), address(collateral[i]));
            assertEq(market.guardian(), guardian);
            assertEq(market.nextOfferId(), 1);
            TurretP2PVaultV3 vault = TurretP2PVaultV3(market.vaultImplementation());
            assertEq(vault.manager(), markets[i]);
            assertEq(address(vault.loanToken()), address(cash));
            assertEq(address(vault.collateralToken()), address(collateral[i]));
            for (uint256 j; j < i; ++j) assertTrue(markets[i] != markets[j]);
        }
    }

    function testRejectsEmptyDuplicateAndOversizedAssetLists() public {
        P2PToken cash = new P2PToken("USDG", 6);
        P2PToken token = new P2PToken("ASSET", 18);
        IERC20[] memory assets = new IERC20[](0);
        vm.expectRevert(TurretP2PBatchDeployerV3.InvalidAssets.selector);
        new TurretP2PBatchDeployerV3(cash, assets, address(this));
        assets = new IERC20[](2); assets[0] = token; assets[1] = token;
        vm.expectRevert(TurretP2PBatchDeployerV3.InvalidAssets.selector);
        new TurretP2PBatchDeployerV3(cash, assets, address(this));
        assets = new IERC20[](21);
        vm.expectRevert(TurretP2PBatchDeployerV3.InvalidAssets.selector);
        new TurretP2PBatchDeployerV3(cash, assets, address(this));
    }
}
