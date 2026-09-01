// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "src/StockTokens/StockTokenConfig.sol";
import "test/Utils/StockTokenRiskModel.sol";

contract StockTokenRiskModelTest is Test {
    uint256 internal constant REDISTRIBUTION_PENALTY = 10e16;

    function testExpectedAaplAndTslaThresholds() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();

        assertEq(StockTokenRiskModel.maxLtvBps(configs[0].MCR), 5_714);
        assertEq(StockTokenRiskModel.maxGapBpsBeforeShortfall(configs[0].MCR, 0), 4_285);
        assertEq(StockTokenRiskModel.maxGapBpsBeforeShortfall(configs[0].MCR, REDISTRIBUTION_PENALTY), 3_714);

        assertEq(StockTokenRiskModel.maxLtvBps(configs[9].MCR), 4_000);
        assertEq(StockTokenRiskModel.maxGapBpsBeforeShortfall(configs[9].MCR, 0), 6_000);
        assertEq(StockTokenRiskModel.maxGapBpsBeforeShortfall(configs[9].MCR, REDISTRIBUTION_PENALTY), 5_600);
    }

    function testThirtyPercentGapStillCoversRedistributionPenaltyAtMcr() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();

        for (uint256 i = 0; i < configs.length; ++i) {
            uint256 ratioAfterGap = StockTokenRiskModel.collateralRatioAfterGap(configs[i].MCR, 3_000);
            assertGe(ratioAfterGap, 1e18 + REDISTRIBUTION_PENALTY);
        }
    }

    function testFortyPercentGapCreatesPenaltyShortfallInThreeLowestMcrBranches() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();
        uint256 branchesWithShortfall;

        for (uint256 i = 0; i < configs.length; ++i) {
            uint256 ratioAfterGap = StockTokenRiskModel.collateralRatioAfterGap(configs[i].MCR, 4_000);
            if (ratioAfterGap < 1e18 + REDISTRIBUTION_PENALTY) branchesWithShortfall++;
        }

        assertEq(branchesWithShortfall, 3);
    }

    function testThirtyPercentOneStepGapTripsEveryCurrentCircuitBreaker() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();

        for (uint256 i = 0; i < configs.length; ++i) {
            assertTrue(StockTokenRiskModel.gapTriggersCircuitBreaker(3_000, configs[i].maxOracleDeviationBps));
        }
    }

    function testCircuitBreakerPreemptsPenaltyShortfallForEveryBranch() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();

        for (uint256 i = 0; i < configs.length; ++i) {
            uint256 shortfallGap = StockTokenRiskModel.maxGapBpsBeforeShortfall(configs[i].MCR, REDISTRIBUTION_PENALTY);
            assertLt(configs[i].maxOracleDeviationBps, shortfallGap);
        }
    }

    function testCircuitBreakerAcceptsBoundaryAndRejectsNextBasisPoint() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();

        for (uint256 i = 0; i < configs.length; ++i) {
            uint256 threshold = configs[i].maxOracleDeviationBps;
            assertFalse(StockTokenRiskModel.gapTriggersCircuitBreaker(threshold, threshold));
            assertTrue(StockTokenRiskModel.gapTriggersCircuitBreaker(threshold + 1, threshold));
        }
    }
}
