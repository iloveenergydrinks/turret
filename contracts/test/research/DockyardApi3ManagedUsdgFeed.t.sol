// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";

contract ManagedApi3Boundary {
    struct Observation {
        int224 value;
        uint32 timestamp;
    }
    mapping(bytes32 => Observation) public dataFeeds;
    mapping(bytes32 => bytes32) public dapiNameHashToDataFeedId;

    function set(bytes32 id, int224 value, uint32 timestamp) external {
        dataFeeds[id] = Observation(value, timestamp);
    }

    function mapName(bytes32 id) external {
        dapiNameHashToDataFeedId[keccak256(abi.encodePacked(bytes32("USDG/USD")))] = id;
    }
}

contract DockyardApi3ManagedUsdgFeedTest is Test {
    ManagedApi3Boundary server;
    DockyardApi3ManagedUsdgFeed feed;
    bytes32 constant ID = 0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7;

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1000000);
        server = new ManagedApi3Boundary();
        server.mapName(ID);
        server.set(ID, 1.000002186e18, 999999);
        feed = new DockyardApi3ManagedUsdgFeed(address(server), address(server).codehash, 3600);
    }

    function testReadsSubscribedAggregationWithoutRedatingIt() public view {
        (uint80 round, int256 value, uint256 started, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(value, 1.000002186e18);
        assertEq(updated, 999999);
        assertEq(started, updated);
        assertEq(round, updated);
        assertEq(answered, round);
        assertEq(feed.aggregator(), address(server));
        assertEq(feed.decimals(), 18);
    }

    function testOneHourBoundaryAndRecovery() public {
        vm.warp(999999 + 3599);
        feed.latestRoundData();
        vm.warp(999999 + 3600);
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        feed.latestRoundData();
        server.set(ID, 0.8e18, uint32(block.timestamp));
        (, int256 price,, uint256 updated,) = feed.latestRoundData();
        assertEq(price, 0.8e18);
        assertEq(updated, block.timestamp);
    }

    function testRemappingCannotSilentlyChangeSources() public {
        server.mapName(bytes32(uint256(123)));
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        feed.latestRoundData();
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.InvalidConfiguration.selector);
        new DockyardApi3ManagedUsdgFeed(address(server), address(server).codehash, 3600);
    }

    function testRejectsBadValueAndTimestamp() public {
        int224[3] memory bad = [int224(0), int224(-1), int224(int256(uint256(type(uint128).max) + 1))];
        for (uint256 i; i < bad.length; ++i) {
            server.set(ID, bad[i], 999999);
            vm.expectRevert();
            feed.latestRoundData();
        }
        server.set(ID, 1e18, 0);
        vm.expectRevert();
        feed.latestRoundData();
        server.set(ID, 1e18, 1000001);
        vm.expectRevert();
        feed.latestRoundData();
    }

    function testPinnedRuntimeAndChain() public {
        vm.expectRevert();
        new DockyardApi3ManagedUsdgFeed(address(server), bytes32(uint256(1)), 3600);
        vm.expectRevert();
        new DockyardApi3ManagedUsdgFeed(address(123), bytes32(0), 3600);
        vm.chainId(1);
        vm.expectRevert();
        new DockyardApi3ManagedUsdgFeed(address(server), address(server).codehash, 3600);
        vm.expectRevert();
        feed.latestRoundData();
        vm.chainId(4663);
        vm.etch(address(server), hex"60006000");
        vm.expectRevert();
        feed.latestRoundData();
    }

    function testFuzzNoPriceClamping(uint128 value) public {
        vm.assume(value > 0);
        server.set(ID, int224(uint224(value)), 999999);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, int256(uint256(value)));
    }
}
