// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {VariableCreditBase} from "./VariableCreditBase.sol";
import {TurretVariableCreditEngine} from "./TurretVariableCreditEngine.sol";
import {TurretVariableCapitalPool} from "./TurretVariableCapitalPool.sol";

/// @notice Create and bind one empty, paused market atomically. The deployment
/// helper retains no permissions over the engine, pool or owner funds.
contract TurretVariableMarketDeployment {
    TurretVariableCreditEngine public immutable engine;
    TurretVariableCapitalPool public immutable pool;
    constructor(VariableCreditBase.Config memory c,address signer,uint256 cap,uint16 feeBps,uint16 baseBps,uint16 kinkBps,uint16 maxBps,uint16 kinkUtilizationBps) {
        address owner=c.guardian;
        c.guardian=address(this);
        engine=new TurretVariableCreditEngine(c,signer);
        pool=new TurretVariableCapitalPool(IERC20Metadata(c.usdg),c.collateral,address(engine),owner,cap,feeBps,baseBps,kinkBps,maxBps,kinkUtilizationBps);
        engine.bindPool(pool);
        engine.transferOwnership(owner);
    }
}
