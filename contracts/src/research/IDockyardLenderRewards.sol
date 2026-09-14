// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Draft interface for one pool's share staking and independently claimed rewards.
/// @dev Proposal only. Each reward token must have its own funded accounting.
interface IDockyardLenderRewards {
    struct Campaign {
        uint64 startsAt;
        uint64 endsAt;
        uint256 funded;
        uint256 allocated;
        uint256 claimed;
    }

    event Staked(address indexed account, uint256 shares);
    event Unstaked(address indexed account, uint256 shares);
    event RewardClaimed(address indexed account, address indexed rewardToken, uint256 amount);

    function stakingToken() external view returns (address);
    function totalStaked() external view returns (uint256);
    function stakedBalance(address account) external view returns (uint256);
    function campaign(address rewardToken) external view returns (Campaign memory);
    function earned(address account, address rewardToken) external view returns (uint256);

    function stake(uint256 shares) external;
    /// @dev Return shares without attempting any reward transfer.
    function unstake(uint256 shares) external;
    /// @dev Claim only this token; one failing reward token must not block the other.
    function claim(address rewardToken) external;
}
