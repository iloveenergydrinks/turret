// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardApi3UsdgFeed} from "src/research/DockyardApi3UsdgFeed.sol";

/// @dev Boundary fixture for the external API3 server, not a Dockyard oracle.
contract Api3ServerBoundary {
    struct Observation {
        int224 value;
        uint32 timestamp;
    }
    mapping(bytes32 => Observation) public dataFeeds;

    function set(bytes32 id, int224 value, uint32 timestamp) external {
        dataFeeds[id] = Observation(value, timestamp);
    }
}

contract DockyardApi3UsdgFeedTest is Test {
    Api3ServerBoundary server;
    DockyardApi3UsdgFeed feed;
    // Published provider/template hashes from the API3 USDG signed-data fixture.
    bytes32[5] ids = [
        bytes32(0xca06652fe57fa0df0bb658a6dcbdb67c8cff2abb2e79ad794faf3e2e1f2d3e32),
        0xf07b3aa577ab1f1e93b404eaebc7032d05164cc64bd89c38a4c39cb023458d58,
        0xb7331a8fafec3bb8669880ea41c576049108f1bf4c12caf0de118f8687918c62,
        0xbeb1ca24085f8f84a31d357f6eaa663f97561ce2e18acc4101696237ed85b5a2,
        0xdfb45e2b5fbd1a6f08994936837fad4ee67e889baba2f530f767c2ca6d1cf1f0
    ];

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1_000_000);
        server = new Api3ServerBoundary();
        feed = new DockyardApi3UsdgFeed(address(server), address(server).codehash);
        server.set(ids[0], 1e18, 999990);
        server.set(ids[1], 1.0004e18, 999993);
        server.set(ids[2], 0.9999e18, 999995);
        server.set(ids[3], 1.0001e18, 999997);
        server.set(ids[4], 1.0002e18, 999999);
    }

    function testPriceIsMedianWithOldestProviderTimestamp() public view {
        (uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(answer, 1.0001e18);
        assertEq(round, 999990);
        assertEq(started, 999990);
        assertEq(updated, 999990);
        assertEq(answered, round);
        assertEq(feed.decimals(), 18);
    }

    function testEveryProviderMustHavePositiveFreshNonfutureData() public {
        for (uint256 i; i < 5; ++i) {
            (int224 good, uint32 time) = server.dataFeeds(ids[i]);
            for (uint256 j; j < 2; ++j) {
                server.set(ids[i], j == 0 ? int224(0) : int224(-1), time);
                vm.expectRevert();
                feed.latestRoundData();
            }
            uint32[3] memory invalidTimes = [uint32(0), 999940, 1000001];
            for (uint256 j; j < 3; ++j) {
                server.set(ids[i], good, invalidTimes[j]);
                vm.expectRevert();
                feed.latestRoundData();
            }
            server.set(ids[i], good, time);
        }
    }

    function testDisagreeingProvidersCannotBeHiddenByTheMedian() public {
        for (uint256 i; i < 5; ++i) {
            (int224 good, uint32 time) = server.dataFeeds(ids[i]);
            server.set(ids[i], 2e18, time);
            vm.expectRevert();
            feed.latestRoundData();
            server.set(ids[i], good, time);
        }
        // All observations are fresh, but one is out of sync with the others.
        server.set(ids[0], 1e18, 999988);
        vm.expectRevert();
        feed.latestRoundData();
    }

    function testOnlyPinnedServerCodeOnRobinhoodCanBeUsed() public {
        vm.expectRevert();
        new DockyardApi3UsdgFeed(address(server), bytes32(uint256(1)));
        vm.expectRevert();
        new DockyardApi3UsdgFeed(address(0), bytes32(0));
        vm.expectRevert();
        new DockyardApi3UsdgFeed(address(123), address(123).codehash);
        vm.chainId(1);
        vm.expectRevert();
        new DockyardApi3UsdgFeed(address(server), address(server).codehash);
        vm.chainId(4663);
        vm.etch(address(server), hex"60006000");
        vm.expectRevert();
        feed.latestRoundData();
    }

    function testSourceIdentityIsExposedSoDuplicateWrappersAreNotIndependent() public view {
        assertEq(feed.aggregator(), address(server));
        assertEq(feed.description(), "Dockyard API3 USDG / USD (five fixed providers)");
        for (uint256 i; i < 5; ++i) {
            assertEq(feed.beaconId(i), ids[i]);
        }
    }

    function testFreshnessAndAgreementBoundariesAreExact() public {
        for (uint256 i; i < 5; ++i) {
            server.set(ids[i], 1e18, 999941);
        }
        feed.latestRoundData();
        vm.warp(1000001);
        vm.expectRevert();
        feed.latestRoundData();
        for (uint256 i; i < 5; ++i) {
            server.set(ids[i], 1e18, 999991);
        }
        server.set(ids[4], 1.01e18, 1000001);
        feed.latestRoundData(); // Exactly 1% spread and 10 seconds of skew.
        server.set(ids[4], 1.01e18 + 1, 1000001);
        vm.expectRevert();
        feed.latestRoundData();
    }

    function testStablecoinDepegIsNotReplacedWithOneDollar() public {
        for (uint256 i; i < 5; ++i) {
            server.set(ids[i], 0.8e18, 999999);
        }
        (, int256 price,,,) = feed.latestRoundData();
        assertEq(price, 0.8e18);
    }

    function testProviderRefreshDoesNotHideAnOldObservation() public {
        for (uint256 i; i < 5; ++i) {
            server.set(ids[i], 1e18, 999950);
        }
        vm.warp(1000010);
        for (uint256 i = 1; i < 5; ++i) {
            server.set(ids[i], 1e18, 1000010);
        }
        vm.expectRevert();
        feed.latestRoundData();
        server.set(ids[0], 1e18, 1000010);
        (, int256 price,, uint256 updated,) = feed.latestRoundData();
        assertEq(price, 1e18);
        assertEq(updated, 1000010);
    }

    function testFuzzMedianIsIndependentOfProviderOrder(uint128 raw, uint64 deltaSeed, uint8 rotation) public {
        uint256 base = bound(uint256(raw), 1e8, 1e35);
        uint256 delta = bound(uint256(deltaSeed), 1, base / 1000);
        int224[5] memory values = [
            int224(int256(base + 2 * delta)),
            int224(int256(base - delta)),
            int224(int256(base)),
            int224(int256(base + delta)),
            int224(int256(base - 2 * delta))
        ];
        for (uint256 i; i < 5; ++i) {
            server.set(ids[(i + rotation) % 5], values[i], 999999);
        }
        (, int256 price,,,) = feed.latestRoundData();
        assertEq(price, int256(base));
    }

    function testFuzzAnyExpiredProviderMakesPriceUnavailable(uint8 index, uint32 age) public {
        uint256 i = bound(index, 0, 4);
        uint256 elapsed = bound(age, 60, 86400);
        server.set(ids[i], 1e18, uint32(block.timestamp - elapsed));
        vm.expectRevert();
        feed.latestRoundData();
    }
}
