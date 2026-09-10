// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {DockyardIsolatedCapitalPool} from "reviewed/research/DockyardIsolatedCapitalPool.sol";

/// @notice The existing isolated ERC-4626 accounting with Turret share metadata.
contract TurretCapitalPool is DockyardIsolatedCapitalPool {
    constructor(IERC20Metadata usdg,address collateral,address engine,address treasury,
        uint256 limit,uint16 feeBps,uint16 aprBps)
        DockyardIsolatedCapitalPool(usdg,collateral,engine,treasury,limit,feeBps,aprBps) {}
    function name() public pure override(ERC20,IERC20Metadata) returns(string memory){return "Turret lender share";}
    function symbol() public pure override(ERC20,IERC20Metadata) returns(string memory){return "tLS";}
}
