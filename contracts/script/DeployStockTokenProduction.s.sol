// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {LibString} from "Solady/utils/LibString.sol";

import {ActivePool} from "src/ActivePool.sol";
import {AddressesRegistry} from "src/AddressesRegistry.sol";
import {BoldToken} from "src/BoldToken.sol";
import {BorrowerOperations} from "src/BorrowerOperations.sol";
import {CollSurplusPool} from "src/CollSurplusPool.sol";
import {CollateralRegistry} from "src/CollateralRegistry.sol";
import {DefaultPool} from "src/DefaultPool.sol";
import {DebtInFrontHelper} from "src/DebtInFrontHelper.sol";
import {GasPool} from "src/GasPool.sol";
import {HintHelpers} from "src/HintHelpers.sol";
import {MultiTroveGetter} from "src/MultiTroveGetter.sol";
import {RedemptionHelper} from "src/RedemptionHelper.sol";
import {SortedTroves} from "src/SortedTroves.sol";
import {StabilityPool} from "src/StabilityPool.sol";
import {TroveManager} from "src/TroveManager.sol";
import {TroveNFT} from "src/TroveNFT.sol";
import {GasCompZapper} from "src/Zappers/GasCompZapper.sol";
import {IExchange} from "src/Zappers/Interfaces/IExchange.sol";
import {IFlashLoanProvider} from "src/Zappers/Interfaces/IFlashLoanProvider.sol";
import {StockTokenPriceFeed} from "src/PriceFeeds/StockTokenPriceFeed.sol";
import {StockTokenConfig} from "src/StockTokens/StockTokenConfig.sol";

import {AggregatorV3Interface} from "src/Dependencies/AggregatorV3Interface.sol";
import {IActivePool} from "src/Interfaces/IActivePool.sol";
import {IAddressesRegistry} from "src/Interfaces/IAddressesRegistry.sol";
import {IBorrowerOperations} from "src/Interfaces/IBorrowerOperations.sol";
import {ICollSurplusPool} from "src/Interfaces/ICollSurplusPool.sol";
import {IDefaultPool} from "src/Interfaces/IDefaultPool.sol";
import {IInterestRouter} from "src/Interfaces/IInterestRouter.sol";
import {IPriceFeed} from "src/Interfaces/IPriceFeed.sol";
import {IStockToken} from "src/Interfaces/IStockToken.sol";
import {ISortedTroves} from "src/Interfaces/ISortedTroves.sol";
import {IStabilityPool} from "src/Interfaces/IStabilityPool.sol";
import {ITroveManager} from "src/Interfaces/ITroveManager.sol";
import {ITroveNFT} from "src/Interfaces/ITroveNFT.sol";
import {IWETH} from "src/Interfaces/IWETH.sol";
import {IMetadataNFT} from "src/NFTMetadata/MetadataNFT.sol";

/// @dev rUSD intentionally has no in-protocol collateral swap path until a
/// production exchange integration is separately reviewed and configured.
contract ProductionDisabledExchange is IExchange {
    error ExchangeIntegrationDisabled();

    function swapFromBold(uint256, uint256) external pure {
        revert ExchangeIntegrationDisabled();
    }

    function swapToBold(uint256, uint256) external pure returns (uint256) {
        revert ExchangeIntegrationDisabled();
    }
}

/// @dev Minimal metadata renderer that supports every Robinhood Stock Token
/// symbol without depending on Liquity's fixed ETH/LST artwork bundle.
contract StockTokenTroveMetadata is IMetadataNFT {
    function uri(TroveData memory trove) external view returns (string memory) {
        string memory symbol = IERC20Metadata(trove._collToken).symbol();
        return string.concat(
            'data:application/json;utf8,{"name":"rUSD ',
            symbol,
            " Vault #",
            LibString.toString(trove._tokenId),
            '","description":"A collateralized rUSD position backed by a Robinhood Stock Token.",',
            '"attributes":[{"trait_type":"Collateral","value":"',
            symbol,
            '"},{"trait_type":"Collateral amount","value":"',
            LibString.toString(trove._collAmount),
            '"},{"trait_type":"Debt amount","value":"',
            LibString.toString(trove._debtAmount),
            '"},{"trait_type":"Interest rate","value":"',
            LibString.toString(trove._interestRate),
            '"}]}'
        );
    }
}

/// @notice Ten-branch rUSD deployment using canonical Robinhood Chain assets.
/// @dev This script is intentionally separate from the sandcastle deployer. It
/// never deploys mock collateral or mock oracle contracts and fails before
/// broadcast if any live dependency does not pass its onchain preflight.
contract DeployStockTokenProduction is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4_663;
    address internal constant ROBINHOOD_WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant BCR = 10e16;
    uint256 internal constant LIQUIDATION_PENALTY_SP = 5e16;
    uint256 internal constant LIQUIDATION_PENALTY_REDISTRIBUTION = 10e16;
    uint256 internal constant ORACLE_STALENESS = 1 days;
    uint256 internal constant SEQUENCER_GRACE_PERIOD = 1 hours;
    uint256 internal constant LARGE_CHANGE_CONFIRMATION_DELAY = 30 minutes;
    uint256 internal constant CONFIRMATION_DEVIATION_BPS = 500;

    struct BranchAddresses {
        address borrowerOperations;
        address troveManager;
        address troveNFT;
        address stabilityPool;
        address activePool;
        address defaultPool;
        address gasPool;
        address collSurplusPool;
        address sortedTroves;
    }

    struct DeploymentState {
        BoldToken stablecoin;
        IWETH weth;
        AggregatorV3Interface sequencerFeed;
        IInterestRouter interestRouter;
        ProductionDisabledExchange disabledExchange;
        StockTokenTroveMetadata metadataNFT;
        StockTokenConfig.Config[] configs;
        IERC20Metadata[] collaterals;
        IAddressesRegistry[] registries;
        ITroveManager[] troveManagers;
        AggregatorV3Interface[] oracles;
        AggregatorV3Interface[] secondaryOracles;
        CollateralRegistry collateralRegistry;
        HintHelpers hintHelpers;
        MultiTroveGetter multiTroveGetter;
        DebtInFrontHelper debtInFrontHelper;
        RedemptionHelper redemptionHelper;
        address[] borrowerOperations;
        address[] stabilityPools;
        address[] priceFeeds;
        address[] troveNFTs;
        address[] activePools;
        address[] defaultPools;
        address[] gasPools;
        address[] collSurplusPools;
        address[] sortedTroves;
        address[] zappers;
    }

    error ProductionLicenseNotConfirmed();
    error MissingCode(address dependency);
    error InvalidWeth();
    error InvalidCollateral(bytes32 symbol);
    error CollateralPaused(bytes32 symbol);
    error InvalidOracle(bytes32 symbol, address oracle);
    error OracleMismatch(bytes32 symbol, uint256 primaryPrice, uint256 secondaryPrice);
    error MissingSequencerSafetyAcknowledgement();

    function run() external {
        require(block.chainid == ROBINHOOD_MAINNET_CHAIN_ID, "production: wrong chain");
        if (!vm.envOr("LIQUITY_PRODUCTION_LICENSE_CONFIRMED", false)) revert ProductionLicenseNotConfirmed();

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address interestRecipient = vm.envOr("INTEREST_RECIPIENT", deployer);
        address sequencerFeedAddress = vm.envOr("RH_SEQUENCER_UPTIME_FEED", address(0));
        if (sequencerFeedAddress == address(0) && !vm.envOr("ACKNOWLEDGE_NO_SEQUENCER_UPTIME_FEED", false)) {
            revert MissingSequencerSafetyAcknowledgement();
        }

        uint256 deploymentBlock = block.number;
        bytes32 salt = keccak256(bytes(vm.envOr("PRODUCTION_SALT", string("rusd-robinhood-mainnet-v1"))));
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();
        _preflight(configs, sequencerFeedAddress, interestRecipient);

        vm.startBroadcast(deployerKey);
        DeploymentState memory d = _deployTopLevel(deployer, interestRecipient, sequencerFeedAddress, configs, salt);
        for (uint256 i = 0; i < d.configs.length; ++i) {
            (BranchAddresses memory branch, address priceFeed, address zapper) = _deployBranch(d, i, salt);
            d.borrowerOperations[i] = branch.borrowerOperations;
            d.stabilityPools[i] = branch.stabilityPool;
            d.priceFeeds[i] = priceFeed;
            d.troveNFTs[i] = branch.troveNFT;
            d.activePools[i] = branch.activePool;
            d.defaultPools[i] = branch.defaultPool;
            d.gasPools[i] = branch.gasPool;
            d.collSurplusPools[i] = branch.collSurplusPool;
            d.sortedTroves[i] = branch.sortedTroves;
            d.zappers[i] = zapper;
        }

        d.debtInFrontHelper = new DebtInFrontHelper(d.collateralRegistry, d.hintHelpers);
        d.redemptionHelper = new RedemptionHelper(d.collateralRegistry, d.registries);
        d.stablecoin.setCollateralRegistry(address(d.collateralRegistry));
        vm.stopBroadcast();

        _writeManifest(d, deploymentBlock, deployer);
    }

    function _preflight(
        StockTokenConfig.Config[] memory configs,
        address sequencerFeedAddress,
        address interestRecipient
    ) internal view {
        if (ROBINHOOD_WETH.code.length == 0) revert MissingCode(ROBINHOOD_WETH);
        if (IERC20Metadata(ROBINHOOD_WETH).decimals() != 18) revert InvalidWeth();
        if (interestRecipient == address(0)) revert MissingCode(address(0));
        if (sequencerFeedAddress != address(0)) {
            if (sequencerFeedAddress.code.length == 0) revert MissingCode(sequencerFeedAddress);
            (, int256 answer, uint256 startedAt,,) = AggregatorV3Interface(sequencerFeedAddress).latestRoundData();
            if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) {
                revert InvalidOracle(bytes32("SEQUENCER"), sequencerFeedAddress);
            }
        }

        require(configs.length == 10, "production: expected ten branches");
        for (uint256 i = 0; i < configs.length; ++i) {
            StockTokenConfig.Config memory config = configs[i];
            if (config.robinhoodChainToken.code.length == 0) revert MissingCode(config.robinhoodChainToken);
            if (IERC20Metadata(config.robinhoodChainToken).decimals() != 18) revert InvalidCollateral(config.symbol);
            if (IStockToken(config.robinhoodChainToken).oraclePaused()) revert CollateralPaused(config.symbol);

            uint256 primaryPrice = _validatedOraclePrice(config.symbol, config.chainlinkFeed);
            uint256 secondaryPrice = _validatedOraclePrice(config.symbol, config.secondaryChainlinkFeed);
            uint256 difference =
                primaryPrice > secondaryPrice ? primaryPrice - secondaryPrice : secondaryPrice - primaryPrice;
            if (difference * BPS > primaryPrice * config.maxOracleDeviationBps) {
                revert OracleMismatch(config.symbol, primaryPrice, secondaryPrice);
            }
        }
    }

    function _validatedOraclePrice(bytes32 symbol, address oracleAddress) internal view returns (uint256) {
        if (oracleAddress.code.length == 0) revert MissingCode(oracleAddress);
        AggregatorV3Interface oracle = AggregatorV3Interface(oracleAddress);
        uint8 decimals = oracle.decimals();
        if (decimals > 18) revert InvalidOracle(symbol, oracleAddress);
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = oracle.latestRoundData();
        if (
            answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp
                || block.timestamp - updatedAt >= ORACLE_STALENESS || answeredInRound < roundId
        ) revert InvalidOracle(symbol, oracleAddress);
        return uint256(answer) * 10 ** (18 - decimals);
    }

    function _deployTopLevel(
        address deployer,
        address interestRecipient,
        address sequencerFeedAddress,
        StockTokenConfig.Config[] memory configs,
        bytes32 salt
    ) internal returns (DeploymentState memory d) {
        d.stablecoin = new BoldToken(deployer);
        d.weth = IWETH(ROBINHOOD_WETH);
        d.sequencerFeed = AggregatorV3Interface(sequencerFeedAddress);
        d.interestRouter = IInterestRouter(interestRecipient);
        d.disabledExchange = new ProductionDisabledExchange();
        d.metadataNFT = new StockTokenTroveMetadata();
        d.configs = configs;
        d.collaterals = new IERC20Metadata[](configs.length);
        d.registries = new IAddressesRegistry[](configs.length);
        d.troveManagers = new ITroveManager[](configs.length);
        d.oracles = new AggregatorV3Interface[](configs.length);
        d.secondaryOracles = new AggregatorV3Interface[](configs.length);

        for (uint256 i = 0; i < configs.length; ++i) {
            d.collaterals[i] = IERC20Metadata(configs[i].robinhoodChainToken);
            d.oracles[i] = AggregatorV3Interface(configs[i].chainlinkFeed);
            d.secondaryOracles[i] = AggregatorV3Interface(configs[i].secondaryChainlinkFeed);
            d.registries[i] = _deployAddressesRegistry(configs[i], deployer);
            d.troveManagers[i] =
                ITroveManager(_computeCreate2Address(type(TroveManager).creationCode, d.registries[i], salt));
        }

        d.collateralRegistry = new CollateralRegistry(d.stablecoin, d.collaterals, d.troveManagers);
        d.hintHelpers = new HintHelpers(d.collateralRegistry);
        d.multiTroveGetter = new MultiTroveGetter(d.collateralRegistry);
        d.borrowerOperations = new address[](configs.length);
        d.stabilityPools = new address[](configs.length);
        d.priceFeeds = new address[](configs.length);
        d.troveNFTs = new address[](configs.length);
        d.activePools = new address[](configs.length);
        d.defaultPools = new address[](configs.length);
        d.gasPools = new address[](configs.length);
        d.collSurplusPools = new address[](configs.length);
        d.sortedTroves = new address[](configs.length);
        d.zappers = new address[](configs.length);
    }

    function _deployAddressesRegistry(StockTokenConfig.Config memory config, address deployer)
        internal
        returns (IAddressesRegistry)
    {
        return new AddressesRegistry(
            deployer,
            config.CCR,
            config.MCR,
            BCR,
            config.SCR,
            LIQUIDATION_PENALTY_SP,
            LIQUIDATION_PENALTY_REDISTRIBUTION,
            config.debtCeiling
        );
    }

    function _deployBranch(DeploymentState memory d, uint256 i, bytes32 salt)
        internal
        returns (BranchAddresses memory actual, address priceFeedAddress, address zapperAddress)
    {
        BranchAddresses memory predicted = _predictBranchAddresses(d.registries[i], salt);
        StockTokenPriceFeed priceFeed = new StockTokenPriceFeed(
            address(d.collaterals[i]),
            address(d.oracles[i]),
            address(d.secondaryOracles[i]),
            ORACLE_STALENESS,
            address(d.sequencerFeed),
            SEQUENCER_GRACE_PERIOD,
            d.configs[i].maxOracleDeviationBps,
            LARGE_CHANGE_CONFIRMATION_DELAY,
            CONFIRMATION_DEVIATION_BPS,
            predicted.borrowerOperations
        );

        d.registries[i].setAddresses(
            IAddressesRegistry.AddressVars({
                collToken: d.collaterals[i],
                borrowerOperations: IBorrowerOperations(predicted.borrowerOperations),
                troveManager: ITroveManager(predicted.troveManager),
                troveNFT: ITroveNFT(predicted.troveNFT),
                metadataNFT: d.metadataNFT,
                stabilityPool: IStabilityPool(predicted.stabilityPool),
                priceFeed: IPriceFeed(address(priceFeed)),
                activePool: IActivePool(predicted.activePool),
                defaultPool: IDefaultPool(predicted.defaultPool),
                gasPoolAddress: predicted.gasPool,
                collSurplusPool: ICollSurplusPool(predicted.collSurplusPool),
                sortedTroves: ISortedTroves(predicted.sortedTroves),
                interestRouter: d.interestRouter,
                hintHelpers: d.hintHelpers,
                multiTroveGetter: d.multiTroveGetter,
                collateralRegistry: d.collateralRegistry,
                boldToken: d.stablecoin,
                WETH: d.weth
            })
        );

        actual.borrowerOperations = address(new BorrowerOperations{salt: salt}(d.registries[i]));
        actual.troveManager = address(new TroveManager{salt: salt}(d.registries[i]));
        actual.troveNFT = address(new TroveNFT{salt: salt}(d.registries[i]));
        actual.stabilityPool = address(new StabilityPool{salt: salt}(d.registries[i]));
        actual.activePool = address(new ActivePool{salt: salt}(d.registries[i]));
        actual.defaultPool = address(new DefaultPool{salt: salt}(d.registries[i]));
        actual.gasPool = address(new GasPool{salt: salt}(d.registries[i]));
        actual.collSurplusPool = address(new CollSurplusPool{salt: salt}(d.registries[i]));
        actual.sortedTroves = address(new SortedTroves{salt: salt}(d.registries[i]));
        _requireAddressesMatch(predicted, actual);

        d.stablecoin
            .setBranchAddresses(actual.troveManager, actual.stabilityPool, actual.borrowerOperations, actual.activePool);
        GasCompZapper zapper = new GasCompZapper(d.registries[i], IFlashLoanProvider(address(0)), d.disabledExchange);
        console2.log(_bytes32ToString(d.configs[i].symbol), address(d.collaterals[i]));
        return (actual, address(priceFeed), address(zapper));
    }

    function _requireAddressesMatch(BranchAddresses memory expected, BranchAddresses memory actual) internal pure {
        require(actual.borrowerOperations == expected.borrowerOperations, "production: BO address mismatch");
        require(actual.troveManager == expected.troveManager, "production: TM address mismatch");
        require(actual.troveNFT == expected.troveNFT, "production: NFT address mismatch");
        require(actual.stabilityPool == expected.stabilityPool, "production: SP address mismatch");
        require(actual.activePool == expected.activePool, "production: AP address mismatch");
        require(actual.defaultPool == expected.defaultPool, "production: DP address mismatch");
        require(actual.gasPool == expected.gasPool, "production: GP address mismatch");
        require(actual.collSurplusPool == expected.collSurplusPool, "production: CSP address mismatch");
        require(actual.sortedTroves == expected.sortedTroves, "production: ST address mismatch");
    }

    function _predictBranchAddresses(IAddressesRegistry registry, bytes32 salt)
        internal
        view
        returns (BranchAddresses memory a)
    {
        a.borrowerOperations = _computeCreate2Address(type(BorrowerOperations).creationCode, registry, salt);
        a.troveManager = _computeCreate2Address(type(TroveManager).creationCode, registry, salt);
        a.troveNFT = _computeCreate2Address(type(TroveNFT).creationCode, registry, salt);
        a.stabilityPool = _computeCreate2Address(type(StabilityPool).creationCode, registry, salt);
        a.activePool = _computeCreate2Address(type(ActivePool).creationCode, registry, salt);
        a.defaultPool = _computeCreate2Address(type(DefaultPool).creationCode, registry, salt);
        a.gasPool = _computeCreate2Address(type(GasPool).creationCode, registry, salt);
        a.collSurplusPool = _computeCreate2Address(type(CollSurplusPool).creationCode, registry, salt);
        a.sortedTroves = _computeCreate2Address(type(SortedTroves).creationCode, registry, salt);
    }

    function _computeCreate2Address(bytes memory creationCode, IAddressesRegistry registry, bytes32 salt)
        internal
        view
        returns (address)
    {
        bytes32 bytecodeHash = keccak256(bytes.concat(creationCode, abi.encode(registry)));
        return vm.computeCreate2Address(salt, bytecodeHash);
    }

    function _writeManifest(DeploymentState memory d, uint256 deploymentBlock, address deployer) internal {
        vm.serializeUint("deployment", "chainId", block.chainid);
        vm.serializeUint("deployment", "deploymentBlock", deploymentBlock);
        vm.serializeAddress("deployment", "deployer", deployer);
        vm.serializeAddress("deployment", "stablecoin", address(d.stablecoin));
        vm.serializeAddress("deployment", "collateralRegistry", address(d.collateralRegistry));
        vm.serializeAddress("deployment", "hintHelpers", address(d.hintHelpers));
        vm.serializeAddress("deployment", "multiTroveGetter", address(d.multiTroveGetter));
        vm.serializeAddress("deployment", "debtInFrontHelper", address(d.debtInFrontHelper));
        vm.serializeAddress("deployment", "redemptionHelper", address(d.redemptionHelper));
        vm.serializeAddress("deployment", "disabledExchange", address(d.disabledExchange));
        vm.serializeAddress("deployment", "weth", address(d.weth));
        vm.serializeAddress("deployment", "sequencerFeed", address(d.sequencerFeed));
        vm.serializeAddress("deployment", "interestRecipient", address(d.interestRouter));
        vm.serializeAddress("deployment", "stockTokens", _toAddresses(d.collaterals));
        vm.serializeAddress("deployment", "addressRegistries", _toAddresses(d.registries));
        vm.serializeAddress("deployment", "troveManagers", _toAddresses(d.troveManagers));
        vm.serializeAddress("deployment", "borrowerOperations", d.borrowerOperations);
        vm.serializeAddress("deployment", "stabilityPools", d.stabilityPools);
        vm.serializeAddress("deployment", "troveNFTs", d.troveNFTs);
        vm.serializeAddress("deployment", "activePools", d.activePools);
        vm.serializeAddress("deployment", "defaultPools", d.defaultPools);
        vm.serializeAddress("deployment", "gasPools", d.gasPools);
        vm.serializeAddress("deployment", "collSurplusPools", d.collSurplusPools);
        vm.serializeAddress("deployment", "sortedTroves", d.sortedTroves);
        vm.serializeAddress("deployment", "zappers", d.zappers);
        vm.serializeAddress("deployment", "stockOracles", _toAddresses(d.oracles));
        vm.serializeAddress("deployment", "secondaryStockOracles", _toAddresses(d.secondaryOracles));
        string memory json = vm.serializeAddress("deployment", "priceFeeds", d.priceFeeds);
        vm.writeJson(json, "deployment-stock-robinhood-mainnet.json");
    }

    function _toAddresses(IERC20Metadata[] memory values) internal pure returns (address[] memory result) {
        result = new address[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            result[i] = address(values[i]);
        }
    }

    function _toAddresses(IAddressesRegistry[] memory values) internal pure returns (address[] memory result) {
        result = new address[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            result[i] = address(values[i]);
        }
    }

    function _toAddresses(ITroveManager[] memory values) internal pure returns (address[] memory result) {
        result = new address[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            result[i] = address(values[i]);
        }
    }

    function _toAddresses(AggregatorV3Interface[] memory values) internal pure returns (address[] memory result) {
        result = new address[](values.length);
        for (uint256 i = 0; i < values.length; ++i) {
            result[i] = address(values[i]);
        }
    }

    function _bytes32ToString(bytes32 value) internal pure returns (string memory) {
        uint256 length;
        while (length < 32 && value[length] != 0) ++length;
        bytes memory result = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            result[i] = value[i];
        }
        return string(result);
    }
}
