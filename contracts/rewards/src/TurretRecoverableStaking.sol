// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice A funded USDG reserve releases approximately 1% per active day to TURRET stakers.
/// @dev Continuous exponential decay, paused with no stake. Treasury can recover only unreleased subsidy. Earned rewards and protocol fee funding cannot be swept.
contract TurretRecoverableStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant SCALE = 1e36;
    uint256 public constant RAY = 1e27;
    // floor(0.99 ** (1 / 86400) * 1e27); error < 1 ray per second.
    uint256 public constant RETENTION_PER_SECOND = 999999883676675127810317475;
    uint256 public constant DAILY_RELEASE_BPS = 100;
    uint256 public constant STREAM_VERSION = 2;
    IERC20 public immutable stakingToken;
    IERC20 public immutable rewardToken;
    address public immutable distributor;
    address public immutable treasury;
    uint256 public totalSubsidies;
    uint256 public totalRecovered;
    uint256 private anchorSubsidyRay;
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
    event SubsidyRecovered(uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    constructor(IERC20 token, IERC20 usdg, address router, address revenueTreasury) {
        if (address(token).code.length == 0 || address(usdg).code.length == 0 || token == usdg
            || revenueTreasury == address(0) || revenueTreasury == address(this)
            || router == address(0) || router == address(this)) revert InvalidConfiguration();
        stakingToken = token;
        rewardToken = usdg;
        distributor = router;
        treasury = revenueTreasury;
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

    /// @notice Fund a non-recoverable protocol-fee reserve, including while empty.
    function distribute(uint256 amount) external nonReentrant {
        _fund(amount, false);
    }

    /// @notice Fund a subsidy. Only its remaining unreleased portion can be recovered.
    function distributeSubsidy(uint256 amount) external nonReentrant {
        _fund(amount, true);
    }

    function _fund(uint256 amount, bool subsidy) private {
        if (msg.sender != distributor) revert Unauthorized();
        if (amount == 0 || amount > type(uint128).max - totalFunded) revert InvalidAmount();
        uint256 subsidyRemaining = subsidyReserveRay();
        uint256 remaining = _accrue();
        _receiveExact(rewardToken, msg.sender, amount);
        totalFunded += amount;
        if (subsidy) totalSubsidies += amount;
        _anchor(remaining + amount * RAY, subsidyRemaining + (subsidy ? amount * RAY : 0));
        emit RewardsFunded(amount);
    }

    /// @notice Remaining subsidy in whole USDG base units, excluding all accrued rewards and fee funding.
    /// @dev This falls with time while stake exists. Read again before recovering an exact amount.
    function recoverableSubsidy() public view returns (uint256) {
        return subsidyReserveRay() / RAY;
    }

    function subsidyReserveRay() public view returns (uint256) {
        uint256 nowActive = activeSeconds;
        if (totalStaked != 0) nowActive += block.timestamp - lastUpdate;
        uint256 retention = FixedPointMathLib.rpow(RETENTION_PER_SECOND, nowActive - anchorActiveSeconds, RAY);
        return Math.mulDiv(anchorSubsidyRay, retention, RAY);
    }

    /// @notice Router-authorized recovery always pays the immutable treasury.
    /// @dev Accrue first so no previously earned rewards can be withdrawn by treasury.
    function recoverSubsidy(uint256 amount) external nonReentrant {
        if (msg.sender != distributor) revert Unauthorized();
        uint256 subsidyRemaining = subsidyReserveRay();
        if (amount == 0 || amount > subsidyRemaining / RAY) revert InvalidAmount();
        uint256 remaining = _accrue();
        totalRecovered += amount;
        _anchor(remaining - amount * RAY, subsidyRemaining - amount * RAY);
        _sendExact(rewardToken, treasury, amount);
        emit SubsidyRecovered(amount);
    }

    function _anchor(uint256 remaining, uint256 subsidyRemaining) private {
        anchorReserveRay = remaining;
        anchorSubsidyRay = subsidyRemaining;
        anchorActiveSeconds = activeSeconds;
        accountedAnchorReleaseRay = 0;
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

    /// @dev The decay anchor changes only on funding or treasury recovery. Claims and stake changes cannot reset
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
