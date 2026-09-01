// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";

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
import {ISortedTroves} from "src/Interfaces/ISortedTroves.sol";
import {IStabilityPool} from "src/Interfaces/IStabilityPool.sol";
import {ITroveManager} from "src/Interfaces/ITroveManager.sol";
import {ITroveNFT} from "src/Interfaces/ITroveNFT.sol";
import {IWETH} from "src/Interfaces/IWETH.sol";
import {IMetadataNFT} from "src/NFTMetadata/MetadataNFT.sol";
import {WETHTester} from "test/TestContracts/WETHTester.sol";

contract SandcastleStockToken is ERC20 {
    address public immutable operator;
    mapping(address => uint256) public lastTap;
    bool public oraclePaused;

    error NotOperator();
    error FaucetCooldown();

    constructor(string memory symbol_, address operator_) ERC20(string.concat(symbol_, " Stock Token Mock"), symbol_) {
        operator = operator_;
    }

    function tap() external {
        if (lastTap[msg.sender] != 0 && block.timestamp < lastTap[msg.sender] + 1 days) revert FaucetCooldown();
        lastTap[msg.sender] = block.timestamp;
        _mint(msg.sender, 1_000e18);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        _mint(to, amount);
    }

    function setOraclePaused(bool paused) external {
        if (msg.sender != operator) revert NotOperator();
        oraclePaused = paused;
    }
}

contract SandcastleOracle is AggregatorV3Interface {
    uint8 public immutable override decimals;
    address public immutable operator;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    error NotOperator();

    constructor(uint8 decimals_, int256 answer_, address operator_) {
        decimals = decimals_;
        answer = answer_;
        operator = operator_;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    function updateAnswer(int256 answer_) external {
        if (msg.sender != operator) revert NotOperator();
        roundId++;
        answer = answer_;
        startedAt = block.timestamp;
        updatedAt = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, roundId);
    }
}

    contract SandcastleMetadataNFT is IMetadataNFT {
        function uri(TroveData memory) external pure returns (string memory) {
            return 'data:application/json,{"name":"StockUSD Sandcastle Trove"}';
        }
    }

    contract SandcastleInterestRouter is IInterestRouter {}

    contract SandcastleDisabledExchange is IExchange {
        error LeverageDisabled();

        function swapFromBold(uint256, uint256) external pure {
            revert LeverageDisabled();
        }

        function swapToBold(uint256, uint256) external pure returns (uint256) {
            revert LeverageDisabled();
        }
    }

    /// @notice Complete ten-branch deployment for Anvil or Robinhood Chain testnet.
    /// @dev Deploys mock Stock Tokens and mock oracles. Never use this script for production.
    contract DeployStockTokenSandcastle is Script {
        uint256 internal constant BCR = 10e16;
        uint256 internal constant LIQUIDATION_PENALTY_SP = 5e16;
        uint256 internal constant LIQUIDATION_PENALTY_REDISTRIBUTION = 10e16;
        uint256 internal constant ORACLE_STALENESS = 1 hours;
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
            WETHTester weth;
            SandcastleOracle sequencerFeed;
            SandcastleInterestRouter interestRouter;
            SandcastleDisabledExchange disabledExchange;
            SandcastleMetadataNFT metadataNFT;
            StockTokenConfig.Config[] configs;
            IERC20Metadata[] collaterals;
            IAddressesRegistry[] registries;
            ITroveManager[] troveManagers;
            SandcastleOracle[] oracles;
            SandcastleOracle[] secondaryOracles;
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

        function run() external {
            require(block.chainid == 31_337 || block.chainid == 46_630, "sandcastle: unsupported chain");

            uint256 deploymentBlock = block.number;
            uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
            address deployer = vm.addr(deployerKey);
            bytes32 salt = keccak256(bytes(vm.envOr("SANDCASTLE_SALT", string("rusd-stock-token-sandcastle-v1"))));
            vm.startBroadcast(deployerKey);

            DeploymentState memory d = _deployTopLevel(deployer, salt);
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
            _writeManifest(d, deploymentBlock);
        }

        function _deployTopLevel(address deployer, bytes32 salt) internal returns (DeploymentState memory d) {
            d.stablecoin = new BoldToken(deployer);
            d.weth = new WETHTester(1 ether, 1 days);
            d.sequencerFeed = new SandcastleOracle(0, 0, deployer);
            d.interestRouter = new SandcastleInterestRouter();
            d.disabledExchange = new SandcastleDisabledExchange();
            d.metadataNFT = new SandcastleMetadataNFT();
            d.configs = StockTokenConfig.all();
            d.collaterals = new IERC20Metadata[](d.configs.length);
            d.registries = new IAddressesRegistry[](d.configs.length);
            d.troveManagers = new ITroveManager[](d.configs.length);
            d.oracles = new SandcastleOracle[](d.configs.length);
            d.secondaryOracles = new SandcastleOracle[](d.configs.length);

            for (uint256 i = 0; i < d.configs.length; ++i) {
                d.collaterals[i] = new SandcastleStockToken(_bytes32ToString(d.configs[i].symbol), deployer);
                d.oracles[i] = new SandcastleOracle(8, int256(_initialPrice(i) * 1e8), deployer);
                d.secondaryOracles[i] = new SandcastleOracle(8, int256(_initialPrice(i) * 1e8), deployer);
                d.registries[i] = _deployAddressesRegistry(d.configs[i], deployer);
                d.troveManagers[i] =
                    ITroveManager(_computeCreate2Address(type(TroveManager).creationCode, d.registries[i], salt));
            }

            d.collateralRegistry = new CollateralRegistry(d.stablecoin, d.collaterals, d.troveManagers);
            d.hintHelpers = new HintHelpers(d.collateralRegistry);
            d.multiTroveGetter = new MultiTroveGetter(d.collateralRegistry);
            d.borrowerOperations = new address[](d.configs.length);
            d.stabilityPools = new address[](d.configs.length);
            d.priceFeeds = new address[](d.configs.length);
            d.troveNFTs = new address[](d.configs.length);
            d.activePools = new address[](d.configs.length);
            d.defaultPools = new address[](d.configs.length);
            d.gasPools = new address[](d.configs.length);
            d.collSurplusPools = new address[](d.configs.length);
            d.sortedTroves = new address[](d.configs.length);
            d.zappers = new address[](d.configs.length);
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
                    WETH: IWETH(address(d.weth))
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
                .setBranchAddresses(
                    actual.troveManager, actual.stabilityPool, actual.borrowerOperations, actual.activePool
                );
            GasCompZapper zapper = new GasCompZapper(
                d.registries[i], IFlashLoanProvider(address(0)), d.disabledExchange
            );
            console2.log(_bytes32ToString(d.configs[i].symbol), address(d.collaterals[i]));
            return (actual, address(priceFeed), address(zapper));
        }

        function _requireAddressesMatch(BranchAddresses memory expected, BranchAddresses memory actual) internal pure {
            require(actual.borrowerOperations == expected.borrowerOperations, "sandcastle: BO address mismatch");
            require(actual.troveManager == expected.troveManager, "sandcastle: TM address mismatch");
            require(actual.troveNFT == expected.troveNFT, "sandcastle: NFT address mismatch");
            require(actual.stabilityPool == expected.stabilityPool, "sandcastle: SP address mismatch");
            require(actual.activePool == expected.activePool, "sandcastle: AP address mismatch");
            require(actual.defaultPool == expected.defaultPool, "sandcastle: DP address mismatch");
            require(actual.gasPool == expected.gasPool, "sandcastle: GP address mismatch");
            require(actual.collSurplusPool == expected.collSurplusPool, "sandcastle: CSP address mismatch");
            require(actual.sortedTroves == expected.sortedTroves, "sandcastle: ST address mismatch");
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

        function _writeManifest(DeploymentState memory d, uint256 deploymentBlock) internal {
            address[] memory collateralAddresses = _toAddresses(d.collaterals);
            address[] memory registryAddresses = _toAddresses(d.registries);
            address[] memory troveManagerAddresses = _toAddresses(d.troveManagers);
            address[] memory oracleAddresses = _toAddresses(d.oracles);
            address[] memory secondaryOracleAddresses = _toAddresses(d.secondaryOracles);

            vm.serializeUint("deployment", "chainId", block.chainid);
            vm.serializeUint("deployment", "deploymentBlock", deploymentBlock);
            vm.serializeAddress("deployment", "stablecoin", address(d.stablecoin));
            vm.serializeAddress("deployment", "collateralRegistry", address(d.collateralRegistry));
            vm.serializeAddress("deployment", "hintHelpers", address(d.hintHelpers));
            vm.serializeAddress("deployment", "multiTroveGetter", address(d.multiTroveGetter));
            vm.serializeAddress("deployment", "debtInFrontHelper", address(d.debtInFrontHelper));
            vm.serializeAddress("deployment", "redemptionHelper", address(d.redemptionHelper));
            vm.serializeAddress("deployment", "disabledExchange", address(d.disabledExchange));
            vm.serializeAddress("deployment", "weth", address(d.weth));
            vm.serializeAddress("deployment", "sequencerFeed", address(d.sequencerFeed));
            vm.serializeAddress("deployment", "stockTokens", collateralAddresses);
            vm.serializeAddress("deployment", "addressRegistries", registryAddresses);
            vm.serializeAddress("deployment", "troveManagers", troveManagerAddresses);
            vm.serializeAddress("deployment", "borrowerOperations", d.borrowerOperations);
            vm.serializeAddress("deployment", "stabilityPools", d.stabilityPools);
            vm.serializeAddress("deployment", "troveNFTs", d.troveNFTs);
            vm.serializeAddress("deployment", "activePools", d.activePools);
            vm.serializeAddress("deployment", "defaultPools", d.defaultPools);
            vm.serializeAddress("deployment", "gasPools", d.gasPools);
            vm.serializeAddress("deployment", "collSurplusPools", d.collSurplusPools);
            vm.serializeAddress("deployment", "sortedTroves", d.sortedTroves);
            vm.serializeAddress("deployment", "zappers", d.zappers);
            vm.serializeAddress("deployment", "stockOracles", oracleAddresses);
            vm.serializeAddress("deployment", "secondaryStockOracles", secondaryOracleAddresses);
            string memory json = vm.serializeAddress("deployment", "priceFeeds", d.priceFeeds);
            vm.writeJson(json, "deployment-stock-sandcastle.json");
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

        function _toAddresses(SandcastleOracle[] memory values) internal pure returns (address[] memory result) {
            result = new address[](values.length);
            for (uint256 i = 0; i < values.length; ++i) {
                result[i] = address(values[i]);
            }
        }

        function _initialPrice(uint256 index) internal pure returns (uint256) {
            uint256[10] memory prices = [uint256(230), 510, 335, 258, 570, 218, 370, 1_150, 945, 366];
            return prices[index];
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
