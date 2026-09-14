// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {DockyardApi3UsdgFeed} from "src/research/DockyardApi3UsdgFeed.sol";

interface IApi3SignedPublisher {
    function updateBeaconWithSignedData(
        address airnode,
        bytes32 templateId,
        uint256 timestamp,
        bytes calldata data,
        bytes calldata signature
    ) external returns (bytes32);
}

/// @notice Real API3 server bytecode and public provider signatures. All writes
/// are confined to a local fork; no provider keys or user funds are used.
contract DockyardApi3UsdgForkTest is Test {
    string fixture;
    DockyardApi3UsdgFeed feed;
    IApi3SignedPublisher publisher;

    function setUp() public {
        fixture = vm.readFile("./utils/assets/oracle-fixtures/api3-usdg-fork.json");
        assertEq(block.chainid, 4663);
        assertEq(block.number, vm.parseUint(vm.parseJsonString(fixture, ".blockNumber")));
        assertEq(block.timestamp, vm.parseUint(vm.parseJsonString(fixture, ".blockTimestamp")));
        address server = vm.parseJsonAddress(fixture, ".server");
        assertEq(server, 0xEa5f320Ee0ef7E81AFAf2a9b4FBc1a7d093287fe);
        bytes32 pin = vm.parseJsonBytes32(fixture, ".serverCodeHash");
        assertEq(server.codehash, pin);
        publisher = IApi3SignedPublisher(server);
        feed = new DockyardApi3UsdgFeed(server, pin);
    }

    function _publish() private {
        for (uint256 i; i < 5; ++i) {
            string memory path = string.concat(".packages[", vm.toString(i), "]");
            bytes32 id = publisher.updateBeaconWithSignedData(
                vm.parseJsonAddress(fixture, string.concat(path, ".airnode")),
                vm.parseJsonBytes32(fixture, string.concat(path, ".templateId")),
                vm.parseUint(vm.parseJsonString(fixture, string.concat(path, ".timestamp"))),
                vm.parseJsonBytes(fixture, string.concat(path, ".encodedValue")),
                vm.parseJsonBytes(fixture, string.concat(path, ".signature"))
            );
            assertEq(id, feed.beaconId(i));
        }
    }

    function testRealSignedUpdatesProduceTheExpectedUsdGPriceThroughAdapter() public {
        _publish();
        (uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(answer, int256(vm.parseUint(vm.parseJsonString(fixture, ".expectedMedian"))));
        assertEq(updated, vm.parseUint(vm.parseJsonString(fixture, ".expectedOldest")));
        assertEq(started, updated);
        assertEq(round, updated);
        assertEq(answered, round);
        console2.log("API3 native fork block", block.number);
        console2.log("USDG median, 18 decimals", uint256(answer));
        console2.log("Oldest provider timestamp", updated);
    }

    function testTamperedProviderUpdateCannotChangeTheAcceptedPrice() public {
        _publish();
        (, int256 beforePrice,,,) = feed.latestRoundData();
        address airnode = vm.parseJsonAddress(fixture, ".packages[0].airnode");
        bytes32 templateId = vm.parseJsonBytes32(fixture, ".packages[0].templateId");
        uint256 timestamp = vm.parseUint(vm.parseJsonString(fixture, ".packages[0].timestamp"));
        bytes memory signature = vm.parseJsonBytes(fixture, ".packages[0].signature");
        vm.expectRevert("Signature mismatch");
        publisher.updateBeaconWithSignedData(airnode, templateId, timestamp + 1, abi.encode(int256(100e18)), signature);
        (, int256 afterPrice,,,) = feed.latestRoundData();
        assertEq(afterPrice, beforePrice);
    }

    function testPublishedPriceExpiresWithoutAnotherProviderUpdate() public {
        _publish();
        vm.warp(vm.parseUint(vm.parseJsonString(fixture, ".expectedOldest")) + 60);
        vm.expectRevert(DockyardApi3UsdgFeed.Unavailable.selector);
        feed.latestRoundData();
    }
}
