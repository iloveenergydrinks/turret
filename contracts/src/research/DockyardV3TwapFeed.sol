// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IsolatedTickMath} from "./IsolatedTickMath.sol";

interface IIsolatedV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observations(uint256) external view returns (uint32, int56, uint160, bool);
    function observe(uint32[] calldata) external view returns (int56[] memory, uint160[] memory);
}

interface IIsolatedV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice Research-only collateral/intermediate/USDG geometric TWAP, scaled to 18 decimals.
/// @dev NOT an independent second source when paired with another window on the same pools.
/// USDG-denominated, not a guarantee of USDG's dollar peg. Immutable, no privileged price setter.
/// Consult/quote math adapted from Uniswap v3-periphery OracleLibrary (GPL-2.0-or-later):
/// https://github.com/Uniswap/v3-periphery/blob/0682387198a24c7cd63566a2c58398533860a5d1/contracts/libraries/OracleLibrary.sol
contract DockyardV3TwapFeed {
    uint8 public constant decimals = 18;
    address public immutable collateral;
    address public immutable intermediate;
    address public immutable usdg;
    IIsolatedV3Pool public immutable firstPool;
    IIsolatedV3Pool public immutable secondPool;
    bytes32 public immutable firstCodeHash;
    bytes32 public immutable secondCodeHash;
    uint32 public immutable window;
    uint32 public immutable maxObservationAge;
    uint24 public immutable maxSpotTickDeviation;
    uint128 public immutable firstMinLiquidity;
    uint128 public immutable secondMinLiquidity;

    struct Config {
        address collateral;
        address intermediate;
        address usdg;
        address factory;
        address firstPool;
        address secondPool;
        uint32 window;
        uint32 maxObservationAge;
        uint24 maxSpotTickDeviation;
        uint128 firstMinLiquidity;
        uint128 secondMinLiquidity;
    }

    error InvalidConfiguration();
    error Unavailable();
    error ThinLiquidity();
    error SpotDeviation();

    constructor(Config memory c) {
        if (
            c.collateral == c.intermediate || c.collateral == c.usdg || c.intermediate == c.usdg
                || c.firstPool == c.secondPool || c.factory.code.length == 0 || c.window < 300 || c.window > 1 days
                || c.maxObservationAge == 0 || c.maxObservationAge > c.window || c.maxSpotTickDeviation == 0
                || c.maxSpotTickDeviation > 5000 || c.firstMinLiquidity == 0 || c.secondMinLiquidity == 0
                || IERC20Metadata(c.collateral).decimals() != 18 || IERC20Metadata(c.intermediate).decimals() != 18
                || IERC20Metadata(c.usdg).decimals() != 6
        ) revert InvalidConfiguration();
        _validatePool(c.firstPool, c.factory, c.collateral, c.intermediate);
        _validatePool(c.secondPool, c.factory, c.intermediate, c.usdg);
        collateral = c.collateral;
        intermediate = c.intermediate;
        usdg = c.usdg;
        firstPool = IIsolatedV3Pool(c.firstPool);
        secondPool = IIsolatedV3Pool(c.secondPool);
        firstCodeHash = c.firstPool.codehash;
        secondCodeHash = c.secondPool.codehash;
        window = c.window;
        maxObservationAge = c.maxObservationAge;
        maxSpotTickDeviation = c.maxSpotTickDeviation;
        firstMinLiquidity = c.firstMinLiquidity;
        secondMinLiquidity = c.secondMinLiquidity;
    }

    function _validatePool(address venue, address factory, address a, address b) private view {
        if (venue.code.length == 0) revert InvalidConfiguration();
        IIsolatedV3Pool p = IIsolatedV3Pool(venue);
        if (
            p.factory() != factory || p.token0() != (a < b ? a : b) || p.token1() != (a < b ? b : a)
                || IIsolatedV3Factory(factory).getPool(a, b, p.fee()) != venue
        ) revert InvalidConfiguration();
    }

    /// @dev Freshness is the oldest actual pool write, not the time this view is called.
    /// A recent write is necessary, not sufficient evidence of economic price discovery.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (address(firstPool).codehash != firstCodeHash || address(secondPool).codehash != secondCodeHash) {
            revert Unavailable();
        }
        (int24 a, uint256 ta) = _consult(firstPool, firstMinLiquidity, collateral < intermediate);
        (int24 b, uint256 tb) = _consult(secondPool, secondMinLiquidity, intermediate < usdg);
        uint256 value = _quoteTicks(a, b);
        uint256 updated = Math.min(ta, tb);
        return (uint80(updated), int256(value), updated, updated, uint80(updated));
    }

    /// @notice Raw comparison inputs for a separately authenticated corroboration policy.
    /// @dev NOT a usable lending/liquidation oracle by itself: spot can be manipulated.
    /// Preserves runtime, observation, locked-pool and historical/current liquidity
    /// checks, but reports rather than rejects the spot/TWAP deviation condition.
    function guardedQuotes()
        external
        view
        returns (uint256 average, uint256 spot, uint256 updated, bool withinDeviation)
    {
        if (address(firstPool).codehash != firstCodeHash || address(secondPool).codehash != secondCodeHash) {
            revert Unavailable();
        }
        (int24 a, int24 sa, uint256 ta, bool okA) =
            _comparisonHop(firstPool, firstMinLiquidity, collateral < intermediate);
        (int24 b, int24 sb, uint256 tb, bool okB) = _comparisonHop(secondPool, secondMinLiquidity, intermediate < usdg);
        return (_quoteTicks(a, b), _quoteTicks(sa, sb), Math.min(ta, tb), okA && okB);
    }

    function _comparisonHop(IIsolatedV3Pool p, uint128 minimum, bool forward)
        private
        view
        returns (int24 meanTick, int24 spotTick, uint256 updated, bool withinDeviation)
    {
        int24 spot;
        (spot, updated) = _lastObservation(p);
        int56 delta = _observeDelta(p, minimum);
        int256 divisor = int256(uint256(window));
        int256 mean = int256(delta) / divisor;
        if (delta < 0 && int256(delta) % divisor != 0) --mean;
        if (mean < -887272 || mean > 887272 || spot < -887272 || spot > 887272) revert Unavailable();
        int256 difference = int256(spot) - mean;
        withinDeviation = uint256(difference < 0 ? -difference : difference) <= maxSpotTickDeviation;
        int256 oriented = forward ? int256(delta) : -int256(delta);
        int256 directed = oriented / divisor;
        if (oriented < 0 && oriented % divisor != 0) --directed;
        if (directed < -887272 || directed > 887272) revert Unavailable();
        return (int24(directed), forward ? spot : -spot, updated, withinDeviation);
    }

    function _quoteTicks(int24 a, int24 b) private pure returns (uint256 value) {
        int256 chained = int256(a) + int256(b);
        if (chained < -887272 || chained > 887272) revert Unavailable();
        uint160 sqrt = IsolatedTickMath.getSqrtRatioAtTick(int24(chained));
        // 1e30 raw collateral units -> USDG raw units = 18-decimal USDG per whole token.
        // Avoid rounding tiny token prices to zero at USDG's six-decimal resolution.
        value = sqrt <= type(uint128).max
            ? Math.mulDiv(uint256(sqrt) * sqrt, 1e30, 1 << 192)
            : Math.mulDiv(Math.mulDiv(sqrt, sqrt, 1 << 64), 1e30, 1 << 128);
        if (value == 0 || value > uint256(type(int256).max)) revert Unavailable();
    }

    function _consult(IIsolatedV3Pool p, uint128 minimum, bool forward)
        private
        view
        returns (int24 directedTick, uint256 updated)
    {
        int24 spot;
        (spot, updated) = _lastObservation(p);
        int56 delta = _observeDelta(p, minimum);
        int256 mean = int256(delta) / int256(uint256(window));
        if (delta < 0 && int256(delta) % int256(uint256(window)) != 0) --mean;
        if (mean < -887272 || mean > 887272 || spot < -887272 || spot > 887272) revert Unavailable();
        int256 deviation = int256(spot) - mean;
        if (uint256(deviation < 0 ? -deviation : deviation) > maxSpotTickDeviation) revert SpotDeviation();
        // Floor in the quote direction, including when reversing token order.
        int256 oriented = forward ? int256(delta) : -int256(delta);
        int256 quoteTick = oriented / int256(uint256(window));
        if (oriented < 0 && oriented % int256(uint256(window)) != 0) --quoteTick;
        if (quoteTick < -887272 || quoteTick > 887272) revert Unavailable();
        directedTick = int24(quoteTick);
    }

    function _lastObservation(IIsolatedV3Pool p) private view returns (int24, uint256) {
        (, int24 spot, uint16 index, uint16 cardinality,,, bool unlocked) = p.slot0();
        if (!unlocked || cardinality < 2 || index >= cardinality || block.timestamp > type(uint32).max) {
            revert Unavailable();
        }
        (uint32 timestamp,,, bool initialized) = p.observations(index);
        if (
            !initialized || timestamp == 0 || timestamp > block.timestamp
                || block.timestamp - timestamp > maxObservationAge
        ) {
            revert Unavailable();
        }
        return (spot, timestamp);
    }

    function _observeDelta(IIsolatedV3Pool p, uint128 minimum) private view returns (int56 delta) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory ticks, uint160[] memory liquidities) = p.observe(ago);
        if (ticks.length != 2 || liquidities.length != 2) revert Unavailable();
        uint160 liquidityDelta;
        // V3 accumulators deliberately wrap at their ABI widths.
        unchecked {
            delta = ticks[1] - ticks[0];
            liquidityDelta = liquidities[1] - liquidities[0];
        }
        if (liquidityDelta == 0) revert Unavailable();
        uint256 harmonic = (uint192(window) * type(uint160).max) / (uint192(liquidityDelta) << 32);
        if (harmonic < minimum || p.liquidity() < minimum) revert ThinLiquidity();
    }
}
