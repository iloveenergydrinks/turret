// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IForkV3Pool} from "./DockyardIsolatedMarketsFork.t.sol";

/// @notice Test-only swap/spot helper, deployed exclusively on loopback Anvil.
/// This is not a production router or oracle. No external account is impersonated.
contract DockyardForkSwapHarness {
    address public immutable owner = msg.sender;
    address private callbackPool;
    address private callbackToken;
    uint256 private callbackBudget;

    function spot(address venue, address input, uint256 amount) external view returns (uint256) {
        (uint160 sqrtPrice,,,,,,) = IForkV3Pool(venue).slot0();
        uint256 ratioX64 = Math.mulDiv(sqrtPrice, sqrtPrice, 1 << 128);
        if (IForkV3Pool(venue).token0() == input) return Math.mulDiv(amount, ratioX64, 1 << 64);
        require(IForkV3Pool(venue).token1() == input, "Wrong input");
        return Math.mulDiv(amount, 1 << 64, ratioX64);
    }

    function swap(address input, address venue, uint256 amount) external returns (uint256 output) {
        require(msg.sender == owner && callbackPool == address(0), "Unauthorized");
        require(amount > 0 && amount <= uint256(type(int256).max), "Invalid amount");
        IForkV3Pool p = IForkV3Pool(venue);
        bool zero = p.token0() == input;
        require(zero || p.token1() == input, "Wrong input");
        address out = zero ? p.token1() : p.token0();
        uint256 beforeBalance = IERC20(out).balanceOf(address(this));
        require(IERC20(input).transferFrom(msg.sender, address(this), amount));
        callbackPool = venue;
        callbackToken = input;
        callbackBudget = amount;
        p.swap(
            address(this),
            zero,
            int256(amount),
            zero ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
            ""
        );
        require(callbackBudget == 0, "Incomplete swap");
        callbackPool = address(0);
        callbackToken = address(0);
        output = IERC20(out).balanceOf(address(this)) - beforeBalance;
        require(output != 0 && IERC20(out).transfer(msg.sender, output));
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == callbackPool && callbackPool != address(0), "Unexpected callback");
        bool zero = d0 > 0;
        require(zero ? d1 <= 0 : d1 > 0, "Invalid deltas");
        address input = zero ? IForkV3Pool(msg.sender).token0() : IForkV3Pool(msg.sender).token1();
        uint256 owed = uint256(zero ? d0 : d1);
        require(input == callbackToken && owed <= callbackBudget, "Invalid payment");
        callbackBudget -= owed;
        require(IERC20(input).transfer(msg.sender, owed));
    }
}
