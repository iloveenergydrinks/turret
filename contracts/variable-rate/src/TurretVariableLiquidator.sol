// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {DockyardKyberCollateralFundedLiquidator} from "kyber/DockyardKyberCollateralFundedLiquidator.sol";
import {TurretVariableCreditEngine} from "./TurretVariableCreditEngine.sol";

/// @notice Existing collateral-funded settlement and router checks, with one
/// current operator price replacing the old oracle/gate submission chain.
contract TurretVariableLiquidator is DockyardKyberCollateralFundedLiquidator {
    constructor(address engine_,address intermediate_,address first_,address second_,address factory_,
        address router_,bytes32 routerHash_,address target_,bytes32 targetHash_)
        DockyardKyberCollateralFundedLiquidator(engine_,intermediate_,first_,second_,factory_,router_,routerHash_,target_,targetHash_) {}

    // Retain the existing keeper's transaction/receipt journal ABI. The encoded
    // certificate uses the Turret price domain, not an execution-gate proof.
    function liquidateAndSellChecked(address borrower,uint256 maximum,uint256 minimumCollateral,
        uint256 minimumProfit,uint256 deadline,bytes calldata encoded)
        external nonReentrant returns(uint256 paid,uint256 seized,uint256 usdgOut) {
        if(!routeHealthy())revert RouteChanged();
        TurretVariableCreditEngine(address(engine)).priceWithApproval(encoded);
        return _execute(borrower,maximum,minimumCollateral,minimumProfit,deadline,"");
    }

    function liquidateAndSellRoutedChecked(address borrower,uint256 maximum,uint256 minimumCollateral,
        uint256 minimumProfit,uint256 deadline,bytes calldata encoded,bytes calldata swapData)
        external nonReentrant returns(uint256 paid,uint256 seized,uint256 usdgOut) {
        if(swapData.length<4||swapData.length>65536)revert InvalidAmount();
        TurretVariableCreditEngine(address(engine)).priceWithApproval(encoded);
        return _execute(borrower,maximum,minimumCollateral,minimumProfit,deadline,swapData);
    }

    function liquidateAndSellApproved(address borrower,uint256 maximum,uint256 minimumCollateral,
        uint256 minimumProfit,uint256 deadline,TurretVariableCreditEngine.Price calldata p,bytes calldata signature)
        external nonReentrant returns(uint256 paid,uint256 seized,uint256 usdgOut) {
        if(!routeHealthy()) revert RouteChanged();
        TurretVariableCreditEngine(address(engine)).submitPrice(p,signature);
        return _execute(borrower,maximum,minimumCollateral,minimumProfit,deadline,"");
    }

    function liquidateAndSellRoutedApproved(address borrower,uint256 maximum,uint256 minimumCollateral,
        uint256 minimumProfit,uint256 deadline,TurretVariableCreditEngine.Price calldata p,bytes calldata signature,bytes calldata swapData)
        external nonReentrant returns(uint256 paid,uint256 seized,uint256 usdgOut) {
        if(swapData.length<4||swapData.length>65536)revert InvalidAmount();
        TurretVariableCreditEngine(address(engine)).submitPrice(p,signature);
        return _execute(borrower,maximum,minimumCollateral,minimumProfit,deadline,swapData);
    }
}
