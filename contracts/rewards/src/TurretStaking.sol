// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice Stake TURRET to share USDG actually funded by the immutable fee router.
/// @dev One observed-parent-block exit delay on Robinhood Chain; no ongoing lockup, emissions, governance, administrator sweep or USDG transfer on exit.
contract TurretStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e36;
    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    address public immutable distributor;
    uint256 public totalStaked;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 public rewardPerToken;
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public lastStakeBlock;
    mapping(address => uint256) private accrued;
    mapping(address => uint256) private paidPerToken;
    mapping(address => uint256) private fractionalReward;

    error InvalidConfiguration();
    error InvalidAmount();
    error Unauthorized();
    error NoStakers();
    error WaitOneBlock();
    error UnsupportedTransfer();
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event FeesDistributed(uint256 amount, uint256 totalStake);
    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 token, IERC20 usdg, address router) {
        if (address(token).code.length == 0 || address(usdg).code.length == 0 || token == usdg
            || router == address(0) || router == address(this)) revert InvalidConfiguration();
        stakingToken = token;
        rewardToken = usdg;
        distributor = router;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > type(uint128).max - totalStaked) revert InvalidAmount();
        _checkpoint(msg.sender);
        _receiveExact(stakingToken, msg.sender, amount);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        lastStakeBlock[msg.sender] = block.number;
        emit Staked(msg.sender, amount);
    }

    /// @notice Contract-clock eligibility; RPC block heights must not be compared to lastStakeBlock.
    /// @dev On Arbitrum chains, block.number is the observed parent-chain height, not the L2 RPC height.
    function canUnstake(address account) external view returns (bool) {
        return stakedBalance[account] != 0 && block.number > lastStakeBlock[account];
    }

    /// @notice Return TURRET after the contract observes a later block than the latest stake; earned USDG stays claimable separately.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > stakedBalance[msg.sender]) revert InvalidAmount();
        if (block.number <= lastStakeBlock[msg.sender]) revert WaitOneBlock();
        _checkpoint(msg.sender);
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _sendExact(stakingToken, msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Only funded USDG is allocated. An empty stake never earns retroactive rewards.
    function distribute(uint256 amount) external nonReentrant {
        if (msg.sender != distributor) revert Unauthorized();
        if (totalStaked == 0) revert NoStakers();
        // Bounds lifetime index growth even when the total stake is one base unit.
        if (amount == 0 || amount > type(uint128).max - totalFunded) revert InvalidAmount();
        _receiveExact(rewardToken, msg.sender, amount);
        totalFunded += amount;
        rewardPerToken += Math.mulDiv(amount, SCALE, totalStaked);
        emit FeesDistributed(amount, totalStaked);
    }

    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerToken - paidPerToken[account];
        uint256 fraction = mulmod(stakedBalance[account], delta, SCALE) + fractionalReward[account];
        return accrued[account] + Math.mulDiv(stakedBalance[account], delta, SCALE) + fraction / SCALE;
    }

    function claim() external nonReentrant {
        _checkpoint(msg.sender);
        uint256 amount = accrued[msg.sender];
        if (amount == 0) return;
        accrued[msg.sender] = 0;
        totalClaimed += amount;
        _sendExact(rewardToken, msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function _checkpoint(address account) private {
        uint256 delta = rewardPerToken - paidPerToken[account];
        uint256 fraction = mulmod(stakedBalance[account], delta, SCALE) + fractionalReward[account];
        accrued[account] += Math.mulDiv(stakedBalance[account], delta, SCALE) + fraction / SCALE;
        fractionalReward[account] = fraction % SCALE;
        paidPerToken[account] = rewardPerToken;
    }

    function _receiveExact(IERC20 asset, address from, uint256 amount) private {
        uint256 beforeBalance = asset.balanceOf(address(this));
        uint256 beforeSender = asset.balanceOf(from);
        asset.safeTransferFrom(from, address(this), amount);
        if (asset.balanceOf(address(this)) != beforeBalance + amount
            || beforeSender < amount || asset.balanceOf(from) != beforeSender - amount) revert UnsupportedTransfer();
    }

    function _sendExact(IERC20 asset, address to, uint256 amount) private {
        uint256 beforeBacking = asset.balanceOf(address(this));
        uint256 beforeBalance = asset.balanceOf(to);
        asset.safeTransfer(to, amount);
        if (asset.balanceOf(address(this)) != beforeBacking - amount
            || asset.balanceOf(to) != beforeBalance + amount) revert UnsupportedTransfer();
    }
}
