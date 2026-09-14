// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardIsolatedCreditEngine, IIsolatedPriceFeed} from "./DockyardIsolatedCreditEngine.sol";
import {DockyardHeartbeatGuard} from "../Oracles/DockyardHeartbeatGuard.sol";
import {DockyardExecutionGate} from "../Oracles/DockyardExecutionGate.sol";

/// @notice Stock-backed pooled credit with guarded stock prices and explicit USDG valuation.
/// @dev Candidate, not production approved. Stock pricing remains one canonical
/// feed plus a trusted guardian's health assessment, NOT two independent stock
/// price sources. USDG feeds must be independently verified USDG/USD sources.
/// Runtime pins cannot detect upgrades behind an unchanged proxy implementation.
contract DockyardStockCreditEngine is DockyardIsolatedCreditEngine, EIP712 {
    bytes32 public constant MARKET_HEALTH_TYPEHASH = keccak256(
        "MarketHealth(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)"
    );
    bytes32 public approvedMarketHealth;

    struct UsdgPricing {
        address primary;
        address secondary;
        uint32 primaryMaxAge;
        uint32 secondaryMaxAge;
        uint16 maxDeviationBps;
        uint32 maxTimestampSkew;
    }

    DockyardHeartbeatGuard public immutable stockGuard;
    DockyardExecutionGate public immutable executionGate;
    IIsolatedPriceFeed public immutable usdgPrimary;
    IIsolatedPriceFeed public immutable usdgSecondary;
    // Independent heartbeat budgets. 25 hours is a ceiling, not a default or
    // production recommendation. Stock/session/liveness budgets are unchanged.
    uint32 public constant MAX_USDG_AGE = 25 hours;
    uint32 public immutable usdgPrimaryMaxAge;
    uint32 public immutable usdgSecondaryMaxAge;
    uint16 public immutable usdgMaxDeviationBps;
    uint32 public immutable usdgMaxTimestampSkew;
    uint8 private immutable usdgPrimaryDecimals;
    uint8 private immutable usdgSecondaryDecimals;
    bytes32 private immutable stockHash;
    bytes32 private immutable cashHash;
    bytes32 private immutable guardHash;
    bytes32 private immutable stockFeedHash;
    bytes32 private immutable gateHash;
    bytes32 private immutable usdgPrimaryHash;
    bytes32 private immutable usdgSecondaryHash;

    error DependencyChanged();
    error InvalidUsdgPrice();
    error MarketHealthUnauthorized();

    constructor(Config memory c, address gate, UsdgPricing memory u)
        DockyardIsolatedCreditEngine(c)
        EIP712("DockyardStockCredit", "1")
    {
        if (
            gate.code.length == 0 || u.primary.code.length == 0 || u.secondary.code.length == 0
                || u.primary == u.secondary || u.primary == c.primary || u.secondary == c.primary
                || u.primary == c.secondary || u.secondary == c.secondary || u.primaryMaxAge == 0
                || u.primaryMaxAge > MAX_USDG_AGE || u.secondaryMaxAge == 0 || u.secondaryMaxAge > MAX_USDG_AGE
                || u.maxTimestampSkew == 0 || u.maxTimestampSkew > Math.max(u.primaryMaxAge, u.secondaryMaxAge)
                || u.maxDeviationBps == 0 || u.maxDeviationBps > 200
        ) revert InvalidConfiguration();
        stockGuard = DockyardHeartbeatGuard(c.secondary);
        executionGate = DockyardExecutionGate(gate);
        if (
            stockGuard.collateral() != c.collateral || address(stockGuard.primaryOracle()) != c.primary
                || stockGuard.guardian() != executionGate.guardian() || stockGuard.MAX_PRICE_AGE() != c.staleness
                || stockGuard.maxDeviationBps() != c.deviationBps
        ) {
            revert InvalidConfiguration();
        }
        usdgPrimary = IIsolatedPriceFeed(u.primary);
        usdgSecondary = IIsolatedPriceFeed(u.secondary);
        usdgPrimaryDecimals = usdgPrimary.decimals();
        usdgSecondaryDecimals = usdgSecondary.decimals();
        if (usdgPrimaryDecimals > 18 || usdgSecondaryDecimals > 18) revert InvalidConfiguration();
        usdgPrimaryMaxAge = u.primaryMaxAge;
        usdgSecondaryMaxAge = u.secondaryMaxAge;
        usdgMaxDeviationBps = u.maxDeviationBps;
        usdgMaxTimestampSkew = u.maxTimestampSkew;
        stockHash = c.collateral.codehash;
        cashHash = c.usdg.codehash;
        stockFeedHash = c.primary.codehash;
        guardHash = c.secondary.codehash;
        gateHash = gate.codehash;
        usdgPrimaryHash = u.primary.codehash;
        usdgSecondaryHash = u.secondary.codehash;
    }

    /// @notice Liquidation price in USDG per Stock Token, 18 decimals. No fresh
    /// session approval is required, but feed validity, quarantine and liveness are.
    function price() public view override returns (uint256) {
        return _stockPrice(false);
    }

    /// @notice Used for new debt, debt-bearing collateral exits and book-value
    /// lender entry/exit while loans are outstanding. Stops at session/health expiry.
    function borrowingPrice() public view override returns (uint256) {
        return _stockPrice(true);
    }

    /// @notice Simulate fresh execution liveness for keeper scans without a
    /// separate onchain publication. These calls never move collateral or USDG.
    function priceWithLiveness(bytes calldata liveness) external returns (uint256) {
        executionGate.submitLiveness(liveness);
        return price();
    }

    function liquidationQuoteWithLiveness(address borrower, uint256 maximum, bytes calldata liveness)
        external
        returns (uint256 paid, uint256 seized)
    {
        executionGate.submitLiveness(liveness);
        return this.liquidationQuote(borrower, maximum);
    }

    function _stockPrice(bool borrowing) private view returns (uint256 value) {
        if (
            address(collateralToken).codehash != stockHash || address(usdg).codehash != cashHash
                || address(stockGuard).codehash != guardHash || address(primary).codehash != stockFeedHash
                || address(executionGate).codehash != gateHash || address(usdgPrimary).codehash != usdgPrimaryHash
                || address(usdgSecondary).codehash != usdgSecondaryHash
        ) revert DependencyChanged();
        executionGate.requireLive();
        // The canonical stock feed already includes the token/share multiplier.
        // The guard checks oraclePaused/effectiveAt; do not multiply a second time.
        (uint256 stockUsd,) = stockGuard.validatedPrice(borrowing);
        if (borrowing) {
            (
                uint80 roundId,
                uint64 observedAt,
                uint64 validUntil,
                uint64 sessionOpen,
                uint64 sessionClose,
                bytes32 roundHash,
                uint64 epoch
            ) = stockGuard.health();
            bytes32 current = keccak256(
                abi.encode(
                    MARKET_HEALTH_TYPEHASH, roundId, observedAt, validUntil, sessionOpen, sessionClose, roundHash, epoch
                )
            );
            if (approvedMarketHealth != current) revert MarketHealthUnauthorized();
        }
        (uint256 a, uint256 timeA) = _usdPrice(usdgPrimary, usdgPrimaryDecimals, usdgPrimaryMaxAge);
        (uint256 b, uint256 timeB) = _usdPrice(usdgSecondary, usdgSecondaryDecimals, usdgSecondaryMaxAge);
        uint256 low = Math.min(a, b);
        uint256 high = Math.max(a, b);
        if (
            Math.mulDiv(high - low, 10000, low, Math.Rounding.Up) > usdgMaxDeviationBps
                || Math.max(timeA, timeB) - Math.min(timeA, timeB) > usdgMaxTimestampSkew
        ) revert InvalidUsdgPrice();
        // Higher USDG valuation and floor rounding produce less borrowing power.
        value = Math.mulDiv(stockUsd, 1e18, high);
        if (value == 0) revert InvalidUsdgPrice();
    }

    function _usdPrice(IIsolatedPriceFeed feed, uint8 decimals_, uint32 maxAge)
        private
        view
        returns (uint256, uint256)
    {
        if (feed.decimals() != decimals_) revert InvalidUsdgPrice();
        (uint80 round, int256 answer,, uint256 updated, uint80 answered) = feed.latestRoundData();
        if (
            round == 0 || answer <= 0 || uint256(answer) > type(uint128).max || answered < round || updated == 0
                || updated > block.timestamp || block.timestamp - updated >= maxAge
        ) {
            revert InvalidUsdgPrice();
        }
        return (uint256(answer) * 10 ** (18 - decimals_), updated);
    }

    /// @notice Permissionless publication also lets lenders refresh approvals
    /// before a pool transaction. Expiry still applies at transaction execution.
    function submitChecks(bytes calldata health, bytes calldata liveness) external {
        _submit(health, liveness);
    }

    /// @notice Intended for eth_call: evaluate the same public proofs and capital
    /// safety rules that checked transactions use, without broadcasting a refresh.
    /// A real transaction only publishes proofs; this function never moves funds.
    /// Invalid/expired proofs revert rather than returning permissive quote limits.
    function quoteWithChecks(address wallet, bytes calldata health, bytes calldata liveness)
        external
        returns (uint256 stockPrice, uint256 borrowPrice, uint256 deposits, uint256 withdrawals, uint256 redemptions)
    {
        _submit(health, liveness);
        stockPrice = price();
        borrowPrice = borrowingPrice();
        deposits = pool.maxDeposit(wallet);
        withdrawals = pool.maxWithdraw(wallet);
        redemptions = pool.maxRedeem(wallet);
    }

    function depositAndBorrowChecked(
        uint256 collateralAmount,
        uint256 amount,
        bytes calldata health,
        bytes calldata liveness
    ) external nonReentrant {
        _submit(health, liveness);
        _depositCollateral(msg.sender, collateralAmount);
        _borrow(amount);
    }

    function borrowChecked(uint256 amount, bytes calldata health, bytes calldata liveness) external nonReentrant {
        _submit(health, liveness);
        _borrow(amount);
    }

    function withdrawCollateralChecked(
        uint256 amount,
        address recipient,
        bytes calldata health,
        bytes calldata liveness
    ) external nonReentrant {
        if (positionDebt(msg.sender) != 0) _submit(health, liveness);
        _withdrawCollateral(amount, recipient);
    }

    function liquidateChecked(address borrower, uint256 amount, uint256 minCollateral, bytes calldata liveness)
        external
        nonReentrant
        returns (uint256 paid, uint256 seized)
    {
        executionGate.submitLiveness(liveness);
        return _liquidate(borrower, amount, minCollateral);
    }

    function _submit(bytes calldata health, bytes calldata liveness) private {
        // Price health and admission are separate authorizations. Even if two
        // engines use one price guard, only a signature for this engine can
        // authorize its new debt and debt-bearing lender operations.
        (DockyardHeartbeatGuard.Health memory h, bytes memory priceSignature, bytes memory marketSignature) =
            abi.decode(health, (DockyardHeartbeatGuard.Health, bytes, bytes));
        bytes32 hash = keccak256(
            abi.encode(
                MARKET_HEALTH_TYPEHASH,
                h.roundId,
                h.observedAt,
                h.validUntil,
                h.sessionOpen,
                h.sessionClose,
                h.roundHash,
                h.epoch
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(hash), marketSignature) != stockGuard.guardian()) {
            revert MarketHealthUnauthorized();
        }
        executionGate.submitLiveness(liveness);
        stockGuard.submitHealth(abi.encode(h, priceSignature));
        approvedMarketHealth = hash;
    }
}
