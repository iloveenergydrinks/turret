// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// @dev Test token only. Refuses deployment outside the local development chain.
contract LocalToken is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        require(block.chainid == 31337, "Local development only");
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) { return tokenDecimals; }

    function mint(address account, uint256 amount) external {
        require(block.chainid == 31337, "Local development only");
        _mint(account, amount);
    }
}
