// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardIsolatedCapitalPool} from "./DockyardIsolatedCapitalPool.sol";
import {DockyardStockCreditEngine} from "./DockyardStockCreditEngine.sol";

/// @notice Candidate stock Earn pool. Refreshes public health proofs and performs
/// quote-bounded lender operations atomically. No lender assets pass through a router.
/// @dev Inherited ERC-4626 operations retain the same engine safety checks. These
/// wrappers do not grant a way around closed sessions, liveness or cash limits.
contract DockyardStockCapitalPool is DockyardIsolatedCapitalPool {
    bytes32 private immutable engineHash;

    constructor(
        IERC20Metadata usdg,
        address collateral,
        address engine,
        address treasury,
        uint256 limit,
        uint16 feeBps,
        uint16 aprBps
    ) DockyardIsolatedCapitalPool(usdg, collateral, engine, treasury, limit, feeBps, aprBps) {
        DockyardStockCreditEngine e = DockyardStockCreditEngine(engine);
        if (
            address(e.collateralToken()) != collateral || address(e.usdg()) != address(usdg)
                || address(e.stockGuard()).code.length == 0 || address(e.executionGate()).code.length == 0
        ) {
            revert InvalidConfiguration();
        }
        engineHash = engine.codehash;
    }

    function depositChecked(
        uint256 assets,
        address receiver,
        uint256 minShares,
        uint256 deadline,
        bytes calldata health,
        bytes calldata liveness
    ) external returns (uint256) {
        _refresh(health, liveness);
        return depositWithMinShares(assets, receiver, minShares, deadline);
    }

    function withdrawChecked(
        uint256 assets,
        address receiver,
        address owner,
        uint256 maxShares,
        uint256 deadline,
        bytes calldata health,
        bytes calldata liveness
    ) external returns (uint256) {
        _refresh(health, liveness);
        return withdrawWithMaxShares(assets, receiver, owner, maxShares, deadline);
    }

    function redeemChecked(
        uint256 shares,
        address receiver,
        address owner,
        uint256 minAssets,
        uint256 deadline,
        bytes calldata health,
        bytes calldata liveness
    ) external returns (uint256) {
        _refresh(health, liveness);
        return redeemWithMinAssets(shares, receiver, owner, minAssets, deadline);
    }

    function _refresh(bytes calldata health, bytes calldata liveness) private {
        if (creditEngine.codehash != engineHash) revert InvalidConfiguration();
        // No pricing dependency for idle USDG. Debt-free exits must survive a
        // guardian outage and callers need not pay to submit irrelevant proofs.
        if (outstandingPrincipal != 0) DockyardStockCreditEngine(creditEngine).submitChecks(health, liveness);
    }
}
