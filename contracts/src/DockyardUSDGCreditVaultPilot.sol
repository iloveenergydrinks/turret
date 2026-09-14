// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardUSDGCreditVaultV2} from "./DockyardUSDGCreditVaultV2.sol";
import {DockyardChainlinkGuard} from "./Oracles/DockyardChainlinkGuard.sol";

/// @notice Allowlisted pilot: immutable 250 USDG global / maximum 50 USDG market limits.
/// Requires canonical 6-decimal USDG; no public-launch switch or cap-increase escape hatch.
contract DockyardUSDGCreditVaultPilot is DockyardUSDGCreditVaultV2 {
    mapping(address => bool) public borrowerAllowed;
    uint256 public constant MAX_MARKET_DEBT = 50e6;
    error BorrowerNotAllowed();
    event BorrowerPermission(address indexed borrower, bool allowed);

    constructor(address usdg_, address owner_) DockyardUSDGCreditVaultV2(usdg_, owner_, 50, 250e6) {
        if (usdgTo18Scale != 1e12) revert InvalidUSDGDecimals();
    }

    function setBorrowerAllowed(address borrower, bool allowed) external onlyOwner {
        if (borrower == address(0)) revert ZeroAddress();
        borrowerAllowed[borrower] = allowed;
        emit BorrowerPermission(borrower, allowed);
    }

    function addMarket(address collateral, address primary, address secondary, uint128 ceiling,
        uint16 maxLtv, uint16 liquidationLtv, uint16 bonus, uint16 deviation) public override onlyOwner {
        if (ceiling > MAX_MARKET_DEBT || maxLtv > 3000 || liquidationLtv > 4000 || bonus > 500 || deviation != 200) {
            revert InvalidRiskParameters();
        }
        super.addMarket(collateral, primary, secondary, ceiling, maxLtv, liquidationLtv, bonus, deviation);
    }

    function setDebtCeiling(address collateral, uint128 ceiling) public override onlyOwner {
        if (ceiling > MAX_MARKET_DEBT) revert InvalidRiskParameters();
        super.setDebtCeiling(collateral, ceiling);
    }

    function _borrow(address collateral, address borrower, uint256 amount) internal override {
        if (!borrowerAllowed[borrower]) revert BorrowerNotAllowed();
        super._borrow(collateral, borrower, amount);
    }

    function depositAndBorrowChecked(address collateral, uint256 collateralAmount, uint256 amount, bytes calldata proof)
        external whenNotPaused nonReentrant {
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        _submit(collateral, proof);
        _depositCollateral(collateral, msg.sender, collateralAmount);
        _borrow(collateral, msg.sender, amount);
    }

    function borrowChecked(address collateral, uint256 amount, bytes calldata proof) external whenNotPaused nonReentrant {
        _submit(collateral, proof);
        _borrow(collateral, msg.sender, amount);
    }

    function withdrawCollateralChecked(address collateral, uint256 amount, address recipient, bytes calldata proof)
        external nonReentrant {
        if (positions[collateral][msg.sender].debt != 0) _submit(collateral, proof);
        _withdrawCollateral(collateral, amount, recipient);
    }

    function _submit(address collateral, bytes calldata proof) internal {
        Market memory market = _market(collateral);
        DockyardChainlinkGuard(address(market.secondaryOracle)).submitHealth(proof);
    }
}
