// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderFacility} from "./TurretLenderFacility.sol";

/// @notice Creates one isolated reusable lending balance per lender and admitted collateral.
/// @dev No custody, administrator, upgrade path, delegated deployment or protocol fee.
contract TurretLenderFacilityFactory {
    IERC20 public immutable loanToken;
    mapping(address => bool) public collateralAllowed;
    mapping(address => mapping(address => address)) public getFacility;
    mapping(address => uint256) public createdAtBlock;
    address[] public facilities;

    error InvalidCollateral();
    error AlreadyCreated();
    event FacilityCreated(address indexed lender, address indexed collateral, address indexed facility);

    constructor(IERC20 cash, address[] memory collateral) {
        if (address(cash).code.length == 0 || collateral.length == 0 || collateral.length > 100) revert InvalidCollateral();
        loanToken = cash;
        for (uint256 i; i < collateral.length; ++i) {
            address token = collateral[i];
            if (token == address(cash) || token.code.length == 0 || collateralAllowed[token]) revert InvalidCollateral();
            collateralAllowed[token] = true;
        }
    }

    function createFacility(address collateral, TurretLenderFacility.Limits calldata limits) external returns (address facility) {
        if (!collateralAllowed[collateral]) revert InvalidCollateral();
        if (getFacility[msg.sender][collateral] != address(0)) revert AlreadyCreated();
        // Constructor makes no calls to lender or collateral. The fixed implementation does
        // not transfer funds during creation, so there is no callback before registration.
        facility = address(new TurretLenderFacility(loanToken, IERC20(collateral), msg.sender, msg.sender, 0, limits));
        getFacility[msg.sender][collateral] = facility;
        createdAtBlock[facility] = block.number;
        facilities.push(facility);
        emit FacilityCreated(msg.sender, collateral, facility);
    }

    function facilityCount() external view returns (uint256) { return facilities.length; }
}
