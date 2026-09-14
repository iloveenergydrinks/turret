// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

interface IPythProVerifier {
    function verification_fee() external view returns (uint256);
    function verifyUpdate(bytes calldata update) external payable returns (bytes memory payload, address signer);
}

/// @notice Permissionless cache of reports authenticated by Pyth's deployed verifier.
/// @dev Payload format: pyth-network/pyth-crosschain at
/// 4dd956ede61a7ad6b19317e6001a3b95c308dcf2, lazer/contracts/evm/src.
/// Only the six requested equity properties are accepted; no unsigned JSON enters storage.
contract DockyardPythVerifier is ReentrancyGuard {
    IPythProVerifier public immutable verifier;
    uint256 public constant MAX_REPORT_AGE = 30;

    struct Report {
        uint64 timestampUs;
        uint64 feedUpdateTimestampUs;
        int64 price;
        uint64 confidence;
        uint16 publishers;
        int16 exponent;
        uint16 session; // 0 regular, 1 pre, 2 post, 3 overnight, 4 closed
    }
    mapping(uint32 => Report) public reports;
    error InvalidVerifier();
    error InvalidFee();
    error InvalidPayload();
    error StaleReport();
    event ReportUpdated(uint32 indexed feedId, uint64 timestampUs, uint64 feedUpdateTimestampUs, uint16 session);

    constructor(address verifier_) {
        if (verifier_.code.length == 0) revert InvalidVerifier();
        verifier = IPythProVerifier(verifier_);
    }

    function report(uint32 id) external view returns (Report memory) {
        return reports[id];
    }

    function update(bytes calldata signedUpdate) external payable nonReentrant {
        uint256 fee = verifier.verification_fee();
        if (msg.value != fee) revert InvalidFee();
        (bytes memory payload,) = verifier.verifyUpdate{value: fee}(signedUpdate);
        if (_uint(payload, 0, 4) != 2479346549) revert InvalidPayload();
        uint64 timestampUs = uint64(_uint(payload, 4, 8));
        // Do not round microseconds before checking future timestamps.
        if (
            timestampUs > block.timestamp * 1e6 || timestampUs == 0
                || block.timestamp * 1e6 - timestampUs >= MAX_REPORT_AGE * 1e6
        ) revert StaleReport();
        uint256 channel = _uint(payload, 12, 1);
        if (channel < 1 || channel > 4) revert InvalidPayload();
        uint256 count = _uint(payload, 13, 1);
        if (count == 0 || count > 32) revert InvalidPayload();
        uint256 cursor = 14;
        uint32[] memory ids = new uint32[](count);
        for (uint256 i; i < count; ++i) {
            uint32 id = uint32(_uint(payload, cursor, 4));
            uint256 properties = _uint(payload, cursor + 4, 1);
            cursor += 5;
            if (id == 0 || properties != 6) revert InvalidPayload();
            for (uint256 j; j < i; ++j) {
                if (ids[j] == id) revert InvalidPayload();
            }
            ids[i] = id;
            Report memory r;
            r.timestampUs = timestampUs;
            uint256 seen;
            for (uint256 j; j < properties; ++j) {
                uint256 tag = _uint(payload, cursor++, 1);
                if (tag > 12 || (seen & (1 << tag)) != 0) revert InvalidPayload();
                seen |= 1 << tag;
                uint256 size;
                // FeedUpdateTimestamp is an optional u64 with a one-byte presence tag.
                if (tag == 12) {
                    uint256 present = _uint(payload, cursor++, 1);
                    if (present > 1) revert InvalidPayload();
                    if (present == 0) continue;
                }
                if (tag == 0 || tag == 5 || tag == 12) size = 8;
                else if (tag == 3 || tag == 4 || tag == 9) size = 2;
                else revert InvalidPayload();
                uint256 value = _uint(payload, cursor, size);
                cursor += size;
                if (tag == 0) r.price = int64(uint64(value));
                else if (tag == 3) r.publishers = uint16(value);
                else if (tag == 4) r.exponent = int16(uint16(value));
                else if (tag == 5) r.confidence = uint64(value);
                else if (tag == 9) r.session = uint16(value);
                else r.feedUpdateTimestampUs = uint64(value);
            }
            if (seen != 4665 || r.session > 4 || r.feedUpdateTimestampUs > timestampUs) revert InvalidPayload();
            // A new signed closed/missing/uncertain report must replace the old good report.
            // A duplicate or older report cannot roll back state or renew freshness.
            if (timestampUs > reports[id].timestampUs) {
                reports[id] = r;
                emit ReportUpdated(id, timestampUs, r.feedUpdateTimestampUs, r.session);
            }
        }
        if (cursor != payload.length) revert InvalidPayload();
    }

    function _uint(bytes memory data, uint256 offset, uint256 size) private pure returns (uint256 value) {
        if (offset + size > data.length) revert InvalidPayload();
        for (uint256 i; i < size; ++i) {
            value = (value << 8) | uint8(data[offset + i]);
        }
    }
}
