// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DockyardUSDGCreditVaultMVP} from "src/DockyardUSDGCreditVaultMVP.sol";
import {DockyardUSDGCreditVaultPilot} from "src/DockyardUSDGCreditVaultPilot.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";

/// @notice Reuses verified heartbeat guards; deploys a paused, unfunded capped MVP.
contract DeployDockyardMVP is Script {
    function run() external {
        require(block.chainid == 4663,"Robinhood only");
        string memory source=vm.readFile("./utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json");
        address previous=vm.parseJsonAddress(source,".vault");
        require(previous.codehash==vm.parseJsonBytes32(source,".vaultCodeHash"),"Previous runtime");
        require(DockyardUSDGCreditVaultPilot(previous).paused()&&DockyardUSDGCreditVaultPilot(previous).totalDebt()==0,"Previous vault must be paused and debt-free");
        address owner=vm.parseJsonAddress(source,".owner");
        address guardian=vm.parseJsonAddress(source,".guardian");
        uint256 key=vm.envUint("DEPLOYER_PRIVATE_KEY");
        require(vm.addr(key)!=owner&&vm.addr(key)!=guardian,"Dedicated deployer");
        vm.startBroadcast(key);
        DockyardExecutionGate gate=new DockyardExecutionGate(guardian);
        DockyardUSDGCreditVaultMVP vault=new DockyardUSDGCreditVaultMVP(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,vm.addr(key),address(gate));
        vault.setBorrowerAllowed(owner,true);
        uint256 count=abi.decode(vm.parseJson(source,".markets[*].collateral"),(address[])).length;
        require(count==10,"Expected ten markets");
        for(uint256 i;i<count;++i){
            string memory p=string.concat(".markets[",vm.toString(i),"]");
            address collateral=vm.parseJsonAddress(source,string.concat(p,".collateral"));
            address primary=vm.parseJsonAddress(source,string.concat(p,".primaryOracle"));
            address adapter=vm.parseJsonAddress(source,string.concat(p,".adapter"));
            require(adapter.codehash==vm.parseJsonBytes32(source,string.concat(p,".adapterCodeHash")),"Adapter runtime");
            require(DockyardHeartbeatGuard(adapter).guardian()==guardian&&DockyardHeartbeatGuard(adapter).MAX_PRICE_AGE()==86400,"Adapter configuration");
            vault.addMarket(collateral,primary,adapter,50e6,3000,4000,500,200);
        }
        vault.transferOwnership(owner);
        vm.stopBroadcast();
        vm.serializeJson("mvp",source);
        vm.serializeString("mvp","revision","execution-gated-mvp");
        vm.serializeString("mvp","status",vm.isContext(VmSafe.ForgeContext.ScriptDryRun)?"simulation-only":"candidate-requires-receipt-verification");
        vm.serializeAddress("mvp","previousVault",previous);
        vm.serializeAddress("mvp","vault",address(vault));
        vm.serializeBytes32("mvp","vaultCodeHash",address(vault).codehash);
        vm.serializeAddress("mvp","executionGate",address(gate));
        vm.serializeBytes32("mvp","executionGateCodeHash",address(gate).codehash);
        vm.serializeBool("mvp","marketDataVerified",false);
        string memory result=vm.serializeUint("mvp","startBlock",block.number);
        vm.writeJson(result,"./utils/assets/test_output/dockyard-mvp-candidate.json");
        console2.log("Paused unfunded MVP",address(vault));
        console2.log("Execution gate",address(gate));
    }
}
