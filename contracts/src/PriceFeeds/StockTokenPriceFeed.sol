// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "../Dependencies/AggregatorV3Interface.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/IPriceFeed.sol";

/// @notice Chainlink adapter for Robinhood Stock Tokens.
/// @dev Robinhood's Stock Token feed is expected to include the ERC-8056
/// corporate-action multiplier. This adapter intentionally does not apply it
/// again. Any oracle safety failure permanently shuts down the branch, matching
/// Liquity V2's conservative failure model.
contract StockTokenPriceFeed is IPriceFeed {
    uint256 internal constant BPS = 10_000;

    AggregatorV3Interface public immutable stockTokenUsdOracle;
    AggregatorV3Interface public immutable sequencerUptimeFeed;
    IBorrowerOperations public immutable borrowerOperations;
    uint256 public immutable stalenessThreshold;
    uint256 public immutable sequencerGracePeriod;
    uint256 public immutable maxDeviationBps;
    uint8 public immutable oracleDecimals;

    uint256 public lastGoodPrice;
    bool public usingLastGoodPrice;

    error InvalidConfiguration();
    error InvalidInitialPrice();
    error InsufficientGasForExternalCall();

    event LastGoodPriceUpdated(uint256 price);
    event ShutDownFromOracleFailure(address indexed failedOracle);

    constructor(
        address _stockTokenUsdOracle,
        uint256 _stalenessThreshold,
        address _sequencerUptimeFeed,
        uint256 _sequencerGracePeriod,
        uint256 _maxDeviationBps,
        address _borrowerOperations
    ) {
        if (
            _stockTokenUsdOracle == address(0) || _borrowerOperations == address(0) || _stalenessThreshold == 0
                || _maxDeviationBps == 0 || _maxDeviationBps > BPS
        ) revert InvalidConfiguration();
        if (_sequencerUptimeFeed != address(0) && _sequencerGracePeriod == 0) revert InvalidConfiguration();

        stockTokenUsdOracle = AggregatorV3Interface(_stockTokenUsdOracle);
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);
        borrowerOperations = IBorrowerOperations(_borrowerOperations);
        stalenessThreshold = _stalenessThreshold;
        sequencerGracePeriod = _sequencerGracePeriod;
        maxDeviationBps = _maxDeviationBps;

        uint8 decimals = stockTokenUsdOracle.decimals();
        if (decimals > 18) revert InvalidConfiguration();
        oracleDecimals = decimals;

        (uint256 initialPrice, bool valid) = _readStockPrice();
        if (!valid) revert InvalidInitialPrice();
        lastGoodPrice = initialPrice;
        emit LastGoodPriceUpdated(initialPrice);
    }

    function fetchPrice() public returns (uint256, bool) {
        if (usingLastGoodPrice) return (lastGoodPrice, false);

        if (!_sequencerIsHealthy()) return _shutdown(address(sequencerUptimeFeed));

        (uint256 price, bool valid) = _readStockPrice();
        if (!valid || _deviationTooLarge(price)) return _shutdown(address(stockTokenUsdOracle));

        lastGoodPrice = price;
        emit LastGoodPriceUpdated(price);
        return (price, false);
    }

    function fetchRedemptionPrice() external returns (uint256, bool) {
        return fetchPrice();
    }

    function _shutdown(address failedOracle) internal returns (uint256, bool) {
        borrowerOperations.shutdownFromOracleFailure();
        usingLastGoodPrice = true;
        emit ShutDownFromOracleFailure(failedOracle);
        return (lastGoodPrice, true);
    }

    function _readStockPrice() internal view returns (uint256, bool) {
        (bool success, uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) =
            _readOracle(stockTokenUsdOracle);
        if (
            !success || answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp
                || block.timestamp - updatedAt >= stalenessThreshold || answeredInRound < roundId
        ) return (0, false);

        return (uint256(answer) * 10 ** (18 - oracleDecimals), true);
    }

    function _sequencerIsHealthy() internal view returns (bool) {
        if (address(sequencerUptimeFeed) == address(0)) return true;

        (bool success,, int256 answer, uint256 startedAt,) = _readOracleWithStartedAt(sequencerUptimeFeed);
        return success && answer == 0 && startedAt != 0 && startedAt <= block.timestamp
            && block.timestamp - startedAt > sequencerGracePeriod;
    }

    function _deviationTooLarge(uint256 price) internal view returns (bool) {
        uint256 previous = lastGoodPrice;
        uint256 difference = price > previous ? price - previous : previous - price;
        return difference * BPS > previous * maxDeviationBps;
    }

    function _readOracle(AggregatorV3Interface oracle)
        internal
        view
        returns (bool success, uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 gasBefore = gasleft();
        try oracle.latestRoundData() returns (
            uint80 _roundId, int256 _answer, uint256, uint256 _updatedAt, uint80 _answeredInRound
        ) {
            return (true, _roundId, _answer, _updatedAt, _answeredInRound);
        } catch {
            if (gasleft() <= gasBefore / 64) revert InsufficientGasForExternalCall();
            return (false, 0, 0, 0, 0);
        }
    }

    function _readOracleWithStartedAt(AggregatorV3Interface oracle)
        internal
        view
        returns (bool success, uint80 roundId, int256 answer, uint256 startedAt, uint80 answeredInRound)
    {
        uint256 gasBefore = gasleft();
        try oracle.latestRoundData() returns (
            uint80 _roundId, int256 _answer, uint256 _startedAt, uint256, uint80 _answeredInRound
        ) {
            return (true, _roundId, _answer, _startedAt, _answeredInRound);
        } catch {
            if (gasleft() <= gasBefore / 64) revert InsufficientGasForExternalCall();
            return (false, 0, 0, 0, 0);
        }
    }
}
