// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardMockERC20, DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {SignedPythFixture} from "../oracles/DockyardOracleV2.t.sol";
import {DockyardPythVerifier} from "src/Oracles/DockyardPythVerifier.sol";
import {DockyardPythUsdRatioFeed} from "src/research/DockyardPythUsdRatioFeed.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";

contract DockyardPythUsdRatioFeedTest is Test {
    uint256 constant KEY = 923456; // Local test signer, never a production oracle.
    uint32 constant TOKEN_FEED = 3441;
    uint32 constant USDG_FEED = 232;
    DockyardPythVerifier hub;
    SignedPythFixture verifier;
    DockyardPythUsdRatioFeed feed;
    DockyardMockERC20 token;
    DockyardMockERC20 cash;
    DockyardPythVerifier.Report a;
    DockyardPythVerifier.Report b;

    function setUp() public {
        vm.warp(1000000);
        vm.deal(address(this), 1 ether);
        token = new DockyardMockERC20("Collateral", "COLL", 18);
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        verifier = new SignedPythFixture(vm.addr(KEY));
        hub = new DockyardPythVerifier(address(verifier));
        feed = new DockyardPythUsdRatioFeed(config());
        a = DockyardPythVerifier.Report(
            uint64(block.timestamp * 1e6), uint64(block.timestamp * 1e6), 25e6, 1000, 2, -8, 0
        );
        b = DockyardPythVerifier.Report(
            uint64(block.timestamp * 1e6), uint64(block.timestamp * 1e6), 100e6, 1000, 3, -8, 0
        );
    }

    function config() internal view returns (DockyardPythUsdRatioFeed.Config memory) {
        return
            DockyardPythUsdRatioFeed.Config(
                address(hub), address(token), address(cash), TOKEN_FEED, USDG_FEED, 60, 10, 100, 2, 3
            );
    }

    function _part(uint32 id, DockyardPythVerifier.Report memory r) internal pure returns (bytes memory) {
        return bytes.concat(
            abi.encodePacked(id, uint8(6), uint8(0), r.price, uint8(3), r.publishers, uint8(4), r.exponent),
            abi.encodePacked(uint8(5), r.confidence, uint8(9), r.session, uint8(12), uint8(1), r.feedUpdateTimestampUs)
        );
    }

    function _signed(bytes memory payload) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, keccak256(payload));
        return abi.encodePacked(uint32(706910618), r, s, v - 27, uint16(payload.length), payload);
    }

    function _publish() internal {
        hub.update{value: 1}(
            _signed(
                bytes.concat(
                    abi.encodePacked(uint32(2479346549), uint64(block.timestamp * 1e6), uint8(4), uint8(2)),
                    _part(TOKEN_FEED, a),
                    _part(USDG_FEED, b)
                )
            )
        );
    }

    function _price() internal view returns (uint256) {
        (, int256 value,,,) = feed.latestRoundData();
        return uint256(value);
    }

    function _unavailable() internal {
        vm.expectRevert(DockyardPythUsdRatioFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testAuthenticatedRatioUsesConfidenceAndOldestSourceTime() public {
        b.feedUpdateTimestampUs -= 2000001;
        _publish();
        (uint80 round, int256 value,, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(uint256(value), (uint256(25e6) - 1000) * 1e18 / (100e6 + 1000));
        assertEq(updated, block.timestamp - 3);
        assertEq(round, b.feedUpdateTimestampUs);
        assertEq(answered, round);
    }

    function testUsdGPriceIsNotAssumedOneDollar() public {
        _publish();
        uint256 normal = _price();
        vm.warp(block.timestamp + 1);
        a.feedUpdateTimestampUs += 1e6;
        b.feedUpdateTimestampUs += 1e6;
        b.price = 80e6;
        _publish();
        assertGt(_price(), normal);
    }

    function testDifferentExponentsAndSubMicroTokenPricesKeepPrecision() public {
        a.price = 25;
        a.exponent = -9;
        a.confidence = 0;
        b.price = 1000000;
        b.exponent = -6;
        b.confidence = 0;
        _publish();
        assertEq(_price(), 25e9);
    }

    function testMissingReportsAreUnavailable() public {
        _unavailable();
    }

    function testStaleEnvelopeCannotBeUsed() public {
        _publish();
        vm.warp(block.timestamp + 30);
        _unavailable();
    }

    function testFreshEnvelopeDoesNotRefreshOldUnderlyingPrice() public {
        a.feedUpdateTimestampUs -= 60e6;
        b.feedUpdateTimestampUs -= 60e6;
        _publish();
        _unavailable();
    }

    function testUnderlyingPairSkewIsRejected() public {
        a.feedUpdateTimestampUs -= 11e6;
        _publish();
        _unavailable();
    }

    function testEnvelopePairSkewIsRejectedEvenWithMatchingSourceTimes() public {
        _publish();
        vm.warp(block.timestamp + 11);
        hub.update{value: 1}(
            _signed(
                bytes.concat(
                    abi.encodePacked(uint32(2479346549), uint64(block.timestamp * 1e6), uint8(4), uint8(1)),
                    _part(USDG_FEED, b)
                )
            )
        );
        _unavailable();
    }

    function testInsufficientCollateralPublishersRejected() public {
        a.publishers = 1;
        _publish();
        _unavailable();
    }

    function testInsufficientUsdGPublishersRejected() public {
        b.publishers = 2;
        _publish();
        _unavailable();
    }

    function testHighConfidenceIntervalRejected() public {
        a.confidence = 250001;
        _publish();
        _unavailable();
    }

    function testZeroOrNegativePriceRejected() public {
        a.price = 0;
        _publish();
        _unavailable();
        vm.warp(block.timestamp + 1);
        a.price = -1;
        _publish();
        _unavailable();
    }

    function testUnsupportedExponentRejected() public {
        a.exponent = -19;
        _publish();
        _unavailable();
    }

    function testClosedCryptoSessionInvalidatesOldGoodPrice() public {
        _publish();
        assertGt(_price(), 0);
        vm.warp(block.timestamp + 1);
        a.session = 4;
        _publish();
        _unavailable();
    }

    function testChangedHubOrVerifierCodeRejected() public {
        _publish();
        vm.etch(address(hub), hex"00");
        _unavailable();
    }

    function testChangedUpstreamVerifierCodeRejected() public {
        _publish();
        vm.etch(address(verifier), hex"00");
        _unavailable();
    }

    function testTamperedReportCannotEnterHub() public {
        bytes memory payload = bytes.concat(
            abi.encodePacked(uint32(2479346549), uint64(block.timestamp * 1e6), uint8(4), uint8(2)),
            _part(TOKEN_FEED, a),
            _part(USDG_FEED, b)
        );
        bytes memory signed = _signed(payload);
        signed[signed.length - 1] = bytes1(uint8(signed[signed.length - 1]) ^ 1);
        vm.expectRevert();
        hub.update{value: 1}(signed);
        _unavailable();
    }

    function testInvalidConfigurationRejected() public {
        DockyardPythUsdRatioFeed.Config memory c = config();
        c.collateralFeedId = c.usdgFeedId;
        vm.expectRevert(DockyardPythUsdRatioFeed.InvalidConfiguration.selector);
        new DockyardPythUsdRatioFeed(c);
        c = config();
        c.maxPriceAge = 61;
        vm.expectRevert(DockyardPythUsdRatioFeed.InvalidConfiguration.selector);
        new DockyardPythUsdRatioFeed(c);
        c = config();
        c.usdgMinPublishers = 1;
        vm.expectRevert(DockyardPythUsdRatioFeed.InvalidConfiguration.selector);
        new DockyardPythUsdRatioFeed(c);
    }

    function testFuzzConservativeRatioRoundsDown(uint64 tokenPrice, uint64 cashPrice, uint16 uncertainty) public {
        tokenPrice = uint64(bound(tokenPrice, 10000, 1e14));
        cashPrice = uint64(bound(cashPrice, 10000, 1e14));
        uncertainty = uint16(bound(uncertainty, 0, 100));
        a.price = int64(tokenPrice);
        b.price = int64(cashPrice);
        a.confidence = uint64(uint256(tokenPrice) * uncertainty / 10000);
        b.confidence = uint64(uint256(cashPrice) * uncertainty / 10000);
        _publish();
        assertEq(_price(), (uint256(tokenPrice) - a.confidence) * 1e18 / (uint256(cashPrice) + b.confidence));
        assertLe(_price(), uint256(tokenPrice) * 1e18 / cashPrice);
    }

    function testRatioFeedsActualIsolatedBorrowAndLiquidationAccounting() public {
        _publish();
        DockyardMockOracle other = new DockyardMockOracle(18, 25e16);
        DockyardIsolatedCreditEngine engine = new DockyardIsolatedCreditEngine(
            DockyardIsolatedCreditEngine.Config({
                usdg: address(cash),
                collateral: address(token),
                primary: address(other),
                secondary: address(feed),
                guardian: address(this),
                staleness: 60,
                maxLtvBps: 5000,
                liquidationLtvBps: 6500,
                bonusBps: 500,
                deviationBps: 500,
                minimumDebt: 1e6
            })
        );
        DockyardIsolatedCapitalPool pool =
            new DockyardIsolatedCapitalPool(cash, address(token), address(engine), address(this), 1000e6, 1000, 1000);
        engine.bindPool(pool);
        engine.setRiskPaused(false);
        cash.mint(address(this), 2000e6);
        cash.approve(address(pool), 1000e6);
        pool.deposit(1000e6, address(this));
        token.mint(address(this), 1000e18);
        token.approve(address(engine), 1000e18);
        engine.depositAndBorrow(1000e18, 100e6);
        assertEq(engine.positionDebt(address(this)), 100e6);
        vm.warp(block.timestamp + 1);
        a.price = 12e6;
        a.feedUpdateTimestampUs += 1e6;
        b.feedUpdateTimestampUs += 1e6;
        _publish();
        other.setAnswer(12e16);
        assertFalse(pool.capitalOperationsAllowed());
        (uint256 repaid, uint256 seized) = engine.liquidationQuote(address(this), 200e6);
        cash.approve(address(engine), repaid);
        engine.liquidate(address(this), repaid, seized);
        assertEq(engine.positionDebt(address(this)), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.cumulativeLoss(), 0);
        assertTrue(pool.capitalOperationsAllowed());
    }
}
