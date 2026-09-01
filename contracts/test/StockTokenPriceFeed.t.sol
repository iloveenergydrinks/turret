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

    function setAnsweredInRound(uint80 value) external {
        answeredInRound = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "oracle unavailable");
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

    contract StockTokenMock {
        bool internal paused;
        bool public shouldRevert;

        function setOraclePaused(bool value) external {
            paused = value;
        }

        function setShouldRevert(bool value) external {
            shouldRevert = value;
        }

        function oraclePaused() external view returns (bool) {
            require(!shouldRevert, "token unavailable");
            return paused;
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
        uint256 internal constant CONFIRMATION_DELAY = 30 minutes;
        uint256 internal constant CONFIRMATION_DEVIATION_BPS = 500;

        OracleMock internal stockOracle;
        OracleMock internal sequencerOracle;
        StockTokenMock internal stockToken;
        BorrowerOperationsShutdownMock internal borrowerOperations;
        StockTokenPriceFeed internal priceFeed;

        function setUp() public {
            vm.warp(10 days);
            stockOracle = new OracleMock(8);
            sequencerOracle = new OracleMock(0);
            stockToken = new StockTokenMock();
            borrowerOperations = new BorrowerOperationsShutdownMock();

            stockOracle.setRound(120e8, block.timestamp, block.timestamp);
            sequencerOracle.setRound(0, block.timestamp - GRACE_PERIOD - 1, block.timestamp);

            priceFeed = _deployPriceFeed(address(sequencerOracle));
        }

        function _deployPriceFeed(address sequencer) internal returns (StockTokenPriceFeed) {
            return new StockTokenPriceFeed(
                address(stockToken),
                address(stockOracle),
                STALENESS,
                sequencer,
                GRACE_PERIOD,
                MAX_DEVIATION_BPS,
                CONFIRMATION_DELAY,
                CONFIRMATION_DEVIATION_BPS,
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

        function testConstructorRejectsPausedStockToken() public {
            stockToken.setOraclePaused(true);

            vm.expectRevert(StockTokenPriceFeed.InvalidInitialPrice.selector);
            _deployPriceFeed(address(sequencerOracle));
        }

        function testConstructorRejectsStockTokenPauseReadFailure() public {
            stockToken.setShouldRevert(true);

            vm.expectRevert(StockTokenPriceFeed.InvalidInitialPrice.selector);
            _deployPriceFeed(address(sequencerOracle));
        }

        function testStalenessBoundaryTemporarilyFreezesAndRecovers() public {
            vm.warp(block.timestamp + STALENESS);

            vm.expectRevert(
                abi.encodeWithSelector(StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(stockOracle))
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());
            assertFalse(priceFeed.usingLastGoodPrice());

            stockOracle.setRound(125e8, block.timestamp, block.timestamp);
            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 125e18);
            assertFalse(failed);
        }

        function testSequencerDownTemporarilyFreezesAndRecovers() public {
            sequencerOracle.setRound(1, block.timestamp, block.timestamp);

            vm.expectRevert(
                abi.encodeWithSelector(
                    StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(sequencerOracle)
                )
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());

            sequencerOracle.setRound(0, block.timestamp - GRACE_PERIOD - 1, block.timestamp);
            (, bool failed) = priceFeed.fetchPrice();
            assertFalse(failed);
        }

        function testSequencerGracePeriodTemporarilyFreezes() public {
            sequencerOracle.setRound(0, block.timestamp - GRACE_PERIOD, block.timestamp);

            vm.expectRevert(
                abi.encodeWithSelector(
                    StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(sequencerOracle)
                )
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());
        }

        function testSequencerReadFailureTemporarilyFreezesAndRecovers() public {
            sequencerOracle.setShouldRevert(true);

            vm.expectRevert(
                abi.encodeWithSelector(
                    StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(sequencerOracle)
                )
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());
            sequencerOracle.setShouldRevert(false);
            (, bool failed) = priceFeed.fetchPrice();
            assertFalse(failed);
        }

        function testCorporateActionPauseTemporarilyFreezesAndRecovers() public {
            stockToken.setOraclePaused(true);

            vm.expectRevert(
                abi.encodeWithSelector(StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(stockToken))
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());
            stockToken.setOraclePaused(false);
            (, bool failed) = priceFeed.fetchPrice();
            assertFalse(failed);
        }

        function testCorporateActionPauseReadFailureTemporarilyFreezes() public {
            stockToken.setShouldRevert(true);

            vm.expectRevert(
                abi.encodeWithSelector(StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(stockToken))
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());
        }

        function testExactUpwardDeviationBoundaryIsAccepted() public {
            stockOracle.setRound(144e8, block.timestamp, block.timestamp);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 144e18);
            assertFalse(failed);
        }

        function testExactDownwardDeviationBoundaryIsAccepted() public {
            stockOracle.setRound(96e8, block.timestamp, block.timestamp);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 96e18);
            assertFalse(failed);
        }

        function testUnconfirmedLargePriceChangeTemporarilyFreezes() public {
            stockOracle.setRound(145e8, block.timestamp, block.timestamp);

            vm.expectRevert(abi.encodeWithSelector(StockTokenPriceFeed.LargePriceChangeUnconfirmed.selector, 145e18));
            priceFeed.fetchPrice();

            assertEq(priceFeed.lastGoodPrice(), 120e18);
            assertFalse(borrowerOperations.shutDown());
            assertFalse(priceFeed.usingLastGoodPrice());
        }

        function testLargePriceChangeRequiresLaterRoundAndDelay() public {
            stockOracle.setRound(84e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();

            vm.warp(block.timestamp + CONFIRMATION_DELAY);
            vm.expectRevert(abi.encodeWithSelector(StockTokenPriceFeed.LargePriceChangeUnconfirmed.selector, 84e18));
            priceFeed.fetchPrice();

            stockOracle.setRound(85e8, block.timestamp, block.timestamp);
            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 85e18);
            assertFalse(failed);
            assertEq(priceFeed.lastGoodPrice(), 85e18);
            assertEq(priceFeed.pendingPrice(), 0);
        }

        function testLaterRoundCannotConfirmBeforeDelay() public {
            stockOracle.setRound(84e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();
            stockOracle.setRound(85e8, block.timestamp, block.timestamp);
            vm.warp(block.timestamp + CONFIRMATION_DELAY - 1);

            vm.expectRevert(abi.encodeWithSelector(StockTokenPriceFeed.LargePriceChangeUnconfirmed.selector, 85e18));
            priceFeed.fetchPrice();
        }

        function testMaterialCandidateDriftRestartsConfirmation() public {
            stockOracle.setRound(84e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();
            uint256 firstStagedAt = priceFeed.pendingSince();

            vm.warp(block.timestamp + 10 minutes);
            stockOracle.setRound(70e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();

            assertEq(priceFeed.pendingPrice(), 70e18);
            assertGt(priceFeed.pendingSince(), firstStagedAt);
            assertEq(priceFeed.pendingRoundId(), stockOracle.roundId());
        }

        function testRepeatedStagingDoesNotResetSameCandidate() public {
            stockOracle.setRound(84e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();
            uint256 firstStagedAt = priceFeed.pendingSince();

            vm.warp(block.timestamp + 10 minutes);
            priceFeed.stageLargePriceChange();

            assertEq(priceFeed.pendingSince(), firstStagedAt);
        }

        function testNormalPriceClearsPendingCandidate() public {
            stockOracle.setRound(84e8, block.timestamp, block.timestamp);
            priceFeed.stageLargePriceChange();
            stockOracle.setRound(119e8, block.timestamp, block.timestamp);

            (uint256 price,) = priceFeed.fetchPrice();

            assertEq(price, 119e18);
            assertEq(priceFeed.pendingPrice(), 0);
            assertEq(priceFeed.pendingSince(), 0);
            assertEq(priceFeed.pendingRoundId(), 0);
        }

        function testCannotStagePriceInsideNormalDeviationBand() public {
            stockOracle.setRound(125e8, block.timestamp, block.timestamp);

            vm.expectRevert(StockTokenPriceFeed.PriceChangeDoesNotRequireConfirmation.selector);
            priceFeed.stageLargePriceChange();
        }

        function testCannotStageMalformedPrice() public {
            stockOracle.setRound(0, block.timestamp, block.timestamp);

            vm.expectRevert(StockTokenPriceFeed.InvalidPriceForConfirmation.selector);
            priceFeed.stageLargePriceChange();

            assertFalse(borrowerOperations.shutDown());
        }

        function testCannotStageAfterPermanentShutdown() public {
            stockOracle.setRound(0, block.timestamp, block.timestamp);
            priceFeed.fetchPrice();

            vm.expectRevert(StockTokenPriceFeed.BranchAlreadyShutDown.selector);
            priceFeed.stageLargePriceChange();
        }

        function testZeroAnswerShutsDown() public {
            stockOracle.setRound(0, block.timestamp, block.timestamp);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testNegativeAnswerShutsDown() public {
            stockOracle.setRound(-1, block.timestamp, block.timestamp);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testFutureTimestampShutsDown() public {
            stockOracle.setRound(120e8, block.timestamp, block.timestamp + 1);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testIncompleteRoundShutsDown() public {
            stockOracle.setRound(120e8, block.timestamp, block.timestamp);
            stockOracle.setAnsweredInRound(stockOracle.roundId() - 1);

            (, bool failed) = priceFeed.fetchPrice();

            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testExtremeAnswerShutsDownWithoutReverting() public {
            stockOracle.setRound(type(int256).max, block.timestamp, block.timestamp);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 120e18);
            assertTrue(failed);
            assertTrue(borrowerOperations.shutDown());
        }

        function testShutdownIsPermanentAfterOracleRecovery() public {
            stockOracle.setRound(0, block.timestamp, block.timestamp);
            priceFeed.fetchPrice();
            stockOracle.setRound(125e8, block.timestamp, block.timestamp);

            (uint256 price, bool failed) = priceFeed.fetchPrice();

            assertEq(price, 120e18);
            assertFalse(failed);
            assertEq(priceFeed.lastGoodPrice(), 120e18);
            assertTrue(priceFeed.usingLastGoodPrice());
            assertTrue(borrowerOperations.shutDown());
        }

        function testPriceFeedCanRunWithoutSequencerOracle() public {
            StockTokenPriceFeed priceFeedWithoutSequencer = _deployPriceFeed(address(0));

            stockOracle.setRound(125e8, block.timestamp, block.timestamp);
            (uint256 price, bool failed) = priceFeedWithoutSequencer.fetchPrice();

            assertEq(price, 125e18);
            assertFalse(failed);
        }

        function testOracleRevertTemporarilyFreezesAndRecovers() public {
            stockOracle.setShouldRevert(true);

            vm.expectRevert(
                abi.encodeWithSelector(StockTokenPriceFeed.OracleTemporarilyUnavailable.selector, address(stockOracle))
            );
            priceFeed.fetchPrice();

            assertFalse(borrowerOperations.shutDown());

            stockOracle.setShouldRevert(false);
            (, bool failed) = priceFeed.fetchPrice();
            assertFalse(failed);
        }
    }
