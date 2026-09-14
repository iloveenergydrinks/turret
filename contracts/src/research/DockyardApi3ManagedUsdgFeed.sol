// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IApi3ManagedServer {
    function dapiNameHashToDataFeedId(bytes32 nameHash) external view returns (bytes32);
    function dataFeeds(bytes32 id) external view returns (int224 value, uint32 timestamp);
}

/// @notice Adapter for the subscribed API3 USDG/USD base feed on Robinhood.
/// @dev No OEV rewards: reads the base aggregation directly from the pinned,
/// non-proxy server. Does not trust an upgradeable reader or follow dAPI remaps.
/// Freshness is explicit and immutable, bounded to 25 hours. Configuring a
/// heartbeat budget does not prove delivery guarantees or make a feed risk-free.
contract DockyardApi3ManagedUsdgFeed {
    uint8 public constant decimals = 18;
    uint32 public immutable MAX_AGE;
    bytes32 public constant DAPI_NAME = bytes32("USDG/USD");
    // Observed from the official API3 Market reader and native server after
    // activation transaction 0x04c64ae0ee104a402d644bc41c3c15c13d002beff102483b6d28c9f8a82ea1e6.
    bytes32 public constant DATA_FEED_ID = 0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7;
    IApi3ManagedServer public immutable server;
    bytes32 public immutable serverCodeHash;

    error InvalidConfiguration();
    error Unavailable();

    constructor(address server_, bytes32 expectedServerCodeHash, uint32 maxAge) {
        if (
            block.chainid != 4663 || server_.code.length == 0 || server_.codehash != expectedServerCodeHash
                || maxAge == 0 || maxAge > 25 hours
        ) {
            revert InvalidConfiguration();
        }
        server = IApi3ManagedServer(server_);
        serverCodeHash = expectedServerCodeHash;
        MAX_AGE = maxAge;
        if (server.dapiNameHashToDataFeedId(keccak256(abi.encodePacked(DAPI_NAME))) != DATA_FEED_ID) {
            revert InvalidConfiguration();
        }
    }

    /// @notice Exposes shared dependency for duplicate-source detection.
    function aggregator() external view returns (address) {
        return address(server);
    }

    function description() external pure returns (string memory) {
        return "Dockyard API3 managed USDG / USD (base feed)";
    }

    /// @dev API3 has no rounds. Timestamp identifiers are compatibility tokens
    /// ONLY, not update counters or historical-round IDs. Timestamp is API3's
    /// median provider system timestamp, not oldest contributor or block time.
    /// Dockyard uses these identifiers only for nonzero/order sanity checks.
    /// Never re-date stale values, clamp a depeg to $1, or use this for stock
    /// market-health round attestations. Future timestamps fail closed under
    /// the existing engine policy, potentially reducing availability on L2s.
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (
            block.chainid != 4663 || address(server).codehash != serverCodeHash
                || server.dapiNameHashToDataFeedId(keccak256(abi.encodePacked(DAPI_NAME))) != DATA_FEED_ID
        ) {
            revert Unavailable();
        }
        (int224 value, uint32 timestamp) = server.dataFeeds(DATA_FEED_ID);
        if (
            value <= 0 || uint224(value) > type(uint128).max || timestamp == 0 || timestamp > block.timestamp
                || block.timestamp - timestamp >= MAX_AGE
        ) revert Unavailable();
        return (uint80(timestamp), int256(value), timestamp, timestamp, uint80(timestamp));
    }
}
