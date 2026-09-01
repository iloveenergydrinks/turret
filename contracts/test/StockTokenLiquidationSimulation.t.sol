// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "src/Dependencies/AggregatorV3Interface.sol";
import "src/PriceFeeds/StockTokenPriceFeed.sol";
import "test/TestContracts/DevTestSetup.sol";

contract StockLiquidationOracleMock is AggregatorV3Interface {
    uint8 public immutable override decimals = 8;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;
    bool public shouldRevert;

    constructor(int256 initialAnswer) {
        answer = initialAnswer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 newAnswer) external {
        roundId++;
        answer = newAnswer;
        updatedAt = block.timestamp;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "oracle unavailable");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract StockLiquidationPauseMock {
    bool public oraclePaused;
}

/// @notice Exercises a Stock Token oracle through the actual borrowing,
/// Stability Pool, and liquidation contracts. The test swaps the dev price
/// feed runtime in-place so every already-connected branch contract calls the
/// production-shaped adapter at the address it received during construction.
contract StockTokenLiquidationSimulationTest is DevTestSetup {
    uint256 internal constant STALENESS = 1 hours;
    uint256 internal constant MAX_DEVIATION_BPS = 2_000;
    uint256 internal constant CONFIRMATION_DELAY = 30 minutes;
    uint256 internal constant CONFIRMATION_DEVIATION_BPS = 500;

    StockLiquidationOracleMock internal primaryOracle;
    StockLiquidationOracleMock internal secondaryOracle;
    StockTokenPriceFeed internal stockPriceFeed;

    function setUp() public override {
        vm.warp(block.timestamp + 600);

        accounts = new Accounts();
        createAccounts();
        (A, B, C, D, E, F, G) =
        (
            accountsList[0],
            accountsList[1],
            accountsList[2],
            accountsList[3],
            accountsList[4],
            accountsList[5],
            accountsList[6]
        );

        // NVDA-style branch parameters: 200% MCR, 230% CCR, 125% SCR.
        TestDeployer deployer = new TestDeployer();
        TestDeployer.LiquityContractsDev memory contracts;
        TestDeployer.Zappers memory zappers;
        (contracts, collateralRegistry, boldToken, hintHelpers,, WETH, zappers) = deployer.deployAndConnectContracts(
            TestDeployer.TroveManagerParams(230e16, 200e16, 10e16, 125e16, 5e16, 10e16)
        );
        addressesRegistry = contracts.addressesRegistry;
        collToken = contracts.collToken;
        activePool = contracts.activePool;
        borrowerOperations = contracts.borrowerOperations;
        collSurplusPool = contracts.pools.collSurplusPool;
        defaultPool = contracts.pools.defaultPool;
        gasPool = contracts.pools.gasPool;
        priceFeed = contracts.priceFeed;
        sortedTroves = contracts.sortedTroves;
        stabilityPool = contracts.stabilityPool;
        troveManager = contracts.troveManager;
        troveNFT = contracts.troveNFT;
        metadataNFT = addressesRegistry.metadataNFT();
        mockInterestRouter = contracts.interestRouter;
        wethZapper = zappers.wethZapper;
        gasCompZapper = zappers.gasCompZapper;
        leverageZapperCurve = zappers.leverageZapperCurve;
        leverageZapperUniV3 = zappers.leverageZapperUniV3;

        uint256 initialCollAmount = 10_000_000_000e18;
        for (uint256 i = 0; i < 6; ++i) {
            giveAndApproveColl(accountsList[i], initialCollAmount);
        }

        CCR = troveManager.get_CCR();
        MCR = troveManager.get_MCR();
        BCR = troveManager.get_BCR();
        LIQUIDATION_PENALTY_SP = troveManager.get_LIQUIDATION_PENALTY_SP();
        LIQUIDATION_PENALTY_REDISTRIBUTION = troveManager.get_LIQUIDATION_PENALTY_REDISTRIBUTION();
        assertEq(MCR, 200e16);
        assertEq(CCR, 230e16);

        primaryOracle = new StockLiquidationOracleMock(200e8);
        secondaryOracle = new StockLiquidationOracleMock(200e8);
        StockLiquidationPauseMock pauseSource = new StockLiquidationPauseMock();
        StockTokenPriceFeed implementation = new StockTokenPriceFeed(
            address(pauseSource),
            address(primaryOracle),
            address(secondaryOracle),
            STALENESS,
            address(0),
            0,
            MAX_DEVIATION_BPS,
            CONFIRMATION_DELAY,
            CONFIRMATION_DEVIATION_BPS,
            address(borrowerOperations)
        );

        vm.etch(address(priceFeed), address(implementation).code);
        stockPriceFeed = StockTokenPriceFeed(address(priceFeed));
        assertEq(stockPriceFeed.lastGoodPrice(), 200e18);
    }

    function _openLiquidationScenario() internal returns (uint256 riskyTroveId) {
        openTroveNoHints100pct(B, 100e18, 3_000e18, MIN_ANNUAL_INTEREST_RATE);
        riskyTroveId = openTroveNoHints100pct(A, 21e18, 2_000e18, MIN_ANNUAL_INTEREST_RATE);
        makeSPDepositAndClaim(B, 2_500e18);
    }

    function testConfirmedGapLiquidatesThroughStabilityPool() public {
        uint256 riskyTroveId = _openLiquidationScenario();
        uint256 stabilityPoolDepositsBefore = stabilityPool.getTotalBoldDeposits();

        primaryOracle.setAnswer(150e8);
        vm.expectRevert(abi.encodeWithSelector(StockTokenPriceFeed.LargePriceChangeUnconfirmed.selector, 150e18));
        troveManager.liquidate(riskyTroveId);
        assertEq(uint8(troveManager.getTroveStatus(riskyTroveId)), uint8(ITroveManager.Status.active));

        stockPriceFeed.stageLargePriceChange();
        vm.warp(block.timestamp + CONFIRMATION_DELAY);
        primaryOracle.setAnswer(151e8);

        troveManager.liquidate(riskyTroveId);

        assertEq(uint8(troveManager.getTroveStatus(riskyTroveId)), uint8(ITroveManager.Status.closedByLiquidation));
        assertLt(stabilityPool.getTotalBoldDeposits(), stabilityPoolDepositsBefore);
        assertGt(stabilityPool.getDepositorCollGain(B), 0);
        assertEq(stockPriceFeed.lastGoodPrice(), 151e18);
    }

    function testSecondaryFeedCanDriveLiquidationWhenPrimaryIsUnavailable() public {
        uint256 riskyTroveId = _openLiquidationScenario();
        primaryOracle.setShouldRevert(true);
        secondaryOracle.setAnswer(160e8);

        troveManager.liquidate(riskyTroveId);

        assertEq(uint8(troveManager.getTroveStatus(riskyTroveId)), uint8(ITroveManager.Status.closedByLiquidation));
        assertEq(stockPriceFeed.lastGoodPrice(), 160e18);
        assertFalse(borrowerOperations.hasBeenShutDown());
    }
}
