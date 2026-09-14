// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {DockyardV3TwapFeed} from "./DockyardV3TwapFeed.sol";

interface ICorroboratingFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Research policy for downward gaps confirmed by an independent, fresh
/// USDG-denominated reference. Not approved for production. Both sources required.
/// @dev The reference MUST NOT derive from these same DEX pools. Runtime hashes
/// do not establish independence or rule out proxy upgrades. Never pair this with
/// a second TWAP window and claim independent pricing. The engine should also read
/// the authenticated reference directly as its secondary feed.
contract DockyardCorroboratedV3Feed {
    uint8 public constant decimals = 18;
    DockyardV3TwapFeed public immutable dex;
    ICorroboratingFeed public immutable referenceFeed;
    bytes32 public immutable dexCodeHash;
    bytes32 public immutable referenceCodeHash;
    uint8 public immutable referenceDecimals;
    uint32 public immutable referenceMaxAge;
    uint16 public immutable agreementBps;

    error InvalidConfiguration();
    error Unavailable();
    error Uncorroborated();

    constructor(DockyardV3TwapFeed dex_, ICorroboratingFeed reference_, uint32 maxAge_, uint16 agreementBps_) {
        if (
            address(dex_).code.length == 0 || address(reference_).code.length == 0
                || address(dex_) == address(reference_) || maxAge_ == 0 || maxAge_ > 60 || agreementBps_ == 0
                || agreementBps_ > 500
        ) revert InvalidConfiguration();
        uint8 precision = reference_.decimals();
        if (precision > 18 || dex_.decimals() != 18) revert InvalidConfiguration();
        dex = dex_;
        referenceFeed = reference_;
        dexCodeHash = address(dex_).codehash;
        referenceCodeHash = address(reference_).codehash;
        referenceDecimals = precision;
        referenceMaxAge = maxAge_;
        agreementBps = agreementBps_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint256 value, uint256 updated,) = quote();
        return (uint80(updated), int256(value), updated, updated, uint80(updated));
    }

    /// @return value Accepted USDG-denominated price with 18 decimals.
    /// @return updated Oldest timestamp among the two sources.
    /// @return downwardGap True only when the current independent reference and
    /// DEX spot are both below the average and agree within the immutable limit.
    function quote() public view returns (uint256 value, uint256 updated, bool downwardGap) {
        if (
            address(dex).codehash != dexCodeHash || address(referenceFeed).codehash != referenceCodeHash
                || referenceFeed.decimals() != referenceDecimals
        ) revert Unavailable();
        // This call still rejects stale/incomplete history, thin liquidity,
        // changed pool code and a pool currently inside its swap callback.
        (uint256 average, uint256 spot, uint256 dexTime, bool normal) = dex.guardedQuotes();
        (uint80 round, int256 answer,, uint256 refTime, uint80 answered) = referenceFeed.latestRoundData();
        if (
            round == 0 || answered < round || answer <= 0 || refTime == 0 || refTime > block.timestamp
                || block.timestamp - refTime > referenceMaxAge
        ) revert Unavailable();
        uint256 referencePrice = uint256(answer) * 10 ** (18 - referenceDecimals);
        if (referencePrice > uint256(type(int256).max)) revert Unavailable();
        updated = Math.min(dexTime, refTime);
        if (normal && _agree(average, referencePrice)) return (Math.min(average, referencePrice), updated, false);
        if (spot >= average || referencePrice >= average || !_agree(spot, referencePrice)) revert Uncorroborated();
        // Do not use the lower DEX spot to discount the borrower's collateral in
        // gap mode. An attacker can move spot; it cannot lower this independent
        // reference merely by trading these pools.
        return (referencePrice, updated, true);
    }

    function _agree(uint256 a, uint256 b) private view returns (bool) {
        uint256 low = Math.min(a, b);
        return low > 0 && Math.mulDiv(Math.max(a, b) - low, 10000, low, Math.Rounding.Up) <= agreementBps;
    }
}
