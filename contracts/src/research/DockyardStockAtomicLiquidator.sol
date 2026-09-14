// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardAtomicLiquidator} from "./DockyardAtomicLiquidator.sol";
import {DockyardStockCreditEngine} from "./DockyardStockCreditEngine.sol";

/// @notice Candidate stock liquidation-and-sale executor. Validates fresh chain
/// liveness before the existing atomic, profit-bounded two-hop sale operation.
/// No arbitrary calls, receiver override, administrative sweep or proof bypass.
contract DockyardStockAtomicLiquidator is DockyardAtomicLiquidator {
    address public immutable executionGate;

    constructor(address engine_, address intermediate_, address first_, address second_, address factory_)
        DockyardAtomicLiquidator(engine_, intermediate_, first_, second_, factory_)
    {
        DockyardStockCreditEngine stock = DockyardStockCreditEngine(engine_);
        executionGate = address(stock.executionGate());
        if (executionGate.code.length == 0 || address(stock.stockGuard()).code.length == 0) {
            revert InvalidConfiguration();
        }
    }

    function liquidateAndSellChecked(
        address borrower,
        uint256 maxRepay,
        uint256 minCollateral,
        uint256 minProfit,
        uint256 deadline,
        bytes calldata liveness
    ) external returns (uint256 paid, uint256 seized, uint256 usdgOut) {
        if (!routeHealthy()) revert RouteChanged();
        DockyardStockCreditEngine(address(engine)).priceWithLiveness(liveness);
        return liquidateAndSell(borrower, maxRepay, minCollateral, minProfit, deadline);
    }
}
