// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {BoldToken} from "src/BoldToken.sol";

contract RUSDTokenTest is Test {
    function testForkExposesRUSDIdentity() external {
        BoldToken token = new BoldToken(address(this));

        assertEq(token.name(), "rUSD Stablecoin");
        assertEq(token.symbol(), "rUSD");
        assertEq(token.decimals(), 18);
    }
}
