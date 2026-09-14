// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {TurretStaking} from "./TurretStaking.sol";

interface ITurretRevenuePool {
    function asset() external view returns (address);
    function feeRecipient() external view returns (address);
    function protocolFees() external view returns (uint256);
    function claimRevenue() external;
}

/// @notice Collect allowed pools' fees and forward half of the treasury's actual receipt to staking.
/// @dev Requires treasury USDG allowance. No arbitrary treasury pull or mutable recipients.
/// Existing pools can still be claimed directly, bypassing this router; forwarding is not enforced by them.
contract TurretFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant STAKER_SHARE_BPS = 5000;
    IERC20 public immutable rewardToken;
    address public immutable treasury;
    TurretStaking public immutable staking;
    mapping(address => bytes32) public poolCodeHash;
    address[] public pools;
    uint256 public totalCollected;
    uint256 public totalDistributed;
    uint256 public totalTreasuryReported;
    uint256 private halfRemainder;

    error InvalidConfiguration();
    error UnsupportedPool();
    error NoFees();
    error NoStakers();
    error Unauthorized();
    error InsufficientTreasuryBalance();
    error UnsupportedTransfer();
    event RevenueDistributed(address indexed pool, uint256 collected, uint256 stakerShare, uint256 treasuryRetained);
    event ClaimedFeesForwarded(uint256 treasuryReportedFees, uint256 stakerShare);

    constructor(IERC20 token, IERC20 usdg, address revenueTreasury, address[] memory allowedPools) {
        if (address(token).code.length == 0 || address(usdg).code.length == 0 || token == usdg
            || revenueTreasury == address(0) || revenueTreasury == address(this)
            || allowedPools.length == 0 || allowedPools.length > 64) revert InvalidConfiguration();
        rewardToken = usdg;
        treasury = revenueTreasury;
        for (uint256 i; i < allowedPools.length; ++i) {
            address pool = allowedPools[i];
            if (pool.code.length == 0 || poolCodeHash[pool] != bytes32(0)
                || ITurretRevenuePool(pool).asset() != address(usdg)
                || ITurretRevenuePool(pool).feeRecipient() != revenueTreasury) revert InvalidConfiguration();
            poolCodeHash[pool] = pool.codehash;
            pools.push(pool);
        }
        staking = new TurretStaking(token, usdg, address(this));
        usdg.safeApprove(address(staking), type(uint256).max);
    }

    function poolCount() external view returns (uint256) { return pools.length; }

    /// @notice A failed allowance/funding step reverts the pool claim as well. Anyone can trigger.
    function collect(address pool) external nonReentrant {
        if (poolCodeHash[pool] == bytes32(0) || pool.codehash != poolCodeHash[pool]) revert UnsupportedPool();
        if (staking.totalStaked() == 0) revert NoStakers();
        uint256 fee = ITurretRevenuePool(pool).protocolFees();
        if (fee == 0) revert NoFees();
        uint256 beforeTreasury = rewardToken.balanceOf(treasury);
        ITurretRevenuePool(pool).claimRevenue();
        if (rewardToken.balanceOf(treasury) != beforeTreasury + fee) revert UnsupportedTransfer();

        totalCollected += fee;
        uint256 share = _forward(fee);
        emit RevenueDistributed(pool, fee, share, fee - share);
    }

    /// @notice Treasury-authorized remittance for fees claimed outside this router.
    /// @dev The gross amount is treasury-reported, not proven historical revenue. Separate counters/events
    /// prevent this path from being confused with pool receipts measured by collect().
    function forwardClaimedFees(uint256 grossFees) external nonReentrant {
        if (msg.sender != treasury) revert Unauthorized();
        if (staking.totalStaked() == 0) revert NoStakers();
        if (grossFees == 0) revert NoFees();
        if (grossFees > rewardToken.balanceOf(treasury)) revert InsufficientTreasuryBalance();
        totalTreasuryReported += grossFees;
        uint256 share = _forward(grossFees);
        emit ClaimedFeesForwarded(grossFees, share);
    }

    function _forward(uint256 fee) private returns (uint256 share) {
        // Carry half a USDG base unit across collections; splitting tiny fees cannot evade the share.
        share = fee / 2 + (fee % 2 + halfRemainder) / 2;
        halfRemainder = (fee % 2 + halfRemainder) % 2;
        totalDistributed += share;
        if (share != 0) {
            uint256 beforeTreasury = rewardToken.balanceOf(treasury);
            uint256 beforeRouter = rewardToken.balanceOf(address(this));
            rewardToken.safeTransferFrom(treasury, address(this), share);
            if (rewardToken.balanceOf(address(this)) != beforeRouter + share
                || rewardToken.balanceOf(treasury) != beforeTreasury - share) revert UnsupportedTransfer();
            staking.distribute(share);
            if (rewardToken.balanceOf(address(this)) != beforeRouter) revert UnsupportedTransfer();
        }
    }
}
