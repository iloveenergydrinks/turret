// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";

interface IManagedApi3Reader {
    function read() external view returns (int224, uint32);
}

/// @notice Run at the recorded post-purchase Robinhood block, not a mock chain.
/// Adapter deployment and time travel are local fork operations only.
contract DockyardApi3ManagedUsdgForkTest is Test {
    DockyardApi3ManagedUsdgFeed feed;

    function setUp() public {
        assertEq(block.chainid, 4663);
        assertEq(block.number, 53176414);
        assertEq(block.timestamp, 1788413867);
        feed = new DockyardApi3ManagedUsdgFeed(
            0xEa5f320Ee0ef7E81AFAf2a9b4FBc1a7d093287fe,
            0x27204d8c31a1fcbdf7747d795776d8a60c6d10bf2bf7c94739cd9190a5e16238,
            3600
        );
    }

    function testMatchesOfficialReaderAfterPurchase() public view {
        (int224 expected, uint32 timestamp) = IManagedApi3Reader(0xCCd6CF334E7eA7DeE4c0c61bffd7410C1F82CEa1).read();
        (, int256 answer,, uint256 updated,) = feed.latestRoundData();
        assertEq(answer, expected);
        assertEq(answer, 1000002185409070000);
        assertEq(updated, timestamp);
        assertEq(updated, 1788413666);
    }

    function testPaidFeedStillExpiresUnderDockyardPolicy() public {
        vm.warp(1788413666 + 3599);
        feed.latestRoundData();
        vm.warp(1788413666 + 3600);
        vm.expectRevert(DockyardApi3ManagedUsdgFeed.Unavailable.selector);
        feed.latestRoundData();
    }
}
