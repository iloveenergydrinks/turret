// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Owner-operated, hash-pinned CREATE batches for reviewed Dockyard deployments.
/// @dev This contract has no authority over contracts it deploys. Each batch is
/// atomic and limited to four creations so a guard, execution gate, market
/// bundle and direct liquidation executor can be deployed with one signature.
contract DockyardSequentialCreateFactory {
    address public immutable operator;
    uint256 public totalCreated;

    error Unauthorized();
    error InvalidBatch();
    error CreationFailed(uint256 index);
    error RuntimeMismatch(uint256 index, address deployed);

    event BatchDeployed(uint256 indexed start, bytes32 indexed batchHash, address[] deployed);

    constructor(address operator_) {
        if (operator_ == address(0)) revert InvalidBatch();
        operator = operator_;
    }

    function deployBatch(
        bytes[] calldata creationCode,
        bytes32[] calldata initcodeHashes,
        bytes32[] calldata runtimeHashes,
        uint256 expectedStart
    ) external returns (address[] memory deployed) {
        if (msg.sender != operator) revert Unauthorized();
        uint256 length = creationCode.length;
        if (
            length == 0 || length > 4 || initcodeHashes.length != length || runtimeHashes.length != length
                || totalCreated != expectedStart
        ) revert InvalidBatch();

        deployed = new address[](length);
        for (uint256 i; i < length; ++i) {
            bytes calldata code = creationCode[i];
            if (
                initcodeHashes[i] == bytes32(0) || runtimeHashes[i] == bytes32(0)
                    || keccak256(code) != initcodeHashes[i]
            ) {
                revert InvalidBatch();
            }
            address created;
            assembly ("memory-safe") {
                let pointer := mload(0x40)
                calldatacopy(pointer, code.offset, code.length)
                created := create(0, pointer, code.length)
            }
            if (created == address(0)) revert CreationFailed(i);
            if (created.codehash != runtimeHashes[i]) revert RuntimeMismatch(i, created);
            deployed[i] = created;
        }
        totalCreated = expectedStart + length;
        emit BatchDeployed(expectedStart, keccak256(abi.encode(initcodeHashes, runtimeHashes)), deployed);
    }
}
