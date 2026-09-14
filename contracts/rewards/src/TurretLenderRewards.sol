// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice Funded TURRET rewards for staking one existing lending pool's shares.
/// @dev Candidate implementation. No deployment or independent audit is implied.
contract TurretLenderRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e36;
    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    address public immutable administrator;
    uint256 public immutable lifetimeBudget;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public totalStaked;
    uint256 public reserved;
    uint256 public rewardPerShare;
    uint256 public startsAt;
    uint256 public endsAt;
    uint256 public campaignBudget;
    uint256 public campaignEmitted;
    uint256 public campaignAllocated;
    bool public finalized = true;
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public accrued;
    mapping(address => uint256) public paidPerShare;
    error InvalidConfiguration();
    error Unauthorized();
    error InvalidCampaign();
    error InvalidAmount();
    error UnsupportedTransfer();
    event CampaignFunded(uint256 budget, uint256 startsAt, uint256 endsAt);
    event CampaignStopped(uint256 at);
    event Staked(address indexed account, uint256 shares);
    event Unstaked(address indexed account, uint256 shares);
    event RewardClaimed(address indexed account, uint256 amount);
    event UnallocatedRecovered(uint256 amount);

    constructor(IERC20 shares, IERC20 rewards, address admin, uint256 budgetCap) {
        if (address(shares).code.length == 0 || address(rewards).code.length == 0
            || shares == rewards || admin == address(0) || budgetCap == 0 || budgetCap > type(uint128).max)
            revert InvalidConfiguration();
        stakingToken = shares; rewardToken = rewards; administrator = admin; lifetimeBudget = budgetCap;
    }
    modifier onlyAdministrator() { if (msg.sender != administrator) revert Unauthorized(); _; }

    /// @notice Fund a fixed round. Earned liabilities survive later rounds.
    function fundCampaign(uint256 budget, uint256 start, uint256 end) external nonReentrant onlyAdministrator {
        if (!finalized && block.timestamp < endsAt) revert InvalidCampaign();
        _checkpoint();
        _finalize();
        if (budget == 0 || totalFunded + budget > lifetimeBudget || start < block.timestamp
            || end <= start || end - start > 14 days || start > block.timestamp + 30 days) revert InvalidCampaign();
        uint256 beforeBalance = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), budget);
        if (rewardToken.balanceOf(address(this)) != beforeBalance + budget) revert UnsupportedTransfer();
        totalFunded += budget; reserved += budget;
        startsAt = start; endsAt = end; campaignBudget = budget;
        campaignEmitted = 0; campaignAllocated = 0; finalized = false;
        emit CampaignFunded(budget, start, end);
    }
    function stake(uint256 shares) external nonReentrant {
        if (shares == 0 || totalStaked + shares > type(uint128).max) revert InvalidAmount();
        _update(msg.sender);
        uint256 beforeBalance = stakingToken.balanceOf(address(this));
        stakingToken.safeTransferFrom(msg.sender, address(this), shares);
        if (stakingToken.balanceOf(address(this)) != beforeBalance + shares) revert UnsupportedTransfer();
        stakedBalance[msg.sender] += shares; totalStaked += shares;
        emit Staked(msg.sender, shares);
    }
    /// @notice Returns shares without touching the reward token or requiring a live campaign.
    function unstake(uint256 shares) external nonReentrant {
        if (shares == 0 || shares > stakedBalance[msg.sender]) revert InvalidAmount();
        _update(msg.sender); stakedBalance[msg.sender] -= shares; totalStaked -= shares;
        uint256 beforeBalance = stakingToken.balanceOf(msg.sender);
        uint256 beforeBacking = stakingToken.balanceOf(address(this));
        stakingToken.safeTransfer(msg.sender, shares);
        if (stakingToken.balanceOf(msg.sender) != beforeBalance + shares || stakingToken.balanceOf(address(this)) != beforeBacking - shares || stakingToken.balanceOf(address(this)) < totalStaked) revert UnsupportedTransfer();
        emit Unstaked(msg.sender, shares);
    }
    function claim() external nonReentrant {
        _update(msg.sender); uint256 amount = accrued[msg.sender];
        if (amount == 0) return;
        accrued[msg.sender] = 0; reserved -= amount; totalClaimed += amount;
        uint256 beforeBalance = rewardToken.balanceOf(msg.sender);
        uint256 beforeReserve = rewardToken.balanceOf(address(this));
        rewardToken.safeTransfer(msg.sender, amount);
        if (rewardToken.balanceOf(msg.sender) != beforeBalance + amount || rewardToken.balanceOf(address(this)) != beforeReserve - amount || rewardToken.balanceOf(address(this)) < reserved) revert UnsupportedTransfer();
        emit RewardClaimed(msg.sender, amount);
    }
    /// @notice Stops future emissions; already earned rewards cannot be revoked.
    function stopCampaign() external nonReentrant onlyAdministrator {
        _checkpoint();
        if (finalized) revert InvalidCampaign();
        // Finalize now without recalculating the old emission curve against a shorter end date.
        _finalize(); endsAt = block.timestamp;
        emit CampaignStopped(block.timestamp);
    }
    function recoverUnallocated() external nonReentrant onlyAdministrator {
        _checkpoint(); if (block.timestamp >= endsAt) _finalize();
        uint256 amount = rewardToken.balanceOf(address(this)) - reserved;
        if (amount != 0) {
            rewardToken.safeTransfer(administrator, amount);
            if (rewardToken.balanceOf(address(this)) != reserved) revert UnsupportedTransfer();
        }
        emit UnallocatedRecovered(amount);
    }
    function earned(address account) external view returns (uint256) {
        uint256 rpt = rewardPerShare;
        if (totalStaked != 0) rpt += Math.mulDiv(_scheduled() - campaignEmitted, SCALE, totalStaked);
        return accrued[account] + Math.mulDiv(stakedBalance[account], rpt - paidPerShare[account], SCALE);
    }
    function _scheduled() private view returns (uint256) {
        if (finalized) return campaignEmitted;
        if (block.timestamp <= startsAt) return 0;
        return Math.mulDiv(campaignBudget, Math.min(block.timestamp, endsAt) - startsAt, endsAt - startsAt);
    }
    function _checkpoint() private {
        uint256 scheduled = _scheduled(); uint256 emission = scheduled - campaignEmitted;
        campaignEmitted = scheduled;
        if (totalStaked != 0) {
            rewardPerShare += Math.mulDiv(emission, SCALE, totalStaked);
            // Conservative reserve includes rounding dust; it cannot be recovered as unearned inventory.
            campaignAllocated += emission;
        }
    }
    function _update(address account) private {
        _checkpoint();
        accrued[account] += Math.mulDiv(stakedBalance[account], rewardPerShare - paidPerShare[account], SCALE);
        paidPerShare[account] = rewardPerShare;
    }
    function _finalize() private {
        if (!finalized) { reserved -= campaignBudget - campaignAllocated; finalized = true; }
    }
}
