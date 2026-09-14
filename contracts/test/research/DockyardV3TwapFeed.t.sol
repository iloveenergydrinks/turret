// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardMockERC20} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardV3TwapFeed} from "src/research/DockyardV3TwapFeed.sol";
import {IsolatedTickMath} from "src/research/IsolatedTickMath.sol";

contract IsolatedMockV3Factory {
    mapping(bytes32 => address) private pools;

    function register(address a, address b, address pool) external {
        pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a))] = pool;
    }

    function getPool(address a, address b, uint24) external view returns (address) {
        return pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a))];
    }
}

contract IsolatedMockV3Pool {
    address public token0;
    address public token1;
    address public factory;
    uint24 public constant fee = 10000;
    uint128 public liquidity = 1e18;
    int24 public spot;
    int56 public delta;
    uint160 public liquidityDelta = uint160(uint256(1800) * (1 << 128) / 1e18);
    uint32 public timestamp;
    uint16 public cardinality = 2;
    bool public unlocked = true;
    bool public initialized = true;
    bool public broken;
    bool public malformed;
    bool public wrap;

    constructor(address a, address b, address f) {
        token0 = a < b ? a : b;
        token1 = a < b ? b : a;
        factory = f;
        timestamp = uint32(block.timestamp);
    }

    function setPrice(int24 s, int56 d) external {
        spot = s;
        delta = d;
    }

    function setLiquidity(uint128 l, uint160 d) external {
        liquidity = l;
        liquidityDelta = d;
    }

    function setState(uint32 t, uint16 c, bool u, bool i) external {
        timestamp = t;
        cardinality = c;
        unlocked = u;
        initialized = i;
    }

    function setResponse(bool b, bool m, bool w) external {
        broken = b;
        malformed = m;
        wrap = w;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (1 << 96, spot, 0, cardinality, cardinality, 0, unlocked);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (timestamp, 0, 0, initialized);
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory t, uint160[] memory l) {
        require(!broken, "OLD");
        require(ago.length == 2 && ago[0] == 1800 && ago[1] == 0, "wrong window");
        t = new int56[](malformed ? 1 : 2);
        l = new uint160[](2);
        if (malformed) return (t, l);
        if (wrap) {
            t[0] = type(int56).max - 1;
            l[0] = type(uint160).max - 1;
        }
        unchecked {
            t[1] = t[0] + delta;
            l[1] = l[0] + liquidityDelta;
        }
    }
}

contract DockyardV3TwapFeedTest is Test {
    DockyardMockERC20 token;
    DockyardMockERC20 middle;
    DockyardMockERC20 cash;
    IsolatedMockV3Factory factory;
    IsolatedMockV3Pool first;
    IsolatedMockV3Pool second;
    DockyardV3TwapFeed feed;

    function setUp() public {
        vm.warp(1000000);
        token = new DockyardMockERC20("Token", "T", 18);
        middle = new DockyardMockERC20("WETH", "WETH", 18);
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        factory = new IsolatedMockV3Factory();
        first = new IsolatedMockV3Pool(address(token), address(middle), address(factory));
        second = new IsolatedMockV3Pool(address(middle), address(cash), address(factory));
        factory.register(address(token), address(middle), address(first));
        factory.register(address(middle), address(cash), address(second));
        feed = new DockyardV3TwapFeed(config());
    }

    function config() internal view returns (DockyardV3TwapFeed.Config memory) {
        return DockyardV3TwapFeed.Config({
            collateral: address(token),
            intermediate: address(middle),
            usdg: address(cash),
            factory: address(factory),
            firstPool: address(first),
            secondPool: address(second),
            window: 1800,
            maxObservationAge: 300,
            maxSpotTickDeviation: 200,
            firstMinLiquidity: 1e15,
            secondMinLiquidity: 1e15
        });
    }

    function value() internal view returns (uint256) {
        (, int256 answer,,,) = feed.latestRoundData();
        return uint256(answer);
    }

    function setDirected(IsolatedMockV3Pool p, address base, int24 tick) internal {
        int24 canonical = p.token0() == base ? tick : -tick;
        p.setPrice(canonical, int56(canonical) * 1800);
    }

    function testUnitRatiosRespectDecimalsAndOldestWrite() public {
        second.setState(uint32(block.timestamp - 42), 2, true, true);
        (uint80 round, int256 answer, uint256 started, uint256 updated, uint80 answered) = feed.latestRoundData();
        assertEq(answer, 1e30);
        assertEq(feed.decimals(), 18);
        assertEq(updated, block.timestamp - 42);
        assertEq(round, updated);
        assertEq(answered, round);
        assertEq(started, updated);
    }

    function testBothTokenOrdersComposeAndCancel() public {
        setDirected(first, address(token), -120000);
        setDirected(second, address(middle), 120000);
        assertEq(value(), 1e30);
        setDirected(second, address(middle), 120001);
        assertApproxEqAbs(value(), 10001e26, 100);
    }

    function testSubMicroUsdgPriceDoesNotRoundToZero() public {
        setDirected(first, address(token), -250000);
        setDirected(second, address(middle), -200000);
        assertGt(value(), 0);
        assertLt(value(), 1e12);
    }

    function testFloorRoundingInEitherQuoteDirection() public {
        // Fractional -1/1800 directed tick must floor to -1, never round toward zero.
        int56 sign = first.token0() == address(token) ? int56(-1) : int56(1);
        first.setPrice(0, sign);
        uint256 lower = value();
        setDirected(first, address(token), -1);
        assertEq(value(), lower);
        assertLt(lower, 1e30);
    }

    function testAccumulatorWrapMatchesOrdinaryObservation() public {
        setDirected(first, address(token), 100);
        uint256 beforeWrap = value();
        first.setResponse(false, false, true);
        assertEq(value(), beforeWrap);
    }

    function testReversedFirstHopFloorsFractionalQuote() public {
        IsolatedMockV3Pool other = new IsolatedMockV3Pool(address(token), address(cash), address(factory));
        factory.register(address(token), address(cash), address(other));
        DockyardV3TwapFeed.Config memory c = config();
        c.collateral = address(middle);
        c.intermediate = address(token);
        c.secondPool = address(other);
        feed = new DockyardV3TwapFeed(c);
        int56 sign = first.token0() == address(middle) ? int56(-1) : int56(1);
        first.setPrice(0, sign);
        uint256 fractional = value();
        setDirected(first, address(middle), -1);
        assertEq(value(), fractional);
        assertLt(fractional, 1e30);
        first.setPrice(0, -sign);
        assertEq(value(), 1e30);
    }

    function testOldObservationsCannotAppearFreshByReading() public {
        vm.warp(block.timestamp + 301);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testFutureUninitializedAndInsufficientObservationsRejected() public {
        first.setState(uint32(block.timestamp + 1), 2, true, true);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
        first.setState(uint32(block.timestamp), 2, true, false);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
        first.setState(uint32(block.timestamp), 1, true, true);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testPoolCallbackLockedStateRejected() public {
        second.setState(uint32(block.timestamp), 2, false, true);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testMissingOrMalformedWindowFailsClosed() public {
        first.setResponse(true, false, false);
        vm.expectRevert(bytes("OLD"));
        feed.latestRoundData();
        first.setResponse(false, true, false);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testLowCurrentOrHistoricalLiquidityRejected() public {
        first.setLiquidity(1, first.liquidityDelta());
        vm.expectRevert(DockyardV3TwapFeed.ThinLiquidity.selector);
        feed.latestRoundData();
        first.setLiquidity(1e18, uint160(uint256(1800) * (1 << 128) / 1e12));
        vm.expectRevert(DockyardV3TwapFeed.ThinLiquidity.selector);
        feed.latestRoundData();
        first.setLiquidity(1e18, 0);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testSpotJumpDoesNotChangeTwapAndLargeJumpBlocksRead() public {
        uint256 beforeJump = value();
        first.setPrice(200, 0);
        assertEq(value(), beforeJump);
        first.setPrice(201, 0);
        vm.expectRevert(DockyardV3TwapFeed.SpotDeviation.selector);
        feed.latestRoundData();
        first.setPrice(-201, 0);
        vm.expectRevert(DockyardV3TwapFeed.SpotDeviation.selector);
        feed.latestRoundData();
    }

    function testFactoryMismatchAndInvalidParametersRejected() public {
        DockyardV3TwapFeed.Config memory c = config();
        c.window = 0;
        vm.expectRevert(DockyardV3TwapFeed.InvalidConfiguration.selector);
        new DockyardV3TwapFeed(c);
        c = config();
        c.firstPool = address(second);
        vm.expectRevert(DockyardV3TwapFeed.InvalidConfiguration.selector);
        new DockyardV3TwapFeed(c);
        c = config();
        factory.register(address(token), address(middle), address(0));
        vm.expectRevert(DockyardV3TwapFeed.InvalidConfiguration.selector);
        new DockyardV3TwapFeed(c);
    }

    function testChangedPoolCodeRejected() public {
        vm.etch(address(first), hex"00");
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function testTickMathKnownBoundaries() public pure {
        assertEq(IsolatedTickMath.getSqrtRatioAtTick(0), 1 << 96);
        assertEq(IsolatedTickMath.getSqrtRatioAtTick(-887272), 4295128739);
        assertEq(IsolatedTickMath.getSqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342);
        assertEq(IsolatedTickMath.getSqrtRatioAtTick(1), 79232123823359799118286999568);
        assertEq(IsolatedTickMath.getSqrtRatioAtTick(-1), 79224201403219477170569942574);
    }

    function testFuzzPriceMonotonicity(int24 tick_) public {
        int24 t = int24(bound(int256(tick_), -500000, 500000));
        setDirected(first, address(token), t);
        uint256 before = value();
        setDirected(first, address(token), t + 1);
        assertGt(value(), before);
    }
}
