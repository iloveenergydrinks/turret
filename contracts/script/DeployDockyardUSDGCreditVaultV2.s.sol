// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardUSDGCreditVaultV2} from "src/DockyardUSDGCreditVaultV2.sol";
import {DockyardPythVerifier} from "src/Oracles/DockyardPythVerifier.sol";
import {DockyardDualOracle} from "src/Oracles/DockyardDualOracle.sol";
import {DockyardOracleRelay} from "src/Oracles/DockyardOracleRelay.sol";

/// @notice Creates a paused, unfunded candidate; never moves old-vault assets or enables loans.
contract DeployDockyardUSDGCreditVaultV2 is Script {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant PYTH = 0xACeA761c27A909d4D3895128EBe6370FDE2dF481;
    string config;
    address[] adapters;
    string marketsJson;

    function run() external returns (DockyardUSDGCreditVaultV2 vault, DockyardOracleRelay relay) {
        require(block.chainid == 4663, "Wrong chain");
        config = vm.readFile("./utils/assets/dockyard-v2-config.json");
        require(vm.parseJsonUint(config, ".chainId") == block.chainid, "Config chain");
        require(vm.parseJsonAddress(config, ".usdg") == USDG && IERC20Metadata(USDG).decimals() == 6, "Canonical USDG");
        require(
            vm.parseJsonAddress(config, ".verifier") == PYTH
                && PYTH.codehash == vm.parseJsonBytes32(config, ".verifierCodeHash"),
            "Pyth verifier changed"
        );
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.parseJsonAddress(config, ".owner");
        require(owner != address(0), "Owner");
        uint256 fee = vm.parseJsonUint(config, ".originationFeeBps");
        require(fee <= 500, "Origination fee");
        // Activation is separate. Even a broadcast produces only a paused, unfunded candidate.
        vm.startBroadcast(key);
        vault = new DockyardUSDGCreditVaultV2(
            USDG, vm.addr(key), uint16(fee), vm.parseJsonUint(config, ".globalDebtCeiling")
        );
        DockyardPythVerifier hub = new DockyardPythVerifier(PYTH);
        uint256 count = abi.decode(vm.parseJson(config, ".markets[*].feedId"), (uint256[])).length;
        require(count > 0 && count <= 32, "Market count");
        marketsJson = "[";
        for (uint256 i; i < count; ++i) {
            _deployMarket(vault, hub, i);
        }
        marketsJson = string.concat(marketsJson, "]");
        relay = new DockyardOracleRelay(address(hub), adapters);
        vault.transferOwnership(owner);
        vm.stopBroadcast();
        _manifest(vault, hub, relay, owner);
        console2.log("V2 candidate (paused, zero liquidity)", address(vault));
        console2.log("Oracle relay", address(relay));
    }

    function _number(string memory path, string memory field, uint256 max) internal view returns (uint256 value) {
        value = vm.parseJsonUint(config, string.concat(path, ".", field));
        require(value <= max, "Configuration truncation");
    }

    function _deployMarket(DockyardUSDGCreditVaultV2 vault, DockyardPythVerifier hub, uint256 i) internal {
        string memory path = string.concat(".markets[", vm.toString(i), "]");
        address collateral = vm.parseJsonAddress(config, string.concat(path, ".collateral"));
        address primary = vm.parseJsonAddress(config, string.concat(path, ".primaryOracle"));
        uint32 feed = uint32(_number(path, "feedId", type(uint32).max));
        DockyardDualOracle.Policy memory policy;
        policy.primaryMaxAge = uint32(_number(path, "primaryMaxAge", type(uint32).max));
        policy.independentMaxAge = uint32(_number(path, "independentMaxAge", type(uint32).max));
        policy.recoveryDelay = uint32(_number(path, "recoveryDelay", type(uint32).max));
        policy.observationMaxGap = uint32(_number(path, "observationMaxGap", type(uint32).max));
        policy.maxDeviationBps = uint16(_number(path, "maxDeviationBps", type(uint16).max));
        policy.maxConfidenceBps = uint16(_number(path, "maxConfidenceBps", type(uint16).max));
        policy.minPublishers = uint16(_number(path, "minPublishers", type(uint16).max));
        policy.borrowingSessions = uint8(_number(path, "borrowingSessions", type(uint8).max));
        policy.liquidationSessions = uint8(_number(path, "liquidationSessions", type(uint8).max));
        DockyardDualOracle adapter = new DockyardDualOracle(collateral, primary, address(hub), feed, policy);
        adapters.push(address(adapter));
        vault.addMarket(
            collateral,
            primary,
            address(adapter),
            uint128(_number(path, "debtCeiling", type(uint128).max)),
            uint16(_number(path, "maxLtvBps", type(uint16).max)),
            uint16(_number(path, "liquidationLtvBps", type(uint16).max)),
            uint16(_number(path, "liquidationBonusBps", type(uint16).max)),
            policy.maxDeviationBps
        );
        string memory name = string.concat("v2market", vm.toString(i));
        vm.serializeString(name, "symbol", vm.parseJsonString(config, string.concat(path, ".symbol")));
        vm.serializeAddress(name, "collateral", collateral);
        vm.serializeAddress(name, "primaryOracle", primary);
        vm.serializeUint(name, "feedId", feed);
        vm.serializeAddress(name, "adapter", address(adapter));
        string memory m = vm.serializeBytes32(name, "adapterCodeHash", address(adapter).codehash);
        marketsJson = string.concat(marketsJson, i == 0 ? "" : ",", m);
    }

    function _manifest(
        DockyardUSDGCreditVaultV2 vault,
        DockyardPythVerifier hub,
        DockyardOracleRelay relay,
        address owner
    ) internal {
        string memory json = string.concat('{"markets":', marketsJson, "}");
        vm.serializeJson("v2", json);
        vm.serializeString(
            "v2",
            "status",
            vm.isContext(VmSafe.ForgeContext.ScriptDryRun)
                ? "simulation-only"
                : "candidate-requires-receipt-verification"
        );
        vm.serializeUint("v2", "chainId", block.chainid);
        vm.serializeBool("v2", "equityAccessVerified", false);
        vm.serializeAddress("v2", "owner", owner);
        vm.serializeAddress("v2", "keeper", vm.parseJsonAddress(config, ".keeper"));
        vm.serializeAddress("v2", "vault", address(vault));
        vm.serializeBytes32("v2", "vaultCodeHash", address(vault).codehash);
        vm.serializeAddress("v2", "hub", address(hub));
        vm.serializeBytes32("v2", "hubCodeHash", address(hub).codehash);
        vm.serializeAddress("v2", "relay", address(relay));
        vm.serializeBytes32("v2", "relayCodeHash", address(relay).codehash);
        vm.serializeAddress("v2", "verifier", PYTH);
        json = vm.serializeBytes32("v2", "verifierCodeHash", PYTH.codehash);
        vm.writeJson(json, "./utils/assets/test_output/dockyard-v2-candidate.json");
    }
}
