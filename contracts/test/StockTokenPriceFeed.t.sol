// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "src/Dependencies/AggregatorV3Interface.sol";
import "src/PriceFeeds/StockTokenPriceFeed.sol";

contract OracleMock is AggregatorV3Interface {
    uint8 public immutable override decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    bool public shouldRevert;

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function setRound(int256 _answer, uint256 _startedAt, uint256 _updatedAt) external {
        answer = _answer;
        startedAt = _startedAt;
        updatedAt = _updatedAt;
        roundId++;
        answeredInRound = roundId;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "oracle unavailable");
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

    contract BorrowerOperationsShutdownMock {
        bool public shutDown;

        function shutdownFromOracleFailure() external {
            shutDown = true;
        }
    }

    contract StockTokenPriceFeedTest is Test {
        uint256 internal constant STALENESS = 1 hours;
        uint256 internal constant GRACE_PERIOD = 1 hours;
        uint256 internal constant MAX_DEVIATION_BPS = 2_000;

        OracleMock internal stockOracle;
        OracleMock internal sequencerOracle;
        BorrowerOperationsShutdownMock internal borrowerOperations;
        StockTokenPriceFeed internal priceFeed;

        function setUp() public {
            vm.warp(10 days);
            stockOracle = new OracleMock(8);
            sequencerOracle = new OracleMock(0);
            borrowerOperations = new BorrowerOperationsShutdownMock();

            stockOracle.setRound(120e8, block.timestamp, block.timestamp);
            sequencerOracle.setRound(0, block.timestamp - GRACE_PERIOD - 1, block.timestamp);

            priceFeed = new StockTokenPriceFeed(
                address(stockOracle),
                STALENESS,
                address(sequencerOracle),
                GRACE_PERIOD,
                MAX_DEVIATION_BPS,
                address(borrowerOperations)
            );
        }

        function testInitialAndUpdatedPricesAreScaledTo18Decimals() public {
            assertEq(priceFeed.lastGoodPrice(), 120e18);

            stockOracle.setRound(130e8, block.timestamp, block.timestamp);
            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 130e18);
            assertFalse(failed);
            assertFalse(borrowerOperations.shutDown());
        }

        function testStalePriceShutsDownAndFreezesLastGoodPrice() public {
            vm.warp(block.timestamp + STALENESS);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 120e18);
            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
            assertTrue(priceFeed.usingLastGoodPrice());
        }

        function testSequencerDownShutsDown() public {
            sequencerOracle.setRound(1, block.timestamp, block.timestamp);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testSequencerGracePeriodShutsDown() public {
            sequencerOracle.setRound(0, block.timestamp - GRACE_PERIOD, block.timestamp);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testExcessiveSingleUpdateDeviationShutsDown() public {
            stockOracle.setRound(145e8, block.timestamp, block.timestamp);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 120e18);
            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testOracleRevertShutsDown() public {
            stockOracle.setShouldRevert(true);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }
    }
