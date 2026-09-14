// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice A funded USDG reserve releases approximately 1% per active day to TURRET stakers.
/// @dev Continuous exponential decay, paused with no stake. No minting, admin sweep, mutable rate or USDG transfer on exit.
contract TurretStreamingStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e36;
    uint256 public constant RAY = 1e27;
    // floor(0.99 ** (1 / 86400) * 1e27); error < 1 ray per second.
    uint256 public constant RETENTION_PER_SECOND = 999999883676675127810317475;
    uint256 public constant DAILY_RELEASE_BPS = 100;
    uint256 public constant STREAM_VERSION = 1;
    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    address public immutable distributor;
    uint256 public totalStaked;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    uint256 private storedRewardPerToken;
    uint256 private indexRemainder;
    uint256 public lastUpdate;
    uint256 public activeSeconds;
    uint256 private anchorReserveRay;
    uint256 private anchorActiveSeconds;
    uint256 private accountedAnchorReleaseRay;
    uint256 private releasedRay;
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public lastStakeBlock;
    mapping(address => uint256) private accrued;
    mapping(address => uint256) private paidPerToken;
    mapping(address => uint256) private fractionalReward;

    error InvalidConfiguration();
    error InvalidAmount();
    error Unauthorized();
    error WaitOneBlock();
    error UnsupportedTransfer();
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event RewardsFunded(uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 token, IERC20 usdg, address router) {
        if (address(token).code.length == 0 || address(usdg).code.length == 0 || token == usdg
            || router == address(0) || router == address(this)) revert InvalidConfiguration();
        stakingToken = token;
        rewardToken = usdg;
        distributor = router;
        lastUpdate = block.timestamp;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > type(uint128).max - totalStaked) revert InvalidAmount();
        _checkpoint(msg.sender);
        _receiveExact(stakingToken, msg.sender, amount);
        // A stake change must not give a new stake old unallocated index dust.
        indexRemainder = 0;
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
        indexRemainder = 0;
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _sendExact(stakingToken, msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Fund the reserve, including while empty. Funding itself creates no earned rewards.
    function distribute(uint256 amount) external nonReentrant {
        if (msg.sender != distributor) revert Unauthorized();
        if (amount == 0 || amount > type(uint128).max - totalFunded) revert InvalidAmount();
        uint256 remaining = _accrue();
        _receiveExact(rewardToken, msg.sender, amount);
        totalFunded += amount;
        anchorReserveRay = remaining + amount * RAY;
        anchorActiveSeconds = activeSeconds;
        accountedAnchorReleaseRay = 0;
        emit RewardsFunded(amount);
    }

    /// @notice Unreleased funded USDG in ray-scaled base units. No donated token balances are counted.
    function reserveRay() external view returns (uint256) {
        (uint256 remaining,,) = _streamNow();
        return remaining;
    }

    function totalReleased() external view returns (uint256) {
        (,,uint256 emission) = _streamNow();
        return (releasedRay + emission) / RAY;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return storedRewardPerToken;
        (,,uint256 emission) = _streamNow();
        return storedRewardPerToken + (emission * (SCALE / RAY) + indexRemainder) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerToken() - paidPerToken[account];
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
        _accrue();
        uint256 delta = storedRewardPerToken - paidPerToken[account];
        uint256 fraction = mulmod(stakedBalance[account], delta, SCALE) + fractionalReward[account];
        accrued[account] += Math.mulDiv(stakedBalance[account], delta, SCALE) + fraction / SCALE;
        fractionalReward[account] = fraction % SCALE;
        paidPerToken[account] = storedRewardPerToken;
    }

    /// @dev The decay anchor changes only on funding. Claims and stake changes cannot reset
    /// the decay clock. Empty intervals add no active seconds and cannot be captured on re-entry.
    function _streamNow() private view returns (uint256 remaining, uint256 activeNow, uint256 emission) {
        activeNow = activeSeconds;
        if (totalStaked != 0) activeNow += block.timestamp - lastUpdate;
        uint256 retention = FixedPointMathLib.rpow(RETENTION_PER_SECOND, activeNow - anchorActiveSeconds, RAY);
        remaining = Math.mulDiv(anchorReserveRay, retention, RAY);
        emission = anchorReserveRay - remaining - accountedAnchorReleaseRay;
    }

    function _accrue() private returns (uint256 remaining) {
        uint256 activeNow;
        uint256 emission;
        (remaining, activeNow, emission) = _streamNow();
        activeSeconds = activeNow;
        lastUpdate = block.timestamp;
        if (emission == 0) return remaining;
        // totalFunded <= uint128.max bounds lifetime numerator to uint128.max * 1e36.
        // Carry index dust across claims; discard it only when stake ownership changes.
        uint256 numerator = emission * (SCALE / RAY) + indexRemainder;
        storedRewardPerToken += numerator / totalStaked;
        indexRemainder = numerator % totalStaked;
        accountedAnchorReleaseRay += emission;
        releasedRay += emission;
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
