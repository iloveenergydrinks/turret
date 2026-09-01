// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {DockyardUSDGCreditVault} from "src/DockyardUSDGCreditVault.sol";
import {StockTokenConfig} from "src/StockTokens/StockTokenConfig.sol";

interface IDeployRobinhoodStockToken {
    function oraclePaused() external view returns (bool);
}

/// @notice Deploys the independent owner-funded Dockyard USDG credit vault.
/// @dev No Liquity contracts or protocol-issued stablecoins are deployed.
contract DeployDockyardUSDGCreditVault is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4_663;
    address internal constant ROBINHOOD_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 internal constant USDG_TO_18_SCALE = 1e12;
    uint16 internal constant BORROW_BUFFER_BPS = 500;
    uint16 internal constant LIQUIDATION_BONUS_BPS = 500;
    uint16 internal constant MAX_ORACLE_DEVIATION_BPS = 200;

    error WrongChain();
    error InvalidCanonicalAsset(address asset);
    error StockTokenPaused(bytes32 symbol);

    function run() external returns (DockyardUSDGCreditVault vault) {
        if (block.chainid != ROBINHOOD_MAINNET_CHAIN_ID) revert WrongChain();
        if (ROBINHOOD_USDG.code.length == 0 || IERC20Metadata(ROBINHOOD_USDG).decimals() != 6) {
            revert InvalidCanonicalAsset(ROBINHOOD_USDG);
        }

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address owner = vm.envOr("DOCKYARD_OWNER", deployer);
        uint256 originationFee = vm.envOr("DOCKYARD_ORIGINATION_FEE_BPS", uint256(50));
        require(originationFee <= 500, "Dockyard: fee too high");
        uint16 originationFeeBps = uint16(originationFee);
        uint256 oracleStaleness = vm.envOr("DOCKYARD_ORACLE_STALENESS", uint256(1 days));
        uint256 initialUsdg = vm.envOr("DOCKYARD_INITIAL_USDG", uint256(0)) * 1e6;
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();
        _preflight(configs);

        vm.startBroadcast(deployerKey);
        vault = new DockyardUSDGCreditVault(ROBINHOOD_USDG, owner, originationFeeBps, oracleStaleness);
        for (uint256 i = 0; i < configs.length; ++i) {
            StockTokenConfig.Config memory config = configs[i];
            uint16 liquidationLtvBps = uint16(10_000 * 1e18 / config.MCR);
            uint16 maxLtvBps = liquidationLtvBps - BORROW_BUFFER_BPS;
            uint128 debtCeiling = uint128(config.debtCeiling / USDG_TO_18_SCALE);
            vault.addMarket(
                config.robinhoodChainToken,
                config.chainlinkFeed,
                config.secondaryChainlinkFeed,
                debtCeiling,
                maxLtvBps,
                liquidationLtvBps,
                LIQUIDATION_BONUS_BPS,
                MAX_ORACLE_DEVIATION_BPS
            );
        }
        if (initialUsdg != 0) {
            IERC20(ROBINHOOD_USDG).approve(address(vault), initialUsdg);
            vault.fund(initialUsdg);
        }
        vm.stopBroadcast();

        console2.log("Dockyard USDG vault", address(vault));
        console2.log("Owner", owner);
        console2.log("USDG", ROBINHOOD_USDG);
        console2.log("Initial USDG liquidity", initialUsdg);
        _writeManifest(address(vault), owner, configs);
    }

    function _preflight(StockTokenConfig.Config[] memory configs) internal view {
        require(configs.length == 10, "Dockyard: expected ten markets");
        for (uint256 i = 0; i < configs.length; ++i) {
            StockTokenConfig.Config memory config = configs[i];
            if (
                config.robinhoodChainToken.code.length == 0 || config.chainlinkFeed.code.length == 0
                    || config.secondaryChainlinkFeed.code.length == 0
                    || IERC20Metadata(config.robinhoodChainToken).decimals() != 18
            ) revert InvalidCanonicalAsset(config.robinhoodChainToken);
            if (IDeployRobinhoodStockToken(config.robinhoodChainToken).oraclePaused()) {
                revert StockTokenPaused(config.symbol);
            }
        }
    }

    function _writeManifest(address vault, address owner, StockTokenConfig.Config[] memory configs) internal {
        address[] memory collaterals = new address[](configs.length);
        address[] memory primaryOracles = new address[](configs.length);
        address[] memory secondaryOracles = new address[](configs.length);
        for (uint256 i = 0; i < configs.length; ++i) {
            collaterals[i] = configs[i].robinhoodChainToken;
            primaryOracles[i] = configs[i].chainlinkFeed;
            secondaryOracles[i] = configs[i].secondaryChainlinkFeed;
        }

        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeAddress("deployment", "vault", vault);
        vm.serializeAddress("deployment", "owner", owner);
        vm.serializeAddress("deployment", "usdg", ROBINHOOD_USDG);
        vm.serializeAddress("deployment", "collaterals", collaterals);
        vm.serializeAddress("deployment", "primaryOracles", primaryOracles);
        string memory json = vm.serializeAddress("deployment", "secondaryOracles", secondaryOracles);
        vm.writeJson(json, "deployment-dockyard-usdg-mainnet.json");
    }
}
