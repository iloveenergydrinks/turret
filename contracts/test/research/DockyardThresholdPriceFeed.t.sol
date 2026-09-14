// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardThresholdPriceFeed} from "src/research/DockyardThresholdPriceFeed.sol";

contract DockyardThresholdPriceFeedTest is Test {
    uint256 private constant KEY_A = 101;
    uint256 private constant KEY_B = 202;
    uint256 private constant KEY_C = 303;
    uint256 private constant KEY_D = 404;
    uint256 private constant BAD_KEY = 505;
    address private constant ASSET = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address private constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint32 private constant GATE = 1 << 0;
    uint32 private constant MEXC = 1 << 1;
    uint32 private constant THIRD_VENUE = 1 << 2;
    uint32 private constant SOURCES = GATE | MEXC | THIRD_VENUE;
    uint64 private constant EPOCH = 1;
    bytes32 private constant POLICY = keccak256("pons-usdg-index-v1");

    DockyardThresholdPriceFeed private feed;
    uint256[] private orderedKeys;

    function setUp() public {
        vm.warp(2_000_000);
        orderedKeys = _sortedKeys();
        feed = _deploy();
    }

    function _sortedKeys() private view returns (uint256[] memory keys) {
        keys = new uint256[](4);
        keys[0] = KEY_A;
        keys[1] = KEY_B;
        keys[2] = KEY_C;
        keys[3] = KEY_D;
        for (uint256 i; i < keys.length; ++i) {
            for (uint256 j = i + 1; j < keys.length; ++j) {
                if (uint160(vm.addr(keys[j])) < uint160(vm.addr(keys[i]))) (keys[i], keys[j]) = (keys[j], keys[i]);
            }
        }
    }

    function _reporters() private view returns (address[] memory reporters) {
        reporters = new address[](orderedKeys.length);
        for (uint256 i; i < reporters.length; ++i) {
            reporters[i] = vm.addr(orderedKeys[i]);
        }
    }

    function _deploy() private returns (DockyardThresholdPriceFeed) {
        return new DockyardThresholdPriceFeed(ASSET, USDG, _reporters(), 3, 30, SOURCES, EPOCH, POLICY);
    }

    function _report(uint64 sequence) private view returns (DockyardThresholdPriceFeed.PriceReport memory) {
        return DockyardThresholdPriceFeed.PriceReport({
            asset: ASSET,
            quote: USDG,
            sequence: sequence,
            reporterSetEpoch: EPOCH,
            observedAt: uint64(block.timestamp),
            signedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 29),
            price: 758_000_000_000_000_000,
            sourceMask: SOURCES,
            policyHash: POLICY,
            observationsHash: keccak256("canonical venue observations and USDG conversion")
        });
    }

    function _signature(
        DockyardThresholdPriceFeed target,
        DockyardThresholdPriceFeed.PriceReport memory report,
        uint256 key
    ) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.reportDigest(report));
        return abi.encodePacked(r, s, v);
    }

    function _signatures(DockyardThresholdPriceFeed.PriceReport memory report)
        private
        returns (bytes[] memory signatures)
    {
        signatures = new bytes[](3);
        for (uint256 i; i < signatures.length; ++i) {
            signatures[i] = _signature(feed, report, orderedKeys[i]);
        }
    }

    function _expectInvalidReport(DockyardThresholdPriceFeed.PriceReport memory report) private {
        bytes[] memory signatures = _signatures(report);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidReport.selector);
        feed.submit(report, signatures);
    }

    function testPermissionlessSubmissionAndAggregatorRead() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        vm.prank(address(0xBEEF));
        feed.submit(report, _signatures(report));

        (uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(round, 1);
        assertEq(answer, int256(uint256(report.price)));
        assertEq(started, report.observedAt);
        assertEq(updated, report.observedAt);
        assertEq(answered, round);
        (,,,,,,,,,, bytes32 observationsHash) = feed.latestReport();
        assertEq(observationsHash, report.observationsHash);
    }

    function testHonestOverlapThresholdAndUniqueAuthorizedSignersRequired() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        bytes[] memory signatures = new bytes[](2);
        signatures[0] = _signature(feed, report, orderedKeys[0]);
        signatures[1] = _signature(feed, report, orderedKeys[1]);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidSignatures.selector);
        feed.submit(report, signatures);

        signatures = new bytes[](3);
        signatures[0] = _signature(feed, report, orderedKeys[0]);
        signatures[1] = signatures[0];
        signatures[2] = _signature(feed, report, orderedKeys[2]);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidSignatures.selector);
        feed.submit(report, signatures);

        signatures[1] = _signature(feed, report, orderedKeys[1]);
        signatures[2] = _signature(feed, report, BAD_KEY);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidSignatures.selector);
        feed.submit(report, signatures);
    }

    function testSignaturesMustBeCanonicallyOrdered() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        bytes[] memory signatures = _signatures(report);
        (signatures[0], signatures[1]) = (signatures[1], signatures[0]);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidSignatures.selector);
        feed.submit(report, signatures);
    }

    function testSignaturesAreBoundToChainAndContract() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        DockyardThresholdPriceFeed other = _deploy();
        bytes[] memory signatures = _signatures(report);
        vm.expectRevert();
        other.submit(report, signatures);

        signatures = _signatures(report);
        uint256 oldChain = block.chainid;
        vm.chainId(oldChain + 1);
        vm.expectRevert();
        feed.submit(report, signatures);
    }

    function testIdentityPolicyAndReporterEpochAreBound() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        report.asset = address(0xCAFE);
        _expectInvalidReport(report);
        report = _report(1);
        report.quote = address(0xCAFE);
        _expectInvalidReport(report);
        report = _report(1);
        report.policyHash = bytes32(uint256(1));
        _expectInvalidReport(report);
        report = _report(1);
        report.reporterSetEpoch++;
        _expectInvalidReport(report);
    }

    function testStaleFutureIncompleteAndEmptyReportsRejected() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        report.observedAt -= 30;
        _expectInvalidReport(report);
        report = _report(1);
        report.signedAt += 1;
        _expectInvalidReport(report);
        report = _report(1);
        report.validUntil = uint64(block.timestamp + 31);
        _expectInvalidReport(report);
        report = _report(1);
        report.sourceMask = GATE | MEXC;
        _expectInvalidReport(report);
        report = _report(1);
        report.price = 0;
        _expectInvalidReport(report);
        report = _report(1);
        report.observationsHash = bytes32(0);
        _expectInvalidReport(report);
    }

    function testSequenceCannotReplayOrRollBack() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(2);
        feed.submit(report, _signatures(report));
        bytes[] memory signatures = _signatures(report);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidReport.selector);
        feed.submit(report, signatures);
        report = _report(1);
        signatures = _signatures(report);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidReport.selector);
        feed.submit(report, signatures);
    }

    function testHigherSequenceCannotReplaceNewerObservation() public {
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        feed.submit(report, _signatures(report));
        vm.warp(block.timestamp + 1);
        report = _report(2);
        report.observedAt--;
        _expectInvalidReport(report);
    }

    function testReadFailsClosedWhenMissingStaleOrExpired() public {
        vm.expectRevert(DockyardThresholdPriceFeed.Unavailable.selector);
        feed.latestRoundData();
        DockyardThresholdPriceFeed.PriceReport memory report = _report(1);
        feed.submit(report, _signatures(report));
        vm.warp(block.timestamp + 28);
        feed.latestRoundData();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardThresholdPriceFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testInvalidConfigurationRejected() public {
        address[] memory reporters = _reporters();
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidConfiguration.selector);
        new DockyardThresholdPriceFeed(ASSET, USDG, reporters, 2, 30, SOURCES, EPOCH, POLICY);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidConfiguration.selector);
        new DockyardThresholdPriceFeed(ASSET, USDG, reporters, 3, 61, SOURCES, EPOCH, POLICY);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidConfiguration.selector);
        new DockyardThresholdPriceFeed(ASSET, USDG, reporters, 3, 30, GATE | MEXC, EPOCH, POLICY);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidConfiguration.selector);
        new DockyardThresholdPriceFeed(ASSET, USDG, reporters, 3, 30, SOURCES, 0, POLICY);
        (reporters[0], reporters[1]) = (reporters[1], reporters[0]);
        vm.expectRevert(DockyardThresholdPriceFeed.InvalidConfiguration.selector);
        new DockyardThresholdPriceFeed(ASSET, USDG, reporters, 3, 30, SOURCES, EPOCH, POLICY);
    }
}
