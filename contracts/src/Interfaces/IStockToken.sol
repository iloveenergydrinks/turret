// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

/// @notice Robinhood Stock Token oracle-liveness extension.
interface IStockToken {
    function oraclePaused() external view returns (bool);
}
