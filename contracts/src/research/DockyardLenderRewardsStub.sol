// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDockyardLenderRewards} from "./IDockyardLenderRewards.sol";

/// @notice Non-deployable scaffold, not a staking contract or funded campaign.
/// @dev Views intentionally remain abstract. No transfers or reward accounting exist yet.
abstract contract DockyardLenderRewardsStub is IDockyardLenderRewards {
    error RewardsNotImplemented();

    function stake(uint256) external pure override {
        revert RewardsNotImplemented();
    }

    function unstake(uint256) external pure override {
        revert RewardsNotImplemented();
    }

    function claim(address) external pure override {
        revert RewardsNotImplemented();
    }

    // TODO: actual-receipt funding, independent USDG/DOCK accumulators and claims.
    // TODO: checkpoint before stake changes; skip emissions when total stake is zero.
    // TODO: safe transfers, reentrancy protection, rounding and unpaid-liability reserves.
    // TODO: immutable pool/token identities, bounded campaigns, treasury administration.
    // TODO: share-backing and per-token solvency invariants; real-pool integration review.
}
