// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "openzeppelin-contracts/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice Prefunded, capped USDG cashback for an operator-reviewed borrower pilot.
/// @dev Roots attest cumulative paid-interest rebates; they do not prove loan history.
/// Enrollment reserves its entire cap. Published roots and enrollments cannot be revoked.
contract TurretBorrowerCashback is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REBATE_BPS = 5000;
    IERC20 public immutable rewardToken;
    address public immutable operator;
    address public immutable treasury;
    uint64 public immutable startsAt;
    uint64 public immutable endsAt;
    uint64 public immutable settlementDeadline;
    uint64 public immutable claimDeadline;
    uint256 public totalFunded;
    uint256 public totalCommitted;
    uint256 public totalClaimed;
    bool public enrollmentPaused;

    struct Enrollment { uint256 cap; uint64 startsAt; }
    mapping(address => mapping(address => Enrollment)) public enrollments;
    mapping(address => mapping(address => uint256)) public claimed;
    mapping(bytes32 => bool) public publishedRoots;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidEnrollment();
    error InsufficientFunding();
    error InvalidProof();
    error Expired();
    error UnsupportedTransfer();
    error EnrollmentPaused();
    error ClaimsStillOpen();

    event Funded(address indexed sender, uint256 amount);
    event Enrolled(address indexed borrower, address indexed engine, uint256 cap, uint64 startsAt);
    event Published(bytes32 indexed root, uint256 indexed throughBlock, bytes32 blockHash);
    event Claimed(address indexed borrower, address indexed engine, uint256 cumulative, uint256 paid);
    event EnrollmentPauseChanged(bool paused);
    event ExpiredFundsRecovered(uint256 amount);

    constructor(IERC20 token, address publisher, address fundingTreasury, uint64 start, uint64 end,
        uint64 settlementEnd, uint64 claimEnd) {
        if (address(token).code.length == 0 || publisher == address(0) || fundingTreasury == address(0)
            || start < block.timestamp || end <= start || settlementEnd < end || claimEnd <= settlementEnd)
            revert InvalidConfiguration();
        rewardToken = token;
        operator = publisher;
        treasury = fundingTreasury;
        startsAt = start;
        endsAt = end;
        settlementDeadline = settlementEnd;
        claimDeadline = claimEnd;
    }

    modifier onlyOperator() { if (msg.sender != operator) revert Unauthorized(); _; }

    function fund(uint256 amount) public virtual nonReentrant {
        if (block.timestamp >= endsAt) revert Expired();
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = rewardToken.balanceOf(address(this));
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        if (rewardToken.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedTransfer();
        totalFunded += amount;
        emit Funded(msg.sender, amount);
    }

    function enroll(address borrower, address engine, uint256 cap) external virtual onlyOperator {
        if (enrollmentPaused) revert EnrollmentPaused();
        if (block.timestamp >= endsAt) revert Expired();
        if (borrower == address(0) || engine == address(0) || cap == 0 || enrollments[borrower][engine].cap != 0)
            revert InvalidEnrollment();
        if (cap > totalFunded - totalCommitted) revert InsufficientFunding();
        uint64 start = block.timestamp > startsAt ? uint64(block.timestamp) : startsAt;
        enrollments[borrower][engine] = Enrollment(cap, start);
        totalCommitted += cap;
        emit Enrolled(borrower, engine, cap, start);
    }

    function setEnrollmentPaused(bool paused) external onlyOperator {
        enrollmentPaused = paused;
        emit EnrollmentPauseChanged(paused);
    }

    /// @notice Audit metadata identifies the canonical receipt range reviewed by the publisher.
    function publish(bytes32 root, uint256 throughBlock, bytes32 blockHash) external onlyOperator {
        if (block.timestamp > claimDeadline) revert Expired();
        if (root == bytes32(0) || blockHash == bytes32(0)) revert InvalidProof();
        publishedRoots[root] = true;
        emit Published(root, throughBlock, blockHash);
    }

    /// @dev Double hashing prevents ambiguity with internal Merkle nodes. ABI encoding is domain-bound.
    function leaf(address borrower, address engine, uint256 cumulative) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), borrower, engine, cumulative))));
    }

    function claim(bytes32 root, address borrower, address engine, uint256 cumulative, bytes32[] calldata proof)
        external virtual nonReentrant {
        _claim(root, borrower, engine, cumulative, proof);
    }

    function _claim(bytes32 root, address borrower, address engine, uint256 cumulative, bytes32[] calldata proof) internal {
        if (block.timestamp > claimDeadline) revert Expired();
        if (!publishedRoots[root] || !MerkleProof.verifyCalldata(proof, root, leaf(borrower, engine, cumulative)))
            revert InvalidProof();
        if (cumulative <= claimed[borrower][engine] || cumulative > enrollments[borrower][engine].cap)
            revert InvalidAmount();
        uint256 amount = cumulative - claimed[borrower][engine];
        claimed[borrower][engine] = cumulative;
        totalClaimed += amount;
        uint256 beforeBalance = rewardToken.balanceOf(borrower);
        rewardToken.safeTransfer(borrower, amount);
        if (rewardToken.balanceOf(borrower) != beforeBalance + amount) revert UnsupportedTransfer();
        emit Claimed(borrower, engine, cumulative, amount);
    }

    function remainingCommitment() external view returns (uint256) { return totalCommitted - totalClaimed; }

    function recoverExpired() external nonReentrant {
        if (msg.sender != treasury) revert Unauthorized();
        if (block.timestamp <= claimDeadline) revert ClaimsStillOpen();
        uint256 amount = rewardToken.balanceOf(address(this));
        rewardToken.safeTransfer(treasury, amount);
        emit ExpiredFundsRecovered(amount);
    }
}
