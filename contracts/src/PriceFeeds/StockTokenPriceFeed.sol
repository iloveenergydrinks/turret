// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "../Dependencies/AggregatorV3Interface.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IStockToken.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @notice Chainlink adapter with primary and secondary endpoints for Robinhood Stock Tokens.
/// @dev Robinhood's Stock Token feed is expected to include the ERC-8056
/// corporate-action multiplier. This adapter intentionally does not apply it
/// again. Expected liveness interruptions revert temporarily; malformed data
/// falls back to the secondary endpoint before permanently shutting down the
/// branch. Large price movements require delayed
/// confirmation by a later oracle round before they can become the live price.
contract StockTokenPriceFeed is IPriceFeed {
    uint256 internal constant BPS = 10_000;

    IStockToken public immutable stockToken;
    AggregatorV3Interface public immutable stockTokenUsdOracle;
    AggregatorV3Interface public immutable secondaryStockTokenUsdOracle;
    AggregatorV3Interface public immutable sequencerUptimeFeed;
    IBorrowerOperations public immutable borrowerOperations;
    uint256 public immutable stalenessThreshold;
    uint256 public immutable sequencerGracePeriod;
    uint256 public immutable maxDeviationBps;
    uint256 public immutable largeChangeConfirmationDelay;
    uint256 public immutable confirmationDeviationBps;
    uint8 public immutable oracleDecimals;
    uint8 public immutable secondaryOracleDecimals;

    uint256 public lastGoodPrice;
    uint256 public pendingPrice;
    uint256 public pendingSince;
    uint80 public pendingRoundId;
    address public pendingOracle;
    bool public usingLastGoodPrice;

    error InvalidConfiguration();
    error InvalidInitialPrice();
    error InsufficientGasForExternalCall();
    error OracleTemporarilyUnavailable(address source);
    error LargePriceChangeUnconfirmed(uint256 price);
    error PriceChangeDoesNotRequireConfirmation();
    error InvalidPriceForConfirmation();
    error BranchAlreadyShutDown();

    enum ReadStatus {
        valid,
        temporaryUnavailable,
        invalid
    }

    event LastGoodPriceUpdated(uint256 price);
    event SecondaryOracleUsed(uint256 price, uint80 roundId);
    event LargePriceChangeStaged(uint256 price, uint80 roundId, uint256 stagedAt);
    event LargePriceChangeConfirmed(uint256 price, uint80 roundId);
    event ShutDownFromOracleFailure(address indexed failedOracle);

    constructor(
        address _stockToken,
        address _stockTokenUsdOracle,
        address _secondaryStockTokenUsdOracle,
        uint256 _stalenessThreshold,
        address _sequencerUptimeFeed,
        uint256 _sequencerGracePeriod,
        uint256 _maxDeviationBps,
        uint256 _largeChangeConfirmationDelay,
        uint256 _confirmationDeviationBps,
        address _borrowerOperations
    ) {
        if (
            _stockToken == address(0) || _stockTokenUsdOracle == address(0)
                || _secondaryStockTokenUsdOracle == address(0) || _stockTokenUsdOracle == _secondaryStockTokenUsdOracle
                || _borrowerOperations == address(0) || _stalenessThreshold == 0 || _maxDeviationBps == 0
                || _maxDeviationBps > BPS || _largeChangeConfirmationDelay == 0 || _confirmationDeviationBps == 0
                || _confirmationDeviationBps > _maxDeviationBps
        ) revert InvalidConfiguration();
        if (_sequencerUptimeFeed != address(0) && _sequencerGracePeriod == 0) revert InvalidConfiguration();

        stockToken = IStockToken(_stockToken);
        stockTokenUsdOracle = AggregatorV3Interface(_stockTokenUsdOracle);
        secondaryStockTokenUsdOracle = AggregatorV3Interface(_secondaryStockTokenUsdOracle);
        sequencerUptimeFeed = AggregatorV3Interface(_sequencerUptimeFeed);
        borrowerOperations = IBorrowerOperations(_borrowerOperations);
        stalenessThreshold = _stalenessThreshold;
        sequencerGracePeriod = _sequencerGracePeriod;
        maxDeviationBps = _maxDeviationBps;
        largeChangeConfirmationDelay = _largeChangeConfirmationDelay;
        confirmationDeviationBps = _confirmationDeviationBps;

        uint8 decimals = stockTokenUsdOracle.decimals();
        uint8 secondaryDecimals = secondaryStockTokenUsdOracle.decimals();
        if (decimals > 18 || secondaryDecimals > 18) revert InvalidConfiguration();
        oracleDecimals = decimals;
        secondaryOracleDecimals = secondaryDecimals;

        (bool pauseReadSucceeded, bool paused) = _readOraclePause();
        (uint256 initialPrice,, ReadStatus primaryStatus) = _readStockPrice(stockTokenUsdOracle, oracleDecimals);
        (,, ReadStatus secondaryStatus) = _readStockPrice(secondaryStockTokenUsdOracle, secondaryOracleDecimals);
        if (!pauseReadSucceeded || paused || primaryStatus != ReadStatus.valid || secondaryStatus != ReadStatus.valid) {
            revert InvalidInitialPrice();
        }
        lastGoodPrice = initialPrice;
        emit LastGoodPriceUpdated(initialPrice);
    }

    function fetchPrice() public returns (uint256, bool) {
        if (usingLastGoodPrice) return (lastGoodPrice, false);

        if (!_sequencerIsHealthy()) revert OracleTemporarilyUnavailable(address(sequencerUptimeFeed));

        (bool pauseReadSucceeded, bool paused) = _readOraclePause();
        if (!pauseReadSucceeded || paused) revert OracleTemporarilyUnavailable(address(stockToken));

        (uint256 price, uint80 roundId, address source, ReadStatus status) = _readStockPrice();
        if (status == ReadStatus.temporaryUnavailable) {
            revert OracleTemporarilyUnavailable(address(stockTokenUsdOracle));
        }
        if (status == ReadStatus.invalid) return _shutdown(address(stockTokenUsdOracle));
        if (source == address(secondaryStockTokenUsdOracle)) emit SecondaryOracleUsed(price, roundId);

        if (_deviationTooLarge(price)) {
            if (!_largeChangeIsConfirmed(price, roundId, source)) revert LargePriceChangeUnconfirmed(price);
            emit LargePriceChangeConfirmed(price, roundId);
        }

        _clearPendingPrice();
        lastGoodPrice = price;
        emit LastGoodPriceUpdated(price);
        return (price, false);
    }

    function fetchRedemptionPrice() external returns (uint256, bool) {
        return fetchPrice();
    }

    /// @notice Permissionlessly records the first valid round of a large move.
    /// @dev A later fresh round must remain within confirmationDeviationBps of
    /// this candidate and the confirmation delay must pass before fetchPrice
    /// accepts the move. Repeated calls for the same candidate do not reset it.
    function stageLargePriceChange() external returns (uint256 price, uint80 roundId) {
        if (usingLastGoodPrice) revert BranchAlreadyShutDown();

        _requireSourcesAvailable();
        ReadStatus status;
        address source;
        (price, roundId, source, status) = _readStockPrice();
        if (status == ReadStatus.temporaryUnavailable) {
            revert OracleTemporarilyUnavailable(address(stockTokenUsdOracle));
        }
        if (status == ReadStatus.invalid) revert InvalidPriceForConfirmation();
        if (!_deviationTooLarge(price)) revert PriceChangeDoesNotRequireConfirmation();

        if (
            pendingPrice == 0 || source != pendingOracle
                || _deviationTooLargeFrom(price, pendingPrice, confirmationDeviationBps)
        ) {
            pendingPrice = price;
            pendingRoundId = roundId;
            pendingOracle = source;
            pendingSince = block.timestamp;
            emit LargePriceChangeStaged(price, roundId, block.timestamp);
        }
    }

    function _shutdown(address failedOracle) internal returns (uint256, bool) {
        borrowerOperations.shutdownFromOracleFailure();
        usingLastGoodPrice = true;
        emit ShutDownFromOracleFailure(failedOracle);
        return (lastGoodPrice, true);
    }

    function _readStockPrice() internal view returns (uint256, uint80, address, ReadStatus) {
        (uint256 primaryPrice, uint80 primaryRoundId, ReadStatus primaryStatus) =
            _readStockPrice(stockTokenUsdOracle, oracleDecimals);
        if (primaryStatus == ReadStatus.valid) {
            return (primaryPrice, primaryRoundId, address(stockTokenUsdOracle), ReadStatus.valid);
        }

        (uint256 secondaryPrice, uint80 secondaryRoundId, ReadStatus secondaryStatus) =
            _readStockPrice(secondaryStockTokenUsdOracle, secondaryOracleDecimals);
        if (secondaryStatus == ReadStatus.valid) {
            return (secondaryPrice, secondaryRoundId, address(secondaryStockTokenUsdOracle), ReadStatus.valid);
        }

        // Do not permanently shut a branch while either endpoint may recover.
        if (primaryStatus == ReadStatus.temporaryUnavailable || secondaryStatus == ReadStatus.temporaryUnavailable) {
            return (0, 0, address(0), ReadStatus.temporaryUnavailable);
        }
        return (0, 0, address(0), ReadStatus.invalid);
    }

    function _readStockPrice(AggregatorV3Interface oracle, uint8 decimals)
        internal
        view
        returns (uint256, uint80, ReadStatus)
    {
        (bool success, uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound) = _readOracle(oracle);
        if (!success) return (0, 0, ReadStatus.temporaryUnavailable);
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || answeredInRound < roundId) {
            return (0, roundId, ReadStatus.invalid);
        }
        if (block.timestamp - updatedAt >= stalenessThreshold) {
            return (0, roundId, ReadStatus.temporaryUnavailable);
        }

        uint256 scale = 10 ** (18 - decimals);
        uint256 unsignedAnswer = uint256(answer);
        if (unsignedAnswer > type(uint256).max / scale) return (0, roundId, ReadStatus.invalid);

        return (unsignedAnswer * scale, roundId, ReadStatus.valid);
    }

    function _requireSourcesAvailable() internal view {
        if (!_sequencerIsHealthy()) revert OracleTemporarilyUnavailable(address(sequencerUptimeFeed));

        (bool pauseReadSucceeded, bool paused) = _readOraclePause();
        if (!pauseReadSucceeded || paused) revert OracleTemporarilyUnavailable(address(stockToken));
    }

    function _readOraclePause() internal view returns (bool success, bool paused) {
        uint256 gasBefore = gasleft();
        try stockToken.oraclePaused() returns (bool _paused) {
            return (true, _paused);
        } catch {
            if (gasleft() <= gasBefore / 64) revert InsufficientGasForExternalCall();
            return (false, true);
        }
    }

    function _sequencerIsHealthy() internal view returns (bool) {
        if (address(sequencerUptimeFeed) == address(0)) return true;

        (bool success,, int256 answer, uint256 startedAt,) = _readOracleWithStartedAt(sequencerUptimeFeed);
        return success && answer == 0 && startedAt != 0 && startedAt <= block.timestamp
            && block.timestamp - startedAt > sequencerGracePeriod;
    }

    function _deviationTooLarge(uint256 price) internal view returns (bool) {
        return _deviationTooLargeFrom(price, lastGoodPrice, maxDeviationBps);
    }

    function _deviationTooLargeFrom(uint256 price, uint256 referencePrice, uint256 deviationBps)
        internal
        pure
        returns (bool)
    {
        uint256 difference = price > referencePrice ? price - referencePrice : referencePrice - price;
        return difference > Math.mulDiv(referencePrice, deviationBps, BPS);
    }

    function _largeChangeIsConfirmed(uint256 price, uint80 roundId, address source) internal view returns (bool) {
        return pendingPrice != 0 && source == pendingOracle && roundId > pendingRoundId
            && block.timestamp >= pendingSince + largeChangeConfirmationDelay
            && !_deviationTooLargeFrom(price, pendingPrice, confirmationDeviationBps);
    }

    function _clearPendingPrice() internal {
        if (pendingPrice == 0) return;
        delete pendingPrice;
        delete pendingSince;
        delete pendingRoundId;
        delete pendingOracle;
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
