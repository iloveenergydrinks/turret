// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {IDockyardOracle} from "../DockyardUSDGCreditVault.sol";

interface IGuardedStock {
    function oraclePaused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
}

/// @notice Single-source Chainlink pricing with a trusted monitor's short-lived borrowing approval.
/// @dev The monitor cannot supply a price or move funds. It can censor borrowing
/// and quarantine liquidations. This is NOT an independent decentralized oracle.
contract DockyardChainlinkGuard is EIP712 {
    uint8 public constant decimals = 18;
    uint16 public constant maxDeviationBps = 200;
    uint256 public constant MAX_PRICE_AGE = 5 minutes;
    uint256 public constant MAX_HEALTH_AGE = 60 seconds;
    uint256 public constant RECOVERY_DELAY = 2 minutes;
    bytes32 public constant HEALTH_TYPEHASH = keccak256(
        "Health(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)"
    );
    struct Health {
        uint80 roundId;
        uint64 observedAt;
        uint64 validUntil;
        uint64 sessionOpen;
        uint64 sessionClose;
        bytes32 roundHash;
        uint64 epoch;
    }
    address public immutable collateral;
    IDockyardOracle public immutable primaryOracle;
    address public immutable guardian;
    uint8 public immutable primaryDecimals;
    uint64 public epoch;
    uint256 public recoveryAt;
    bool public liquidationQuarantined;
    Health public health;

    error InvalidConfiguration();
    error InvalidPrice();
    error StalePrice();
    error CorporateActionPending();
    error HealthExpired();
    error InvalidHealth();
    error MarketClosed();
    error RecoveryPending();
    error PriceQuarantined();
    error UnauthorizedGuardian();
    event HealthAccepted(uint80 roundId, uint64 observedAt, uint64 validUntil, uint64 epoch);
    event CircuitTripped(uint64 epoch, bool liquidationQuarantined, uint256 recoveryAt);

    constructor(address collateral_, address primary_, address guardian_) EIP712("DockyardChainlinkGuard", "1") {
        if (collateral_.code.length == 0 || primary_.code.length == 0 || guardian_ == address(0)) {
            revert InvalidConfiguration();
        }
        collateral = collateral_;
        primaryOracle = IDockyardOracle(primary_);
        guardian = guardian_;
        uint8 d = IDockyardOracle(primary_).decimals();
        if (d > 18) revert InvalidConfiguration();
        primaryDecimals = d;
        recoveryAt = block.timestamp + RECOVERY_DELAY;
    }

    /// @notice An incident invalidates all outstanding approvals. A price disagreement
    /// also blocks liquidations until the monitor attests recovery after the delay.
    function trip(bool unsafePrice) external {
        if (msg.sender != guardian) revert UnauthorizedGuardian();
        ++epoch;
        recoveryAt = block.timestamp + RECOVERY_DELAY;
        if (unsafePrice) liquidationQuarantined = true;
        delete health;
        emit CircuitTripped(epoch, liquidationQuarantined, recoveryAt);
    }

    /// @notice Permissionless submission; callers pay gas only when an approval is used.
    /// The signed approval is bound to this adapter, chain, exact Chainlink round and epoch.
    function submitHealth(bytes calldata encoded) external {
        (Health memory h, bytes memory signature) = abi.decode(encoded, (Health, bytes));
        bytes32 hash = keccak256(abi.encode(HEALTH_TYPEHASH, h.roundId, h.observedAt, h.validUntil, h.sessionOpen, h.sessionClose, h.roundHash, h.epoch));
        if (ECDSA.recover(_hashTypedDataV4(hash), signature) != guardian) revert InvalidHealth();
        (uint256 value, uint256 timestamp, uint80 roundId) = currentData();
        _checkHealth(h, roundId, value, timestamp);
        if (h.observedAt < health.observedAt) revert InvalidHealth();
        health = h;
        liquidationQuarantined = false;
        emit HealthAccepted(h.roundId, h.observedAt, h.validUntil, h.epoch);
    }

    function _checkHealth(Health memory h, uint80 roundId, uint256 value, uint256 timestamp) internal view {
        if (h.epoch != epoch || h.roundId != roundId || h.roundHash != keccak256(abi.encode(roundId, value, timestamp))
            || h.observedAt == 0 || h.observedAt > block.timestamp
            || h.validUntil <= h.observedAt || h.validUntil - h.observedAt > MAX_HEALTH_AGE) revert InvalidHealth();
        if (block.timestamp >= h.validUntil) revert HealthExpired();
        if (h.observedAt < recoveryAt) revert RecoveryPending();
        if (h.sessionClose <= h.sessionOpen || h.sessionClose - h.sessionOpen > 6 hours + 30 minutes
            || h.observedAt < h.sessionOpen || block.timestamp < h.sessionOpen || block.timestamp >= h.sessionClose
            || h.validUntil > h.sessionClose) revert MarketClosed();
    }

    function currentData() public view returns (uint256 value, uint256 updatedAt, uint80 roundId) {
        if (IGuardedStock(collateral).oraclePaused()) revert InvalidPrice();
        (uint80 round, int256 answer,, uint256 timestamp, uint80 answered) = primaryOracle.latestRoundData();
        if (round == 0 || answer <= 0 || answered < round || uint256(answer) > type(uint128).max) revert InvalidPrice();
        if (timestamp == 0 || timestamp > block.timestamp || block.timestamp - timestamp >= MAX_PRICE_AGE) revert StalePrice();
        uint256 effective = IGuardedStock(collateral).effectiveAt();
        if (effective <= block.timestamp && timestamp < effective) revert CorporateActionPending();
        // Canonical Robinhood Chainlink prices already incorporate the token multiplier.
        return (uint256(answer) * 10 ** (18 - primaryDecimals), timestamp, round);
    }

    function validatedPrice(bool borrowing) public view returns (uint256 value, uint256 updatedAt) {
        uint80 round;
        (value, updatedAt, round) = currentData();
        if (liquidationQuarantined) revert PriceQuarantined();
        if (borrowing) _checkHealth(health, round, value, updatedAt);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint256 value, uint256 timestamp) = validatedPrice(false);
        return (uint80(timestamp), int256(value), timestamp, timestamp, uint80(timestamp));
    }
}
