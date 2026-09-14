// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TurretP2PLendingV2, IERC20} from "./TurretP2PLendingV2.sol";

/// @notice One-shot deployment helper. Deploys independent escrows, retains no admin powers.
/// @dev This helper never receives loan funds and cannot add, replace or alter a deployed pair.
contract TurretP2PBatchDeployerV2 {
    address[] public markets;

    error InvalidCollateralList();

    event MarketDeployed(address indexed market, address indexed loanToken, address indexed collateralToken,
        address guardian);

    constructor(IERC20 loanToken, IERC20[] memory collateralTokens, address guardian) {
        if (collateralTokens.length == 0) revert InvalidCollateralList();
        for (uint256 i; i < collateralTokens.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (collateralTokens[i] == collateralTokens[j]) revert InvalidCollateralList();
            }
            TurretP2PLendingV2 market = new TurretP2PLendingV2(loanToken, collateralTokens[i], guardian);
            markets.push(address(market));
            emit MarketDeployed(address(market), address(loanToken), address(collateralTokens[i]), guardian);
        }
    }

    function getMarkets() external view returns (address[] memory) { return markets; }
}
