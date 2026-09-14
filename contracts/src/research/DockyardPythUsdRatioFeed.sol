// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {DockyardPythVerifier} from "../Oracles/DockyardPythVerifier.sol";

/// @notice Authenticated collateral/USD divided by USDG/USD, scaled to 18 decimals.
/// @dev Research adapter, not a market approval. Deployment review must bind feed
/// identities to the exact tokens and assess publisher independence. The hub must
/// use Pyth's verified deployment, not a Dockyard-controlled signing authority.
contract DockyardPythUsdRatioFeed {
    uint8 public constant decimals = 18;
    DockyardPythVerifier public immutable hub;
    address public immutable collateral;
    address public immutable usdg;
    uint32 public immutable collateralFeedId;
    uint32 public immutable usdgFeedId;
    bytes32 public immutable hubCodeHash;
    bytes32 public immutable verifierCodeHash;
    address public immutable verifier;
    uint32 public immutable maxPriceAge;
    uint32 public immutable maxPairSkew;
    uint16 public immutable maxConfidenceBps;
    uint16 public immutable collateralMinPublishers;
    uint16 public immutable usdgMinPublishers;

    struct Config {
        address hub;
        address collateral;
        address usdg;
        uint32 collateralFeedId;
        uint32 usdgFeedId;
        uint32 maxPriceAge;
        uint32 maxPairSkew;
        uint16 maxConfidenceBps;
        uint16 collateralMinPublishers;
        uint16 usdgMinPublishers;
    }

    error InvalidConfiguration();
    error Unavailable();

    constructor(Config memory c) {
        if (
            c.hub.code.length == 0 || c.collateral == c.usdg || c.collateralFeedId == 0 || c.usdgFeedId == 0
                || c.collateralFeedId == c.usdgFeedId || c.maxPriceAge == 0 || c.maxPriceAge > 60 || c.maxPairSkew == 0
                || c.maxPairSkew > c.maxPriceAge || c.maxConfidenceBps == 0 || c.maxConfidenceBps > 1000
                || c.collateralMinPublishers < 2 || c.usdgMinPublishers < 2
                || IERC20Metadata(c.collateral).decimals() != 18 || IERC20Metadata(c.usdg).decimals() != 6
        ) {
            revert InvalidConfiguration();
        }
        hub = DockyardPythVerifier(c.hub);
        address v = address(DockyardPythVerifier(c.hub).verifier());
        if (v.code.length == 0) revert InvalidConfiguration();
        verifier = v;
        hubCodeHash = c.hub.codehash;
        verifierCodeHash = v.codehash;
        collateral = c.collateral;
        usdg = c.usdg;
        collateralFeedId = c.collateralFeedId;
        usdgFeedId = c.usdgFeedId;
        maxPriceAge = c.maxPriceAge;
        maxPairSkew = c.maxPairSkew;
        maxConfidenceBps = c.maxConfidenceBps;
        collateralMinPublishers = c.collateralMinPublishers;
        usdgMinPublishers = c.usdgMinPublishers;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (address(hub).codehash != hubCodeHash || verifier.codehash != verifierCodeHash) revert Unavailable();
        DockyardPythVerifier.Report memory a = hub.report(collateralFeedId);
        DockyardPythVerifier.Report memory b = hub.report(usdgFeedId);
        _validate(a, collateralMinPublishers);
        _validate(b, usdgMinPublishers);
        if (
            _difference(a.timestampUs, b.timestampUs) > uint256(maxPairSkew) * 1e6
                || _difference(a.feedUpdateTimestampUs, b.feedUpdateTimestampUs) > uint256(maxPairSkew) * 1e6
        ) {
            revert Unavailable();
        }
        // Lower collateral estimate / upper USDG estimate: never assume USDG=$1.
        // Confidence is a provider uncertainty measure, not a guaranteed bound.
        uint256 numerator = (uint256(uint64(a.price)) - a.confidence) * 10 ** uint16(18 + a.exponent);
        uint256 denominator = (uint256(uint64(b.price)) + b.confidence) * 10 ** uint16(18 + b.exponent);
        uint256 value = Math.mulDiv(numerator, 1e18, denominator);
        if (value == 0 || value > uint256(type(int256).max)) revert Unavailable();
        uint256 oldest = Math.min(a.feedUpdateTimestampUs, b.feedUpdateTimestampUs);
        uint256 updated = oldest / 1e6;
        if (updated == 0) revert Unavailable();
        return (uint80(oldest), int256(value), updated, updated, uint80(oldest));
    }

    function _validate(DockyardPythVerifier.Report memory r, uint16 minimum) private view {
        uint256 nowUs = block.timestamp * 1e6;
        if (
            r.timestampUs == 0 || r.timestampUs > nowUs || nowUs - r.timestampUs >= hub.MAX_REPORT_AGE() * 1e6
                || r.feedUpdateTimestampUs == 0 || r.feedUpdateTimestampUs > r.timestampUs
                || nowUs - r.feedUpdateTimestampUs >= uint256(maxPriceAge) * 1e6 || r.price <= 0 || r.exponent < -18
                || r.exponent > 0 || r.session != 0 || r.publishers < minimum
                || uint256(r.confidence) >= uint256(uint64(r.price))
                || uint256(r.confidence) * 10000 > uint256(uint64(r.price)) * maxConfidenceBps
        ) revert Unavailable();
    }

    function _difference(uint64 a, uint64 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
