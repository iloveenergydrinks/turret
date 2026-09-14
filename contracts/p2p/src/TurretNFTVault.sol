// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "openzeppelin-contracts/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Fixed custody implementation cloned once per funded offer. Only its immutable
/// manager can transfer assets, through the manager's immutable settlement rules.
contract TurretNFTVault is IERC721Receiver {
    using SafeERC20 for IERC20;
    address public immutable manager;
    IERC20 public immutable loanToken;
    IERC721 public collection;
    uint256 public tokenId;
    error Unauthorized();
    error InvalidTransfer();
    error UnsupportedTransfer();

    constructor(address manager_, IERC20 loanToken_) {
        manager = manager_;
        loanToken = loanToken_;
    }

    function initialize(IERC721 collection_, uint256 tokenId_) external {
        if (msg.sender != manager || address(collection) != address(0)) revert Unauthorized();
        collection = collection_;
        tokenId = tokenId_;
    }

    function onERC721Received(address operator, address from, uint256 id, bytes calldata)
        external view returns (bytes4)
    {
        if (msg.sender != address(collection) || operator != manager || from == address(0) || id != tokenId) {
            revert InvalidTransfer();
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    function transferUSDG(address recipient, uint256 amount) external {
        if (msg.sender != manager) revert Unauthorized();
        if (recipient == address(0) || recipient == address(this) || amount == 0) revert InvalidTransfer();
        uint256 beforeVault = loanToken.balanceOf(address(this));
        uint256 beforeRecipient = loanToken.balanceOf(recipient);
        loanToken.safeTransfer(recipient, amount);
        if (loanToken.balanceOf(address(this)) != beforeVault - amount
            || loanToken.balanceOf(recipient) != beforeRecipient + amount) revert UnsupportedTransfer();
    }

    function transferNFT(address recipient) external {
        if (msg.sender != manager) revert Unauthorized();
        if (recipient == address(0) || recipient == address(this)) revert InvalidTransfer();
        collection.safeTransferFrom(address(this), recipient, tokenId);
        if (collection.ownerOf(tokenId) != recipient) revert UnsupportedTransfer();
    }
}
