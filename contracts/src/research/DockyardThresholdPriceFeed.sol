// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";

/// @notice Immutable threshold-authenticated price cache with Dockyard's reduced AggregatorV3 read surface.
/// @dev Research infrastructure, not an oracle-provider endorsement or market approval. Each reporter
/// must be controlled by a genuinely independent operator and independently reconstruct the price from
/// the observations committed by `observationsHash`. Multiple keys in one service are one source, not a
/// threshold oracle. The immutable policy must specify a deterministic conservative collateral/USDG
/// calculation so a submitter cannot choose a favorable quorum or aggregation method.
contract DockyardThresholdPriceFeed is EIP712 {
    uint8 public constant decimals = 18;
    uint8 public constant MAX_REPORTERS = 9;
    bytes32 public constant REPORT_TYPEHASH = keccak256(
        "PriceReport(address asset,address quote,uint64 sequence,uint64 reporterSetEpoch,uint64 observedAt,uint64 signedAt,uint64 validUntil,uint192 price,uint32 sourceMask,bytes32 policyHash,bytes32 observationsHash)"
    );

    address public immutable asset;
    address public immutable quote;
    uint64 public immutable reporterSetEpoch;
    bytes32 public immutable policyHash;
    uint32 public immutable maxAge;
    uint32 public immutable requiredSourceMask;
    uint8 public immutable threshold;
    uint8 public immutable reporterCount;
    mapping(address => bool) public isReporter;

    struct PriceReport {
        address asset;
        address quote;
        uint64 sequence;
        uint64 reporterSetEpoch;
        uint64 observedAt;
        uint64 signedAt;
        uint64 validUntil;
        uint192 price;
        uint32 sourceMask;
        bytes32 policyHash;
        bytes32 observationsHash;
    }

    PriceReport public latestReport;

    error InvalidConfiguration();
    error InvalidReport();
    error InvalidSignatures();
    error Unavailable();

    event PriceUpdated(
        uint64 indexed sequence, uint64 indexed observedAt, uint192 price, uint32 sourceMask, bytes32 observationsHash
    );

    constructor(
        address asset_,
        address quote_,
        address[] memory reporters_,
        uint8 threshold_,
        uint32 maxAge_,
        uint32 requiredSourceMask_,
        uint64 reporterSetEpoch_,
        bytes32 policyHash_
    ) EIP712("DockyardThresholdPriceFeed", "1") {
        if (
            asset_ == address(0) || quote_ == address(0) || asset_ == quote_ || reporters_.length < 4
                || reporters_.length > MAX_REPORTERS || threshold_ < 3 || threshold_ > reporters_.length
                || uint256(threshold_) * 2 <= reporters_.length || maxAge_ == 0 || maxAge_ > 60
                || !_atLeastThreeBits(requiredSourceMask_) || reporterSetEpoch_ == 0 || policyHash_ == bytes32(0)
        ) revert InvalidConfiguration();
        address previous;
        for (uint256 i; i < reporters_.length; ++i) {
            address reporter = reporters_[i];
            // A canonical ascending set rejects duplicates and makes signer uniqueness cheap to verify.
            if (reporter == address(0) || uint160(reporter) <= uint160(previous)) revert InvalidConfiguration();
            isReporter[reporter] = true;
            previous = reporter;
        }
        asset = asset_;
        quote = quote_;
        threshold = threshold_;
        maxAge = maxAge_;
        requiredSourceMask = requiredSourceMask_;
        reporterSetEpoch = reporterSetEpoch_;
        policyHash = policyHash_;
        reporterCount = uint8(reporters_.length);
    }

    /// @notice Store a fresh report. The submitter need not be a reporter.
    /// Signatures must be ordered by ascending recovered signer address.
    function submit(PriceReport calldata report, bytes[] calldata signatures) external {
        if (
            report.asset != asset || report.quote != quote || report.reporterSetEpoch != reporterSetEpoch
                || report.policyHash != policyHash || report.sequence <= latestReport.sequence || report.observedAt == 0
                || report.observedAt <= latestReport.observedAt || report.observedAt > report.signedAt
                || report.signedAt > block.timestamp || report.signedAt - report.observedAt >= maxAge
                || block.timestamp - report.observedAt >= maxAge || report.validUntil <= block.timestamp
                || report.validUntil > report.signedAt + maxAge || report.price == 0
                || (report.sourceMask & requiredSourceMask) != requiredSourceMask
                || report.observationsHash == bytes32(0)
        ) revert InvalidReport();
        if (signatures.length < threshold || signatures.length > reporterCount) revert InvalidSignatures();

        bytes32 digest = reportDigest(report);
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isReporter[signer] || uint160(signer) <= uint160(previous)) revert InvalidSignatures();
            previous = signer;
        }

        latestReport = report;
        emit PriceUpdated(report.sequence, report.observedAt, report.price, report.sourceMask, report.observationsHash);
    }

    function reportDigest(PriceReport calldata report) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    REPORT_TYPEHASH,
                    report.asset,
                    report.quote,
                    report.sequence,
                    report.reporterSetEpoch,
                    report.observedAt,
                    report.signedAt,
                    report.validUntil,
                    report.price,
                    report.sourceMask,
                    report.policyHash,
                    report.observationsHash
                )
            )
        );
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        PriceReport memory report = latestReport;
        if (
            report.sequence == 0 || report.observedAt == 0 || report.observedAt > block.timestamp
                || block.timestamp - report.observedAt >= maxAge || report.validUntil <= block.timestamp
        ) revert Unavailable();
        return (
            uint80(report.sequence),
            int256(uint256(report.price)),
            report.observedAt,
            report.observedAt,
            uint80(report.sequence)
        );
    }

    function _atLeastThreeBits(uint32 value) private pure returns (bool) {
        if (value == 0) return false;
        value &= value - 1;
        if (value == 0) return false;
        return (value & (value - 1)) != 0;
    }
}
