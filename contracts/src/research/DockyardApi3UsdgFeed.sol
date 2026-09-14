// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IApi3BeaconServer {
    function dataFeeds(bytes32 id) external view returns (int224 value, uint32 timestamp);
}

/// @notice USDG/USD from five fixed API3 provider beacons, in 18 decimals.
/// @dev Candidate, not production approved. These identities come from API3
/// integration revision ba4aa04f95eeba693d4b8b7d937377b6bfd6a47f. This is a
/// Dockyard aggregation, not an initialized API3 dAPI or an availability promise.
contract DockyardApi3UsdgFeed {
    uint8 public constant decimals = 18;
    uint32 public constant MAX_AGE = 60;
    uint32 public constant MAX_TIMESTAMP_SKEW = 10;
    uint16 public constant MAX_SPREAD_BPS = 100;
    IApi3BeaconServer public immutable server;
    bytes32 public immutable serverCodeHash;
    error Unavailable();
    error InvalidConfiguration();

    constructor(address server_, bytes32 expectedServerCodeHash) {
        if (block.chainid != 4663 || server_.code.length == 0 || server_.codehash != expectedServerCodeHash) {
            revert InvalidConfiguration();
        }
        server = IApi3BeaconServer(server_);
        serverCodeHash = expectedServerCodeHash;
    }

    /// @notice Exposes the common dependency to deployment/monitoring checks.
    /// Two wrappers of these beacons are still the same source, not independent.
    function aggregator() external view returns (address) {
        return address(server);
    }

    function description() external pure returns (string memory) {
        return "Dockyard API3 USDG / USD (five fixed providers)";
    }

    function beaconId(uint256 index) public pure returns (bytes32) {
        bytes32[5] memory ids = [
            bytes32(0xca06652fe57fa0df0bb658a6dcbdb67c8cff2abb2e79ad794faf3e2e1f2d3e32),
            0xf07b3aa577ab1f1e93b404eaebc7032d05164cc64bd89c38a4c39cb023458d58,
            0xb7331a8fafec3bb8669880ea41c576049108f1bf4c12caf0de118f8687918c62,
            0xbeb1ca24085f8f84a31d357f6eaa663f97561ce2e18acc4101696237ed85b5a2,
            0xdfb45e2b5fbd1a6f08994936837fad4ee67e889baba2f530f767c2ca6d1cf1f0
        ];
        return ids[index];
    }

    /// @dev Round IDs are the oldest contributing provider timestamp, not
    /// Chainlink rounds. Prices can change without that timestamp changing.
    /// No historical-round interface is provided. Provider timestamps denote
    /// processing/signing time, not necessarily an underlying exchange update.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (address(server).codehash != serverCodeHash) revert Unavailable();
        int256[5] memory prices;
        uint256 oldest = type(uint32).max;
        uint256 newest;
        for (uint256 i; i < 5; ++i) {
            (int224 value, uint32 timestamp) = server.dataFeeds(beaconId(i));
            if (value <= 0 || timestamp == 0 || timestamp > block.timestamp || block.timestamp - timestamp >= MAX_AGE) {
                revert Unavailable();
            }
            prices[i] = value;
            if (timestamp < oldest) oldest = timestamp;
            if (timestamp > newest) newest = timestamp;
        }
        if (newest - oldest > MAX_TIMESTAMP_SKEW) revert Unavailable();
        for (uint256 i = 1; i < 5; ++i) {
            int256 value = prices[i];
            uint256 j = i;
            while (j > 0 && prices[j - 1] > value) {
                prices[j] = prices[j - 1];
                --j;
            }
            prices[j] = value;
        }
        // Every provider is required. A fresh outlier must not be hidden by a
        // healthy median, and a relay must not silently choose a favorable subset.
        if (uint256(prices[4] - prices[0]) * 10000 > uint256(prices[0]) * MAX_SPREAD_BPS) revert Unavailable();
        return (uint80(oldest), prices[2], oldest, oldest, uint80(oldest));
    }
}
