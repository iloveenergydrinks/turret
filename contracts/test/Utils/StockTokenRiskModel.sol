// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @notice Deterministic helpers for stress-testing the sandcastle parameters.
/// @dev This is a scenario model, not a production risk oracle. It assumes a
/// position starts exactly at MCR and debt does not change before liquidation.
library StockTokenRiskModel {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant DECIMAL_PRECISION = 1e18;

    function maxLtvBps(uint256 mcr) internal pure returns (uint256) {
        return Math.mulDiv(DECIMAL_PRECISION, BPS, mcr);
    }

    /// @return The largest whole-basis-point price gap for which collateral
    /// still covers debt plus the selected liquidation penalty.
    function maxGapBpsBeforeShortfall(uint256 mcr, uint256 liquidationPenalty) internal pure returns (uint256) {
        uint256 minimumRemainingValueBps =
            Math.mulDiv(BPS, DECIMAL_PRECISION + liquidationPenalty, mcr, Math.Rounding.Up);
        return minimumRemainingValueBps >= BPS ? 0 : BPS - minimumRemainingValueBps;
    }

    function collateralRatioAfterGap(uint256 initialCollateralRatio, uint256 gapBps) internal pure returns (uint256) {
        if (gapBps >= BPS) return 0;
        return Math.mulDiv(initialCollateralRatio, BPS - gapBps, BPS);
    }

    function gapTriggersCircuitBreaker(uint256 gapBps, uint256 maxDeviationBps) internal pure returns (bool) {
        return gapBps > maxDeviationBps;
    }
}
