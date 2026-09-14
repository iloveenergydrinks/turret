// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretP2PLendingV3} from "./TurretP2PLendingV3.sol";

/// @notice Constructor-only deployment of a bounded set of independent V3 managers.
/// @dev Holds no custody and retains no authority over any deployed market.
contract TurretP2PBatchDeployerV3 {
    address[] private _markets;
    error InvalidAssets();
    event MarketDeployed(address indexed collateralToken, address indexed market);

    constructor(IERC20 loanToken, IERC20[] memory collateralTokens, address guardian) {
        if (collateralTokens.length == 0 || collateralTokens.length > 20) revert InvalidAssets();
        for (uint256 i; i < collateralTokens.length; ++i) {
            for (uint256 j; j < i; ++j) {
                if (collateralTokens[i] == collateralTokens[j]) revert InvalidAssets();
            }
            address market = address(new TurretP2PLendingV3(loanToken, collateralTokens[i], guardian));
            _markets.push(market);
            emit MarketDeployed(address(collateralTokens[i]), market);
        }
    }

    function getMarkets() external view returns (address[] memory) { return _markets; }
}
