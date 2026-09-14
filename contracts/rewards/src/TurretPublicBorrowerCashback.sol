// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TurretBorrowerCashback, IERC20} from "./TurretBorrowerCashback.sol";

/// @notice Public opt-in: one 25 USDG reservation per wallet across all campaign markets.
/// @dev Wallet limits are not proof of unique people. Roots still attest operator-reviewed interest.
contract TurretPublicBorrowerCashback is TurretBorrowerCashback {
    uint256 public constant WALLET_CAP = 25e6;
    uint256 public constant BUDGET_CAP = 1000e6;
    address[] public engines;
    mapping(address => bool) public eligibleEngine;
    mapping(address => bool) public joined;
    mapping(address => uint256) public walletClaimed;

    constructor(IERC20 token, address publisher, address fundingTreasury, uint64 start, uint64 end,
        uint64 settlementEnd, uint64 claimEnd, address[] memory markets)
        TurretBorrowerCashback(token, publisher, fundingTreasury, start, end, settlementEnd, claimEnd) {
        if (markets.length == 0 || markets.length > 64) revert InvalidConfiguration();
        for (uint256 i; i < markets.length; ++i) {
            address engine = markets[i];
            if (engine.code.length == 0 || eligibleEngine[engine]) revert InvalidConfiguration();
            eligibleEngine[engine] = true;
            engines.push(engine);
        }
    }

    function engineCount() external view returns (uint256) { return engines.length; }

    function fund(uint256 amount) public override {
        if (amount > BUDGET_CAP - totalFunded) revert InvalidAmount();
        super.fund(amount);
    }

    /// @notice No operator can allocate extra or preferential slots through the old pilot entry point.
    function enroll(address, address, uint256) external pure override { revert Unauthorized(); }

    /// @notice Reserves 25 USDG once, covering future eligible draws in every listed market.
    function join() external {
        if (enrollmentPaused) revert EnrollmentPaused();
        if (block.timestamp < startsAt || block.timestamp >= endsAt) revert Expired();
        if (joined[msg.sender] || msg.sender == operator || msg.sender == treasury) revert InvalidEnrollment();
        if (WALLET_CAP > totalFunded - totalCommitted) revert InsufficientFunding();
        joined[msg.sender] = true;
        totalCommitted += WALLET_CAP;
        for (uint256 i; i < engines.length; ++i) {
            enrollments[msg.sender][engines[i]] = Enrollment(WALLET_CAP, uint64(block.timestamp));
            emit Enrolled(msg.sender, engines[i], WALLET_CAP, uint64(block.timestamp));
        }
    }

    function claim(bytes32 root, address borrower, address engine, uint256 cumulative, bytes32[] calldata proof)
        external override nonReentrant {
        uint256 previous = claimed[borrower][engine];
        if (cumulative <= previous || cumulative - previous > WALLET_CAP - walletClaimed[borrower]) revert InvalidAmount();
        walletClaimed[borrower] += cumulative - previous;
        _claim(root, borrower, engine, cumulative, proof);
    }
}
