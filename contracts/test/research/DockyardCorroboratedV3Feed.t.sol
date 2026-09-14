// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {DockyardMockERC20, DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {IsolatedMockV3Factory, IsolatedMockV3Pool} from "./DockyardV3TwapFeed.t.sol";
import {DockyardV3TwapFeed} from "src/research/DockyardV3TwapFeed.sol";
import {DockyardCorroboratedV3Feed, ICorroboratingFeed} from "src/research/DockyardCorroboratedV3Feed.sol";

contract DockyardCorroboratedV3FeedTest is Test {
    DockyardV3TwapFeed dex;
    DockyardCorroboratedV3Feed policy;
    DockyardMockOracle referenceOracle;
    IsolatedMockV3Pool first;
    IsolatedMockV3Pool second;
    address token;

    function setUp() public {
        vm.warp(1000000);
        token = address(new DockyardMockERC20("Token", "T", 18));
        address middle = address(new DockyardMockERC20("WETH", "W", 18));
        address cash = address(new DockyardMockERC20("USDG", "U", 6));
        IsolatedMockV3Factory factory = new IsolatedMockV3Factory();
        first = new IsolatedMockV3Pool(token, middle, address(factory));
        second = new IsolatedMockV3Pool(middle, cash, address(factory));
        factory.register(token, middle, address(first));
        factory.register(middle, cash, address(second));
        dex = new DockyardV3TwapFeed(
            DockyardV3TwapFeed.Config(
                token, middle, cash, address(factory), address(first), address(second), 1800, 300, 200, 1e15, 1e15
            )
        );
        referenceOracle = new DockyardMockOracle(18, 1e30);
        policy = new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(referenceOracle)), 60, 500);
    }

    function shock(int24 directedTick) internal returns (uint256 spot) {
        first.setPrice(first.token0() == token ? directedTick : -directedTick, 0);
        (, spot,,) = dex.guardedQuotes();
    }

    function testNormalModeUsesConservativePriceAndOldestTimestamp() public {
        referenceOracle.setAnswer(99e28);
        second.setState(uint32(block.timestamp - 42), 2, true, true);
        (uint256 value, uint256 updated, bool gap) = policy.quote();
        assertEq(value, 99e28);
        assertEq(updated, block.timestamp - 42);
        assertFalse(gap);
        (uint80 round, int256 answer, uint256 started, uint256 time, uint80 answered) = policy.latestRoundData();
        assertEq(answer, int256(value));
        assertEq(round, updated);
        assertEq(started, time);
        assertEq(answered, round);
    }

    function testCorroboratedDownwardGapDoesNotWaitForAverage() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot));
        vm.expectRevert(DockyardV3TwapFeed.SpotDeviation.selector);
        dex.latestRoundData();
        (uint256 value,, bool gap) = policy.quote();
        assertTrue(gap);
        assertEq(value, spot);
    }

    function testDexOnlyCrashCannotTriggerGapMode() public {
        shock(-7000);
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        policy.quote();
    }

    function testReferenceOnlyCrashCannotTriggerGapMode() public {
        referenceOracle.setAnswer(5e29);
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        policy.quote();
    }

    function testUpwardGapCannotUseFastPathEvenWhenBothAgree() public {
        uint256 spot = shock(7000);
        referenceOracle.setAnswer(int256(spot));
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        policy.quote();
    }

    function testDexDiscountDoesNotDiscountReferenceInGapMode() public {
        uint256 spot = shock(-7000);
        uint256 independent = spot * 101 / 100;
        referenceOracle.setAnswer(int256(independent));
        (uint256 value,, bool gap) = policy.quote();
        assertTrue(gap);
        assertEq(value, independent);
        assertGt(value, spot);
    }

    function testReferenceDivergenceBeyondLimitRejected() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot * 105 / 100 + 1));
        vm.expectRevert(DockyardCorroboratedV3Feed.Uncorroborated.selector);
        policy.quote();
    }

    function testReferenceFreshnessBoundaryAndFutureTimestamp() public {
        vm.warp(block.timestamp + 60);
        policy.quote();
        vm.warp(block.timestamp + 1);
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        policy.quote();
        referenceOracle.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        policy.quote();
    }

    function testNoFallbackToDexWhenReferenceFails() public {
        referenceOracle.setShouldRevert(true);
        vm.expectRevert(bytes("oracle unavailable"));
        policy.quote();
    }

    function testBadReferenceRoundsAndPricesRejected() public {
        for (uint256 i; i < 4; ++i) {
            vm.mockCall(
                address(referenceOracle),
                abi.encodeWithSelector(referenceOracle.latestRoundData.selector),
                abi.encode(
                    i == 0 ? uint80(0) : uint80(2),
                    i == 1 ? int256(0) : int256(1e30),
                    block.timestamp,
                    i == 2 ? 0 : block.timestamp,
                    i == 3 ? uint80(1) : uint80(2)
                )
            );
            vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
            policy.quote();
            vm.clearMockedCalls();
        }
    }

    function testReferenceDecimalNormalization() public {
        DockyardMockOracle eight = new DockyardMockOracle(8, 1e20);
        policy = new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(eight)), 60, 500);
        (uint256 value,,) = policy.quote();
        assertEq(value, 1e30);
        vm.mockCall(address(eight), abi.encodeWithSelector(eight.decimals.selector), abi.encode(uint8(9)));
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        policy.quote();
    }

    function testPoolHistoryStillRequiredInGapMode() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot));
        first.setResponse(true, false, false);
        vm.expectRevert(bytes("OLD"));
        policy.quote();
    }

    function testStaleDexCannotBeRefreshedByReference() public {
        vm.warp(block.timestamp + 301);
        referenceOracle.setAnswer(1e30);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        policy.quote();
    }

    function testLiquidityFloorsStillApplyInGapMode() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot));
        first.setLiquidity(1, first.liquidityDelta());
        vm.expectRevert(DockyardV3TwapFeed.ThinLiquidity.selector);
        policy.quote();
        first.setLiquidity(1e18, uint160(uint256(1800) * (1 << 128) / 1e12));
        vm.expectRevert(DockyardV3TwapFeed.ThinLiquidity.selector);
        policy.quote();
    }

    function testLockedPoolStillRejected() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot));
        second.setState(uint32(block.timestamp), 2, false, true);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        policy.quote();
    }

    function testAllRuntimePinsRequired() public {
        uint256 snapshot = vm.snapshotState();
        vm.etch(address(dex), hex"00");
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        policy.quote();
        assertTrue(vm.revertToState(snapshot));
        snapshot = vm.snapshotState();
        vm.etch(address(referenceOracle), hex"00");
        vm.expectRevert(DockyardCorroboratedV3Feed.Unavailable.selector);
        policy.quote();
        assertTrue(vm.revertToState(snapshot));
        vm.etch(address(first), hex"00");
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        policy.quote();
    }

    function testReturnsToAverageModeOnceHistoryCatchesUp() public {
        uint256 spot = shock(-7000);
        referenceOracle.setAnswer(int256(spot));
        (,, bool gap) = policy.quote();
        assertTrue(gap);
        int24 tick = first.spot();
        first.setPrice(tick, int56(tick) * 1800);
        (uint256 value,, bool recovered) = policy.quote();
        assertFalse(recovered);
        assertEq(value, spot);
    }

    function testConfigurationLimits() public {
        vm.expectRevert(DockyardCorroboratedV3Feed.InvalidConfiguration.selector);
        new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(referenceOracle)), 61, 500);
        vm.expectRevert(DockyardCorroboratedV3Feed.InvalidConfiguration.selector);
        new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(referenceOracle)), 60, 501);
        vm.expectRevert(DockyardCorroboratedV3Feed.InvalidConfiguration.selector);
        new DockyardCorroboratedV3Feed(dex, ICorroboratingFeed(address(dex)), 60, 500);
    }

    function testFuzzGapPriceAlwaysEqualsReference(uint24 drop, uint16 spread) public {
        uint256 spot = shock(-int24(uint24(bound(drop, 1000, 12000))));
        uint256 independent = spot * (10000 + bound(spread, 0, 499)) / 10000;
        referenceOracle.setAnswer(int256(independent));
        (uint256 value,, bool gap) = policy.quote();
        assertTrue(gap);
        assertEq(value, independent);
    }
}
