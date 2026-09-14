// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IDockyardOracle} from "../DockyardUSDGCreditVault.sol";
import {DockyardPythVerifier} from "./DockyardPythVerifier.sol";

interface IDockyardScaledStock {
    function uiMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function oraclePaused() external view returns (bool);
}

/// @notice Strict Chainlink + Pyth validation, denominated in USD per raw token.
/// @dev No fallback to a single source. Feed identity and risk limits are immutable.
contract DockyardDualOracle {
    uint8 public constant decimals = 18;
    address public immutable collateral;
    IDockyardOracle public immutable primaryOracle;
    DockyardPythVerifier public immutable pyth;
    uint32 public immutable feedId;
    uint8 public immutable primaryDecimals;

    struct Policy {
        uint32 primaryMaxAge;
        uint32 independentMaxAge;
        uint32 recoveryDelay;
        uint32 observationMaxGap;
        uint16 maxDeviationBps;
        uint16 maxConfidenceBps;
        uint16 minPublishers;
        uint8 borrowingSessions;
        uint8 liquidationSessions;
    }
    Policy public policy;
    uint256 public validSince;
    uint256 public lastObservation;
    error InvalidConfiguration();
    error InvalidPrice();
    error StalePrice();
    error PriceDisagreement(uint256 primary, uint256 independent);
    error MarketClosed();
    error RecoveryPending();
    error CorporateActionPending();
    event Observation(bool valid, uint256 validSince, uint256 observedAt, bytes4 failure);

    constructor(address collateral_, address primary_, address pyth_, uint32 feedId_, Policy memory p) {
        if (
            collateral_.code.length == 0 || primary_.code.length == 0 || pyth_.code.length == 0 || primary_ == pyth_
                || feedId_ == 0 || p.primaryMaxAge == 0 || p.primaryMaxAge > 1 days || p.independentMaxAge == 0
                || p.independentMaxAge > 60 || p.recoveryDelay < 30 || p.recoveryDelay > 1 hours
                || p.observationMaxGap < 10 || p.observationMaxGap > 60 || p.maxDeviationBps == 0
                || p.maxDeviationBps > 500 || p.maxConfidenceBps == 0 || p.maxConfidenceBps > 200 || p.minPublishers < 2
                || p.borrowingSessions == 0 || p.liquidationSessions == 0
                || (p.borrowingSessions | p.liquidationSessions) > 15
                || (p.borrowingSessions & p.liquidationSessions) != p.borrowingSessions
        ) revert InvalidConfiguration();
        collateral = collateral_;
        primaryOracle = IDockyardOracle(primary_);
        pyth = DockyardPythVerifier(pyth_);
        feedId = feedId_;
        uint8 d = IDockyardOracle(primary_).decimals();
        if (d > 18) revert InvalidConfiguration();
        primaryDecimals = d;
        policy = p;
    }

    /// @notice Anyone can record current validation; false never authorizes a price.
    /// Observation gaps restart recovery, even when nobody submitted an outage report.
    function observe() external returns (bool valid) {
        try this.currentData() returns (uint256, uint256, uint16) {
            if (validSince == 0 || block.timestamp - lastObservation >= policy.observationMaxGap) {
                validSince = block.timestamp;
            }
            lastObservation = block.timestamp;
            emit Observation(true, validSince, block.timestamp, bytes4(0));
            return true;
        } catch (bytes memory reason) {
            validSince = 0;
            lastObservation = 0;
            bytes4 failure;
            if (reason.length >= 4) assembly { failure := mload(add(reason, 32)) }
            emit Observation(false, 0, block.timestamp, failure);
            return false;
        }
    }

    function validatedPrice(bool borrowing) public view returns (uint256 value, uint256 updatedAt) {
        uint16 session;
        (value, updatedAt, session) = currentData();
        uint8 mask = borrowing ? policy.borrowingSessions : policy.liquidationSessions;
        if ((mask & (1 << session)) == 0) revert MarketClosed();
        if (
            validSince == 0 || block.timestamp - lastObservation >= policy.observationMaxGap
                || block.timestamp - validSince < policy.recoveryDelay
        ) revert RecoveryPending();
    }

    /// @notice Diagnostic view; does not bypass recovery in any vault action.
    function currentData() public view returns (uint256 value, uint256 updatedAt, uint16 session) {
        IDockyardScaledStock token = IDockyardScaledStock(collateral);
        if (token.oraclePaused()) revert InvalidPrice();
        (uint80 round, int256 answer,, uint256 primaryTime, uint80 answered) = primaryOracle.latestRoundData();
        if (answer <= 0 || answered < round) revert InvalidPrice();
        _fresh(primaryTime, policy.primaryMaxAge);
        DockyardPythVerifier.Report memory r = pyth.report(feedId);
        _freshMicroseconds(r.timestampUs, pyth.MAX_REPORT_AGE());
        _freshMicroseconds(r.feedUpdateTimestampUs, policy.independentMaxAge);
        uint256 stockPrice = _stockPrice(r);
        session = r.session;
        if ((policy.liquidationSessions & (1 << session)) == 0) revert MarketClosed();
        // Reject prices from before the effective corporate action, including cached Pyth values.
        uint256 effective = token.effectiveAt();
        if (effective <= block.timestamp && (primaryTime < effective || r.feedUpdateTimestampUs / 1e6 < effective)) {
            revert CorporateActionPending();
        }
        uint256 multiplier = token.uiMultiplier();
        if (multiplier == 0 || multiplier > 1e30) revert InvalidPrice();
        uint256 independent = Math.mulDiv(stockPrice, multiplier, 1e18);
        if (independent == 0 || uint256(answer) > type(uint128).max) revert InvalidPrice();
        uint256 primary = uint256(answer) * 10 ** (18 - primaryDecimals);
        uint256 low = Math.min(primary, independent);
        uint256 difference = primary > independent ? primary - independent : independent - primary;
        if (Math.mulDiv(difference, 10_000, low, Math.Rounding.Up) > policy.maxDeviationBps) {
            revert PriceDisagreement(primary, independent);
        }
        return (low, Math.min(primaryTime, r.feedUpdateTimestampUs / 1e6), session);
    }

    function _stockPrice(DockyardPythVerifier.Report memory r) private view returns (uint256) {
        if (
            r.price <= 0 || r.confidence == 0 || r.confidence > uint64(type(int64).max)
                || r.publishers < policy.minPublishers || r.exponent < -18 || r.exponent > 0
                || uint256(r.confidence) * 10_000 > uint256(uint64(r.price)) * policy.maxConfidenceBps
        ) revert InvalidPrice();
        return uint256(uint64(r.price)) * 10 ** uint16(int16(18) + r.exponent);
    }

    function maxDeviationBps() external view returns (uint16) {
        return policy.maxDeviationBps;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint256 value, uint256 timestamp) = validatedPrice(false);
        return (uint80(timestamp), int256(value), timestamp, timestamp, uint80(timestamp));
    }

    function _fresh(uint256 time, uint256 maxAge) private view {
        if (time == 0 || time > block.timestamp || block.timestamp - time >= maxAge) revert StalePrice();
    }

    function _freshMicroseconds(uint256 time, uint256 maxAge) private view {
        uint256 nowUs = block.timestamp * 1e6;
        if (time == 0 || time > nowUs || nowUs - time >= maxAge * 1e6) revert StalePrice();
    }
}
