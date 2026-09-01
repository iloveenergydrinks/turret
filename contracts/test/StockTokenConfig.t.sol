// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "src/StockTokens/StockTokenConfig.sol";

contract StockTokenConfigTest is Test {
    function testManifestContainsTenUniqueConservativeBranches() public pure {
        StockTokenConfig.Config[] memory configs = StockTokenConfig.all();
        assertEq(configs.length, 10);

        for (uint256 i = 0; i < configs.length; ++i) {
            assertTrue(configs[i].symbol != bytes32(0));
            assertTrue(configs[i].robinhoodChainToken != address(0));
            assertGe(configs[i].MCR, 175e16);
            assertGt(configs[i].CCR, configs[i].MCR);
            assertGt(configs[i].MCR, configs[i].SCR);
            assertGt(configs[i].debtCeiling, 0);
            assertLe(configs[i].maxOracleDeviationBps, 2_500);

            for (uint256 j = i + 1; j < configs.length; ++j) {
                assertTrue(configs[i].symbol != configs[j].symbol);
                assertTrue(configs[i].robinhoodChainToken != configs[j].robinhoodChainToken);
            }
        }
    }
}
