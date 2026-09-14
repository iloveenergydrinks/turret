// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "openzeppelin-contracts/contracts/security/Pausable.sol";
import {DockyardExecutionGate} from "./Oracles/DockyardExecutionGate.sol";
import {DockyardHeartbeatGuard} from "./Oracles/DockyardHeartbeatGuard.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

interface IDockyardMVPOracle {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface IDockyardMVPRiskOracle {
    function maxDeviationBps() external view returns (uint16);
    function collateral() external view returns (address);
    function primaryOracle() external view returns (address);
    function validatedPrice(bool borrowing) external view returns (uint256 value, uint256 updatedAt);
}

interface IRobinhoodStockTokenMVP {
    function oraclePaused() external view returns (bool);
}

/// @title Dockyard capped MVP credit vault with guardian-attested execution liveness
/// @notice Owner-funded USDG loans backed by canonical Robinhood Stock Tokens.
/// @dev This intentionally avoids issuing a new stablecoin. The owner supplies
/// USDG liquidity and bears insolvency risk. Each collateral has an isolated
/// debt ceiling and an immutable 250 USDG global cap. Derived from the preserved V2
/// implementation; borrowing and liquidation additionally require a short-lived liveness proof. Existing ABI fields are retained
/// for clients: secondaryOracle is a risk adapter. Its deployment determines
/// the oracle trust model. Starts paused, markets disabled.
contract DockyardUSDGCreditVaultMVP is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    DockyardExecutionGate public immutable executionGate;
    mapping(address => bool) public borrowerAllowed;
    uint256 public constant MAX_MARKET_DEBT = 50e6;
    error BorrowerNotAllowed();
    event BorrowerPermission(address indexed borrower, bool allowed);

    uint256 public constant BPS = 10_000;
    uint256 public constant USD_PRECISION = 1e18;

    IERC20Metadata public immutable usdg;
    uint256 public immutable usdgTo18Scale;
    uint256 public immutable oracleStaleness;
    uint16 public immutable originationFeeBps;

    struct Market {
        IDockyardMVPOracle primaryOracle;
        IDockyardMVPOracle secondaryOracle;
        uint128 debtCeiling;
        uint16 maxLtvBps;
        uint16 liquidationLtvBps;
        uint16 liquidationBonusBps;
        uint16 maxOracleDeviationBps;
        uint8 primaryOracleDecimals;
        uint8 secondaryOracleDecimals;
        bool enabled;
    }

    struct Position {
        uint128 collateral;
        uint128 debt;
    }

    mapping(address collateral => Market market) public markets;
    mapping(address collateral => mapping(address borrower => Position position)) public positions;
    mapping(address collateral => uint256 debt) public marketDebt;
    address[] private _collaterals;
    uint256 public totalDebt;
    uint256 public immutable globalDebtCeiling;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidUSDGDecimals();
    error OwnershipCannotBeRenounced();
    error InvalidMarket();
    error MarketAlreadyExists();
    error MarketDisabled();
    error InvalidRiskParameters();
    error InvalidOracle();
    error OracleUnavailable();
    error OracleMismatch(uint256 primaryPrice, uint256 secondaryPrice);
    error StockTokenPaused();
    error InsufficientLiquidity();
    error DebtCeilingExceeded();
    error PositionWouldBeUnsafe();
    error PositionIsHealthy();
    error NoBadDebt();
    error Uint128Overflow();

    event MarketAdded(
        address indexed collateral,
        address indexed primaryOracle,
        address indexed secondaryOracle,
        uint256 debtCeiling,
        uint256 maxLtvBps,
        uint256 liquidationLtvBps
    );
    event MarketEnabled(address indexed collateral, bool enabled);
    event DebtCeilingUpdated(address indexed collateral, uint256 previousDebtCeiling, uint256 newDebtCeiling);
    event LiquidityFunded(address indexed funder, uint256 amount);
    event LiquidityWithdrawn(address indexed recipient, uint256 amount);
    event CollateralDeposited(address indexed collateral, address indexed borrower, uint256 amount);
    event CollateralWithdrawn(address indexed collateral, address indexed borrower, address recipient, uint256 amount);
    event Borrowed(address indexed collateral, address indexed borrower, uint256 amount, uint256 fee, uint256 debt);
    event Repaid(address indexed collateral, address indexed borrower, address payer, uint256 amount, uint256 debt);
    event Liquidated(
        address indexed collateral,
        address indexed borrower,
        address indexed liquidator,
        uint256 repaid,
        uint256 collateralSeized
    );
    event BadDebtWrittenOff(address indexed collateral, address indexed borrower, uint256 amount);

    constructor(address usdg_, address initialOwner, address gate_) {
        uint16 originationFeeBps_ = 50;
        uint256 globalDebtCeiling_ = 250e6;
        if (gate_.code.length == 0) revert InvalidOracle();
        executionGate = DockyardExecutionGate(gate_);
        if (usdg_ == address(0) || initialOwner == address(0)) revert ZeroAddress();
        uint8 usdgDecimals = IERC20Metadata(usdg_).decimals();
        if (usdgDecimals != 6) revert InvalidUSDGDecimals();
        if (originationFeeBps_ > 500 || globalDebtCeiling_ == 0) revert InvalidRiskParameters();

        usdg = IERC20Metadata(usdg_);
        usdgTo18Scale = 10 ** (18 - usdgDecimals);
        originationFeeBps = originationFeeBps_;
        // Compatibility metadata only; each adapter enforces both source ages.
        oracleStaleness = 1 days;
        globalDebtCeiling = globalDebtCeiling_;
        _pause();
        _transferOwnership(initialOwner);
    }

    function addMarket(
        address collateral,
        address primaryOracle,
        address secondaryOracle,
        uint128 debtCeiling,
        uint16 maxLtvBps,
        uint16 liquidationLtvBps,
        uint16 liquidationBonusBps,
        uint16 maxOracleDeviationBps
    ) public virtual onlyOwner {
        if (collateral == address(0) || primaryOracle == address(0) || secondaryOracle == address(0)) {
            revert ZeroAddress();
        }
        if (address(markets[collateral].primaryOracle) != address(0)) revert MarketAlreadyExists();
        if (IERC20Metadata(collateral).decimals() != 18) revert InvalidMarket();
        if (
            debtCeiling == 0 || debtCeiling > MAX_MARKET_DEBT || maxLtvBps > 3000 || liquidationLtvBps > 4000 || liquidationBonusBps > 500 || maxOracleDeviationBps != 200 || maxLtvBps == 0 || maxLtvBps >= liquidationLtvBps || liquidationLtvBps >= BPS
                || liquidationBonusBps > 1_500 || maxOracleDeviationBps == 0 || maxOracleDeviationBps > 2_500
        ) revert InvalidRiskParameters();

        if (
            primaryOracle == secondaryOracle || IDockyardMVPRiskOracle(secondaryOracle).collateral() != collateral
                || IDockyardMVPRiskOracle(secondaryOracle).primaryOracle() != primaryOracle
                || IDockyardMVPRiskOracle(secondaryOracle).maxDeviationBps() != maxOracleDeviationBps
        ) revert InvalidOracle();
        uint8 primaryDecimals = _oracleDecimals(primaryOracle);
        uint8 secondaryDecimals = _oracleDecimals(secondaryOracle);
        Market memory market = Market({
            primaryOracle: IDockyardMVPOracle(primaryOracle),
            secondaryOracle: IDockyardMVPOracle(secondaryOracle),
            debtCeiling: debtCeiling,
            maxLtvBps: maxLtvBps,
            liquidationLtvBps: liquidationLtvBps,
            liquidationBonusBps: liquidationBonusBps,
            maxOracleDeviationBps: maxOracleDeviationBps,
            primaryOracleDecimals: primaryDecimals,
            secondaryOracleDecimals: secondaryDecimals,
            enabled: false
        });
        markets[collateral] = market;
        _collaterals.push(collateral);

        // Register disabled, including during closures; enable only after oracle recovery.
        emit MarketAdded(collateral, primaryOracle, secondaryOracle, debtCeiling, maxLtvBps, liquidationLtvBps);
    }

    function collateralCount() external view returns (uint256) {
        return _collaterals.length;
    }

    function collateralAt(uint256 index) external view returns (address) {
        return _collaterals[index];
    }

    function availableLiquidity() public view returns (uint256) {
        return usdg.balanceOf(address(this));
    }

    function totalAssets() external view returns (uint256) {
        return availableLiquidity() + totalDebt;
    }

    function fund(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityFunded(msg.sender, amount);
    }

    function withdrawLiquidity(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        IERC20(address(usdg)).safeTransfer(recipient, amount);
        emit LiquidityWithdrawn(recipient, amount);
    }

    function depositCollateral(address collateral, uint256 amount) external nonReentrant {
        _depositCollateral(collateral, msg.sender, amount);
    }

    /// @notice Deposits collateral and borrows USDG in one transaction.
    /// @dev The upfront liquidity check avoids pulling collateral when the
    /// vault cannot satisfy the requested loan. Any later failure also reverts
    /// the collateral transfer because both actions share one transaction.
    function depositAndBorrow(address collateral, uint256 collateralAmount, uint256 borrowAmount)
        external
        whenNotPaused
        nonReentrant
    {
        if (borrowAmount > availableLiquidity()) revert InsufficientLiquidity();
        _depositCollateral(collateral, msg.sender, collateralAmount);
        _borrow(collateral, msg.sender, borrowAmount);
    }

    function _depositCollateral(address collateral, address borrower, uint256 amount) internal {
        _market(collateral);
        if (amount == 0) revert ZeroAmount();
        Position storage position = positions[collateral][borrower];
        // Existing positions can receive collateral during any vault/oracle restriction.
        // Token-level transfer restrictions are still enforced by the token itself.
        if (position.collateral == 0 && position.debt == 0) {
            _requireNotPaused();
            Market memory market = _enabledMarket(collateral);
            _validatedPriceForBorrowing(collateral, market);
        }
        position.collateral = _toUint128(uint256(position.collateral) + amount);
        IERC20(collateral).safeTransferFrom(borrower, address(this), amount);
        emit CollateralDeposited(collateral, borrower, amount);
    }

    function withdrawCollateral(address collateral, uint256 amount, address recipient) external nonReentrant {
        _withdrawCollateral(collateral, amount, recipient);
    }

    function _withdrawCollateral(address collateral, uint256 amount, address recipient) internal {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        Market memory market = _market(collateral);
        Position storage position = positions[collateral][msg.sender];
        if (amount > position.collateral) revert InvalidMarket();

        uint256 remainingCollateral = uint256(position.collateral) - amount;
        if (position.debt != 0) {
            executionGate.requireLive();
            _requireNotPaused();
            if (!market.enabled) revert MarketDisabled();
            uint256 collateralPrice = _validatedPriceForBorrowing(collateral, market);
            if (!_isSafe(remainingCollateral, position.debt, collateralPrice, market.maxLtvBps)) {
                revert PositionWouldBeUnsafe();
            }
        }
        position.collateral = uint128(remainingCollateral);
        IERC20(collateral).safeTransfer(recipient, amount);
        emit CollateralWithdrawn(collateral, msg.sender, recipient, amount);
    }

    function quoteDebt(uint256 amount) public view returns (uint256 debt, uint256 fee) {
        fee = Math.mulDiv(amount, originationFeeBps, BPS, Math.Rounding.Up);
        debt = amount + fee;
    }

    function borrow(address collateral, uint256 amount) external whenNotPaused nonReentrant {
        _borrow(collateral, msg.sender, amount);
    }

    function _borrow(address collateral, address borrower, uint256 amount) internal virtual {
        if (!borrowerAllowed[borrower]) revert BorrowerNotAllowed();
        executionGate.requireLive();
        if (amount == 0) revert ZeroAmount();
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        Market memory market = _enabledMarket(collateral);
        Position storage position = positions[collateral][borrower];
        (uint256 debtIncrease, uint256 fee) = quoteDebt(amount);
        uint256 newDebt = uint256(position.debt) + debtIncrease;
        uint256 newMarketDebt = marketDebt[collateral] + debtIncrease;
        if (newMarketDebt > market.debtCeiling || totalDebt + debtIncrease > globalDebtCeiling) {
            revert DebtCeilingExceeded();
        }

        uint256 collateralPrice = _validatedPriceForBorrowing(collateral, market);
        if (!_isSafe(position.collateral, newDebt, collateralPrice, market.maxLtvBps)) {
            revert PositionWouldBeUnsafe();
        }

        position.debt = _toUint128(newDebt);
        marketDebt[collateral] = newMarketDebt;
        totalDebt += debtIncrease;
        IERC20(address(usdg)).safeTransfer(borrower, amount);
        emit Borrowed(collateral, borrower, amount, fee, newDebt);
    }

    function repay(address collateral, address borrower, uint256 amount)
        external
        nonReentrant
        returns (uint256 repaid)
    {
        if (amount == 0) revert ZeroAmount();
        Position storage position = positions[collateral][borrower];
        repaid = Math.min(amount, uint256(position.debt));
        if (repaid == 0) revert ZeroAmount();

        position.debt = uint128(uint256(position.debt) - repaid);
        marketDebt[collateral] -= repaid;
        totalDebt -= repaid;
        IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), repaid);
        emit Repaid(collateral, borrower, msg.sender, repaid, position.debt);
    }

    /// @notice Repays the caller's full debt and returns all of their collateral.
    /// @dev This exit remains available while the vault or market is paused and
    /// does not depend on live oracle data because no debt remains afterward.
    function repayAllAndWithdrawCollateral(address collateral, address recipient)
        external
        nonReentrant
        returns (uint256 repaid, uint256 withdrawn)
    {
        if (recipient == address(0)) revert ZeroAddress();
        Position storage position = positions[collateral][msg.sender];
        repaid = position.debt;
        withdrawn = position.collateral;
        if (repaid == 0 && withdrawn == 0) revert ZeroAmount();

        position.debt = 0;
        position.collateral = 0;
        if (repaid != 0) {
            marketDebt[collateral] -= repaid;
            totalDebt -= repaid;
            IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), repaid);
            emit Repaid(collateral, msg.sender, msg.sender, repaid, 0);
        }
        if (withdrawn != 0) {
            IERC20(collateral).safeTransfer(recipient, withdrawn);
            emit CollateralWithdrawn(collateral, msg.sender, recipient, withdrawn);
        }
    }

    function liquidate(address collateral, address borrower, uint256 maxRepay, address recipient)
        external
        nonReentrant
        returns (uint256 repaid, uint256 collateralSeized)
    {
        return _liquidate(collateral, borrower, maxRepay, recipient);
    }

    function liquidateChecked(address collateral, address borrower, uint256 maxRepay, address recipient, bytes calldata proof)
        external nonReentrant returns (uint256 repaid, uint256 collateralSeized)
    {
        executionGate.submitLiveness(proof);
        return _liquidate(collateral, borrower, maxRepay, recipient);
    }

    function _liquidate(address collateral, address borrower, uint256 maxRepay, address recipient)
        internal returns (uint256 repaid, uint256 collateralSeized)
    {
        executionGate.requireLive();
        if (recipient == address(0)) revert ZeroAddress();
        if (maxRepay == 0) revert ZeroAmount();
        Market memory market = _market(collateral);
        Position storage position = positions[collateral][borrower];
        uint256 collateralPrice = _validatedPrice(collateral, market);
        if (_isSafe(position.collateral, position.debt, collateralPrice, market.liquidationLtvBps)) {
            revert PositionIsHealthy();
        }

        uint256 collateralValue = Math.mulDiv(position.collateral, collateralPrice, USD_PRECISION);
        uint256 maxRepayUsd18 = Math.mulDiv(collateralValue, BPS, BPS + market.liquidationBonusBps);
        uint256 maxRepayFromCollateral = maxRepayUsd18 / usdgTo18Scale;
        repaid = Math.min(Math.min(maxRepay, position.debt), maxRepayFromCollateral);
        if (repaid == 0) revert ZeroAmount();

        uint256 seizeValue = Math.mulDiv(repaid * usdgTo18Scale, BPS + market.liquidationBonusBps, BPS);
        collateralSeized = repaid == maxRepayFromCollateral
            ? position.collateral
            : Math.min(position.collateral, Math.mulDiv(seizeValue, USD_PRECISION, collateralPrice));

        position.debt = uint128(uint256(position.debt) - repaid);
        position.collateral = uint128(uint256(position.collateral) - collateralSeized);
        marketDebt[collateral] -= repaid;
        totalDebt -= repaid;
        IERC20(address(usdg)).safeTransferFrom(msg.sender, address(this), repaid);
        IERC20(collateral).safeTransfer(recipient, collateralSeized);
        emit Liquidated(collateral, borrower, msg.sender, repaid, collateralSeized);
    }

    function writeOffBadDebt(address collateral, address borrower) external onlyOwner {
        Position storage position = positions[collateral][borrower];
        if (position.collateral != 0 || position.debt == 0) revert NoBadDebt();
        uint256 amount = position.debt;
        position.debt = 0;
        marketDebt[collateral] -= amount;
        totalDebt -= amount;
        emit BadDebtWrittenOff(collateral, borrower, amount);
    }

    function setMarketEnabled(address collateral, bool enabled) external onlyOwner {
        Market storage market = markets[collateral];
        if (address(market.primaryOracle) == address(0)) revert InvalidMarket();
        if (enabled) _validatedPriceForBorrowing(collateral, market);
        market.enabled = enabled;
        emit MarketEnabled(collateral, enabled);
    }

    function setDebtCeiling(address collateral, uint128 newDebtCeiling) public virtual onlyOwner {
        Market storage market = markets[collateral];
        if (address(market.primaryOracle) == address(0) || newDebtCeiling == 0 || newDebtCeiling > MAX_MARKET_DEBT) revert InvalidMarket();
        uint256 previousDebtCeiling = market.debtCeiling;
        market.debtCeiling = newDebtCeiling;
        emit DebtCeilingUpdated(collateral, previousDebtCeiling, newDebtCeiling);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev A funded vault must always retain an account capable of recovering
    /// unused USDG and managing emergency controls. Ownership can still be
    /// transferred to another non-zero address through Ownable.
    function renounceOwnership() public pure override {
        revert OwnershipCannotBeRenounced();
    }

    function price(address collateral) external view returns (uint256) {
        Market memory market = _market(collateral);
        return _validatedPrice(collateral, market);
    }

    /// @notice Origination quote with session, pause and market restrictions enforced.
    function borrowingPrice(address collateral) external view whenNotPaused returns (uint256) {
        Market memory market = _enabledMarket(collateral);
        return _validatedPriceForBorrowing(collateral, market);
    }

    function positionLtvBps(address collateral, address borrower) external view returns (uint256) {
        Market memory market = _market(collateral);
        Position memory position = positions[collateral][borrower];
        if (position.debt == 0) return 0;
        uint256 collateralValue = Math.mulDiv(position.collateral, _validatedPrice(collateral, market), USD_PRECISION);
        if (collateralValue == 0) return type(uint256).max;
        return Math.mulDiv(uint256(position.debt) * usdgTo18Scale, BPS, collateralValue);
    }

    function _market(address collateral) internal view returns (Market memory market) {
        market = markets[collateral];
        if (address(market.primaryOracle) == address(0)) revert InvalidMarket();
    }

    function _enabledMarket(address collateral) internal view returns (Market memory market) {
        market = _market(collateral);
        if (!market.enabled) revert MarketDisabled();
    }

    function _isSafe(uint256 collateral, uint256 debt, uint256 price_, uint256 ltvBps) internal view returns (bool) {
        if (debt == 0) return true;
        uint256 collateralValue = Math.mulDiv(collateral, price_, USD_PRECISION);
        uint256 maximumDebt = Math.mulDiv(collateralValue, ltvBps, BPS);
        return debt * usdgTo18Scale <= maximumDebt;
    }

    function _validatedPrice(address collateral, Market memory market) internal view returns (uint256 value) {
        _requireStockTokenLive(collateral);
        (value,) = IDockyardMVPRiskOracle(address(market.secondaryOracle)).validatedPrice(false);
        if (value == 0) revert OracleUnavailable();
    }

    function _validatedPriceForBorrowing(address collateral, Market memory market)
        internal
        view
        returns (uint256 value)
    {
        _requireStockTokenLive(collateral);
        (value,) = IDockyardMVPRiskOracle(address(market.secondaryOracle)).validatedPrice(true);
        if (value == 0) revert OracleUnavailable();
    }

    function _oracleDecimals(address oracle) internal view returns (uint8 decimals_) {
        if (oracle.code.length == 0) revert InvalidOracle();
        try IDockyardMVPOracle(oracle).decimals() returns (uint8 value) {
            if (value > 18) revert InvalidOracle();
            return value;
        } catch {
            revert InvalidOracle();
        }
    }

    function _requireStockTokenLive(address collateral) internal view {
        try IRobinhoodStockTokenMVP(collateral).oraclePaused() returns (bool paused_) {
            if (paused_) revert StockTokenPaused();
        } catch {
            revert StockTokenPaused();
        }
    }

    function _toUint128(uint256 value) internal pure returns (uint128) {
        if (value > type(uint128).max) revert Uint128Overflow();
        return uint128(value);
    }

    function setBorrowerAllowed(address borrower, bool allowed) external onlyOwner {
        if (borrower == address(0)) revert ZeroAddress();
        borrowerAllowed[borrower] = allowed;
        emit BorrowerPermission(borrower, allowed);
    }
    function _submit(address collateral, bytes calldata packed) internal {
        (bytes memory healthProof, bytes memory livenessProof) = abi.decode(packed,(bytes,bytes));
        executionGate.submitLiveness(livenessProof);
        DockyardHeartbeatGuard(address(_market(collateral).secondaryOracle)).submitHealth(healthProof);
    }
    function depositAndBorrowChecked(address collateral, uint256 collateralAmount, uint256 amount, bytes calldata proof)
        external whenNotPaused nonReentrant {
        if (amount > availableLiquidity()) revert InsufficientLiquidity();
        _submit(collateral,proof);
        _depositCollateral(collateral,msg.sender,collateralAmount);
        _borrow(collateral,msg.sender,amount);
    }
    function borrowChecked(address collateral, uint256 amount, bytes calldata proof) external whenNotPaused nonReentrant {
        _submit(collateral,proof);
        _borrow(collateral,msg.sender,amount);
    }
    function withdrawCollateralChecked(address collateral, uint256 amount, address recipient, bytes calldata proof)
        external nonReentrant {
        if (positions[collateral][msg.sender].debt != 0) _submit(collateral,proof);
        _withdrawCollateral(collateral,amount,recipient);
    }
}
