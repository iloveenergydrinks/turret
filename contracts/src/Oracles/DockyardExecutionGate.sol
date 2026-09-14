// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";

/// @notice Guardian-attested chain liveness, enforced for every borrowing/liquidation caller.
/// @dev This is a centralized MVP control, not a canonical sequencer uptime oracle.
/// The guardian must attest truthful continuous observations. Its outage expires access
/// within 45 seconds; longer observed outages/restarts require 120 seconds of recovery.
contract DockyardExecutionGate is EIP712 {
    uint256 public constant MAX_LIFETIME = 45 seconds;
    uint256 public constant RECOVERY_DELAY = 120 seconds;
    bytes32 public constant LIVENESS_TYPEHASH = keccak256(
        "Liveness(uint64 observedAt,uint64 healthySince,uint64 validUntil,uint64 epoch)"
    );
    struct Liveness { uint64 observedAt; uint64 healthySince; uint64 validUntil; uint64 epoch; }
    address public immutable guardian;
    uint64 public epoch;
    uint256 public recoveryAt;
    Liveness public liveness;
    error UnauthorizedGuardian();
    error InvalidLiveness();
    error LivenessExpired();
    error RecoveryPending();
    event LivenessAccepted(uint64 observedAt, uint64 healthySince, uint64 validUntil, uint64 epoch);
    event ExecutionStopped(uint64 epoch, uint256 recoveryAt);

    constructor(address guardian_) EIP712("DockyardExecutionGate", "1") {
        if (guardian_ == address(0)) revert UnauthorizedGuardian();
        guardian = guardian_;
        recoveryAt = block.timestamp;
    }
    function submitLiveness(bytes calldata encoded) external {
        (Liveness memory p, bytes memory signature) = abi.decode(encoded, (Liveness, bytes));
        bytes32 hash = keccak256(abi.encode(LIVENESS_TYPEHASH,p.observedAt,p.healthySince,p.validUntil,p.epoch));
        if (ECDSA.recover(_hashTypedDataV4(hash),signature) != guardian) revert InvalidLiveness();
        if (p.epoch != epoch || p.observedAt == 0 || p.observedAt > block.timestamp
            || p.healthySince > p.observedAt || p.validUntil <= p.observedAt
            || p.validUntil - p.observedAt > MAX_LIFETIME || p.observedAt < liveness.observedAt) revert InvalidLiveness();
        if (block.timestamp >= p.validUntil) revert LivenessExpired();
        if (p.healthySince < recoveryAt || p.observedAt - p.healthySince < RECOVERY_DELAY) revert RecoveryPending();
        liveness = p;
        emit LivenessAccepted(p.observedAt,p.healthySince,p.validUntil,p.epoch);
    }
    function requireLive() external view {
        if (liveness.epoch != epoch || block.timestamp >= liveness.validUntil) revert LivenessExpired();
    }
    function trip() external {
        if (msg.sender != guardian) revert UnauthorizedGuardian();
        ++epoch;
        recoveryAt = block.timestamp;
        delete liveness;
        emit ExecutionStopped(epoch,recoveryAt);
    }
}
