// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IProbeToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}
interface IProbePool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

/// @notice Simulation-only runtime injected through eth_call state overrides.
/// Never deployed or sent a transaction. Only the executor code and its input
/// token balance are overridden; pool liquidity and token transfer rules are real.
contract DockyardReadOnlySaleProbe {
    address private venue;
    address private token;
    uint256 private remaining;
    bool private zeroForOne;

    function sell(address pool, address input, address output, uint256 amount) external returns (uint256 received) {
        require(venue == address(0) && amount > 0 && amount <= uint256(type(int256).max), "InvalidProbe");
        zeroForOne = IProbePool(pool).token0() == input;
        require(IProbePool(pool).token0() == (zeroForOne ? input : output)
            && IProbePool(pool).token1() == (zeroForOne ? output : input), "WrongPair");
        uint256 beforeInput = IProbeToken(input).balanceOf(address(this));
        uint256 beforeOutput = IProbeToken(output).balanceOf(address(this));
        venue = pool;
        token = input;
        remaining = amount;
        IProbePool(pool).swap(address(this), zeroForOne, int256(amount),
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341), "");
        require(remaining == 0 && IProbeToken(input).balanceOf(address(this)) == beforeInput - amount, "IncompleteSale");
        received = IProbeToken(output).balanceOf(address(this)) - beforeOutput;
        require(received > 0, "EmptySale");
        venue = address(0);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == venue && remaining > 0, "UnexpectedCallback");
        int256 due = zeroForOne ? d0 : d1;
        require(due > 0 && (zeroForOne ? d1 : d0) <= 0 && uint256(due) <= remaining, "InvalidDelta");
        remaining -= uint256(due);
        require(IProbeToken(token).transfer(msg.sender, uint256(due)), "TransferFailed");
    }
}
