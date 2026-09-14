// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardV3TwapFeed, IIsolatedV3Pool} from "src/research/DockyardV3TwapFeed.sol";

interface ITwapForkWeth {
    function deposit() external payable;
}

interface ITwapForkSwap {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

contract DockyardV3TwapForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
    address constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address constant CASHCAT_POOL = 0xA70fc67C9F69da90B63a0e4C05D229954574E313;
    address constant PONS_POOL = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA;
    address constant USDG_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address private expectedPool;
    uint256 private budget;

    function setUp() public {
        string memory rpc = vm.envOr("ISOLATED_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true, "Explicit RPC and pinned block required");
        uint256 pinned = vm.envOr("ISOLATED_FORK_BLOCK", uint256(0));
        require(pinned != 0, "Pinned fork block required");
        vm.createSelectFork(rpc, pinned);
        assertEq(block.chainid, 4663);
    }

    function feedFor(address token, address venue) private returns (DockyardV3TwapFeed) {
        // Exploratory test settings, NOT approved production liquidity floors or timing.
        return new DockyardV3TwapFeed(
            DockyardV3TwapFeed.Config({
                collateral: token,
                intermediate: WETH,
                usdg: USDG,
                factory: FACTORY,
                firstPool: venue,
                secondPool: USDG_POOL,
                window: 1800,
                maxObservationAge: 600,
                maxSpotTickDeviation: 200,
                firstMinLiquidity: 1e18,
                secondMinLiquidity: 1e15
            })
        );
    }

    function testCashcatActualHistoryAndStaleRejection() public {
        checkRead(CASHCAT, CASHCAT_POOL);
    }

    function testPonsActualHistoryAndStaleRejection() public {
        checkRead(PONS, PONS_POOL);
    }

    function testCashcatActualSwapTripsSpotCircuit() public {
        checkSwap(CASHCAT, CASHCAT_POOL);
    }

    function testPonsActualSwapTripsSpotCircuit() public {
        checkSwap(PONS, PONS_POOL);
    }

    function testCashcatHeldPriceCanEnterTwapWithoutIndependentSource() public {
        checkHeldPrice(CASHCAT, CASHCAT_POOL);
    }

    function testPonsHeldPriceCanEnterTwapWithoutIndependentSource() public {
        checkHeldPrice(PONS, PONS_POOL);
    }

    function checkRead(address token, address venue) private {
        DockyardV3TwapFeed feed = feedFor(token, venue);
        (, int256 value,, uint256 updated,) = feed.latestRoundData();
        assertGt(value, 0);
        assertLe(updated, block.timestamp);
        emit log_named_int("TWAP USDG per token (18 decimals)", value);
        emit log_named_uint("oldest observation age seconds", block.timestamp - updated);
        vm.warp(block.timestamp + 601);
        vm.expectRevert(DockyardV3TwapFeed.Unavailable.selector);
        feed.latestRoundData();
    }

    function checkSwap(address token, address venue) private returns (DockyardV3TwapFeed feed, int256 beforePrice) {
        feed = feedFor(token, venue);
        (, beforePrice,,,) = feed.latestRoundData();
        vm.deal(address(this), 100 ether);
        ITwapForkWeth(WETH).deposit{value: 100 ether}();
        expectedPool = venue;
        bool tripped;
        uint256 spent;
        for (uint256 i; i < 100; ++i) {
            budget = 1 ether;
            bool zeroForOne = IIsolatedV3Pool(venue).token0() == WETH;
            ITwapForkSwap(venue)
                .swap(
                    address(this),
                    zeroForOne,
                    int256(1 ether),
                    zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
                    ""
                );
            assertEq(budget, 0, "incomplete exact input");
            spent += 1 ether;
            try feed.latestRoundData() returns (uint80, int256 nowPrice, uint256, uint256, uint80) {
                // Same-block trades cannot increase the historical valuation.
                assertEq(nowPrice, beforePrice);
            } catch (bytes memory reason) {
                assertEq(bytes4(reason), DockyardV3TwapFeed.SpotDeviation.selector);
                tripped = true;
                break;
            }
        }
        assertTrue(tripped, "test swap size did not exercise spot circuit");
        emit log_named_uint("WETH input before spot circuit tripped", spent);
        emit log_named_uint("purchased collateral raw", IERC20(token).balanceOf(address(this)));
        expectedPool = address(0);
    }

    function checkHeldPrice(address token, address venue) private {
        (DockyardV3TwapFeed feed, int256 beforePrice) = checkSwap(token, venue);
        // No arbitrage or independent market movement on this local fork.
        // A trade-held price is eventually indistinguishable from a genuine price
        // to this one source. This is a risk demonstration, not a safety assertion.
        vm.warp(block.timestamp + 1801);
        refreshPool(venue);
        refreshPool(USDG_POOL);
        (, int256 afterPrice,,,) = feed.latestRoundData();
        assertGt(afterPrice, beforePrice);
        emit log_named_int("held-price TWAP increase bps", (afterPrice - beforePrice) * 10000 / beforePrice);
    }

    function refreshPool(address venue) private {
        expectedPool = venue;
        bool zeroForOne = IIsolatedV3Pool(venue).token0() == WETH;
        // A V3 swap writes an observation only when its tick changes. Tiny
        // same-tick trades do not refresh the timestamp; assert an actual write.
        for (uint256 i; i < 20; ++i) {
            budget = 1 ether;
            ITwapForkSwap(venue)
                .swap(
                    address(this),
                    zeroForOne,
                    int256(1 ether),
                    zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
                    ""
                );
            assertEq(budget, 0);
            (,, uint16 index,,,,) = IIsolatedV3Pool(venue).slot0();
            (uint32 written,,,) = IIsolatedV3Pool(venue).observations(index);
            if (written == block.timestamp) {
                emit log_named_uint("WETH input to refresh pool observation", (i + 1) * 1 ether);
                expectedPool = address(0);
                return;
            }
        }
        assertTrue(false, "no new observation within test trade budget");
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == expectedPool && budget != 0, "unexpected callback");
        bool first = IIsolatedV3Pool(msg.sender).token0() == WETH;
        int256 due = first ? d0 : d1;
        require(due > 0 && uint256(due) <= budget && (first ? d1 : d0) <= 0, "invalid payment");
        budget -= uint256(due);
        require(IERC20(WETH).transfer(msg.sender, uint256(due)), "payment failed");
    }
}
