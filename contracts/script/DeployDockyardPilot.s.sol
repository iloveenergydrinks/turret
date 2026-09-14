// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DockyardUSDGCreditVaultPilot} from "src/DockyardUSDGCreditVaultPilot.sol";
import {DockyardChainlinkGuard} from "src/Oracles/DockyardChainlinkGuard.sol";

/// @notice Deploys a paused, unfunded, allowlisted pilot. Does not migrate V1 or enable any market.
contract DeployDockyardPilot is Script {
    string config;
    string marketsJson;
    address guardian;
    function run() external returns(DockyardUSDGCreditVaultPilot vault) {
        require(block.chainid==4663,"Robinhood only");
        config=vm.readFile("./utils/assets/dockyard-pilot-config.json");
        require(vm.parseJsonUint(config,".chainId")==block.chainid,"Config chain");
        address usdg=vm.parseJsonAddress(config,".usdg");
        require(usdg==0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,"Canonical USDG");
        uint256 key=vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner=vm.parseJsonAddress(config,".owner");
        address keeper=vm.parseJsonAddress(config,".keeper");
        guardian=vm.envAddress("RISK_GUARDIAN_ADDRESS");
        require(guardian!=address(0)&&guardian!=owner&&guardian!=keeper&&guardian!=vm.addr(key),"Dedicated guardian");
        require(vm.parseJsonUint(config,".globalDebtCeiling")==250e6&&vm.parseJsonUint(config,".originationFeeBps")==50,"Pilot limits");
        vm.startBroadcast(key);
        vault=new DockyardUSDGCreditVaultPilot(usdg,vm.addr(key));
        address[] memory borrowers=vm.parseJsonAddressArray(config,".borrowers");
        for(uint256 i;i<borrowers.length;++i)vault.setBorrowerAllowed(borrowers[i],true);
        uint256 count=abi.decode(vm.parseJson(config,".markets[*].collateral"),(address[])).length;
        require(count>0&&count<=10,"Market count");
        marketsJson="[";
        for(uint256 i;i<count;++i)_market(vault,i);
        marketsJson=string.concat(marketsJson,"]");
        vault.transferOwnership(owner);
        vm.stopBroadcast();
        vm.serializeJson("pilot",string.concat('{"markets":',marketsJson,"}"));
        vm.serializeString("pilot","kind","chainlink-guarded-pilot");
        vm.serializeString("pilot","status",vm.isContext(VmSafe.ForgeContext.ScriptDryRun)?"simulation-only":"candidate-requires-receipt-verification");
        vm.serializeUint("pilot","chainId",4663);
        vm.serializeUint("pilot","startBlock",block.number);
        vm.serializeAddress("pilot","vault",address(vault));
        vm.serializeBytes32("pilot","vaultCodeHash",address(vault).codehash);
        vm.serializeAddress("pilot","owner",owner);
        vm.serializeAddress("pilot","keeper",keeper);
        vm.serializeAddress("pilot","guardian",guardian);
        string memory json=vm.serializeBool("pilot","marketDataVerified",false);
        vm.writeJson(json,"./utils/assets/test_output/dockyard-pilot-candidate.json");
        console2.log("Paused, unfunded pilot",address(vault));
        console2.log("Guardian",guardian);
    }
    function _market(DockyardUSDGCreditVaultPilot vault,uint256 i) internal {
        string memory path=string.concat(".markets[",vm.toString(i),"]");
        address collateral=vm.parseJsonAddress(config,string.concat(path,".collateral"));
        address primary=vm.parseJsonAddress(config,string.concat(path,".primaryOracle"));
        DockyardChainlinkGuard guard=new DockyardChainlinkGuard(collateral,primary,guardian);
        vault.addMarket(collateral,primary,address(guard),uint128(_number(path,"debtCeiling",50e6)),
            uint16(_number(path,"maxLtvBps",3000)),uint16(_number(path,"liquidationLtvBps",4000)),
            uint16(_number(path,"liquidationBonusBps",500)),uint16(_number(path,"maxDeviationBps",200)));
        string memory name=string.concat("pilotmarket",vm.toString(i));
        vm.serializeString(name,"symbol",vm.parseJsonString(config,string.concat(path,".symbol")));
        vm.serializeAddress(name,"collateral",collateral);vm.serializeAddress(name,"primaryOracle",primary);
        vm.serializeAddress(name,"adapter",address(guard));
        string memory json=vm.serializeBytes32(name,"adapterCodeHash",address(guard).codehash);
        marketsJson=string.concat(marketsJson,i==0?"":",",json);
    }
    function _number(string memory path,string memory field,uint256 max) internal view returns(uint256 value) {
        value=vm.parseJsonUint(config,string.concat(path,".",field));require(value<=max,"Pilot risk limit");
    }
}
