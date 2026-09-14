// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Fixed implementation for isolated offer custody. No initializer or upgrade authority.
/// @dev Every clone uses the implementation's immutable manager and token pair. The manager is
///      non-upgradeable and authorizes transfers only through its loan and owned-credit rules.
contract TurretP2PVaultV3 {
    using SafeERC20 for IERC20;
    address public immutable manager;
    IERC20 public immutable loanToken;
    IERC20 public immutable collateralToken;

    error Unauthorized();
    error InvalidTransfer();
    error UnsupportedTransfer();

    constructor(address manager_, IERC20 loanToken_, IERC20 collateralToken_) {
        manager = manager_;
        loanToken = loanToken_;
        collateralToken = collateralToken_;
    }

    function transferTo(IERC20 token, address recipient, uint256 amount) external {
        if (msg.sender != manager) revert Unauthorized();
        if ((token != loanToken && token != collateralToken) || amount == 0
            || recipient == address(0) || recipient == address(this)) revert InvalidTransfer();
        uint256 beforeVault = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (token.balanceOf(address(this)) != beforeVault - amount
            || token.balanceOf(recipient) != beforeRecipient + amount) revert UnsupportedTransfer();
    }
}
