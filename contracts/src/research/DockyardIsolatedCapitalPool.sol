// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

interface ICapitalSafety {
    function capitalOperationsAllowed() external view returns (bool);
}

/// @notice Research-only capital ledger for one separately funded credit engine.
/// @dev NOT a complete lending market. The engine must enforce collateral, pricing,
/// liquidations and loss recognition. Interest is checkpointed before capital
/// changes; the engine's per-position debt must reconcile to this aggregate ledger.
/// Atomic paused assembly is provided separately; production admission remains unverified.
contract DockyardIsolatedCapitalPool is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable creditEngine;
    address public immutable collateralToken;
    address public immutable feeRecipient;
    uint256 public immutable debtLimit;
    uint16 public immutable revenueFeeBps;
    uint16 public immutable borrowAprBps;
    uint256 public outstandingPrincipal;
    uint256 public interestReceivable;
    uint256 public lastAccrual;
    uint256 private interestRemainder;
    uint256 private constant INTEREST_DENOMINATOR = 10000 * 365 days;
    uint256 public protocolFees;
    uint256 public cumulativeLoss;
    bool public retired;

    error InvalidConfiguration();
    error EngineOnly();
    error InvalidAmount();
    error InsufficientCash();
    error DebtLimitExceeded();
    error UnsupportedTransfer();
    error InvalidRecipient();
    error CapitalOperationsSuspended();
    error Slippage();
    error InvalidDeadline();
    error MarketRetired();

    event CreditDrawn(address indexed recipient, uint256 amount);
    event CreditRepaid(uint256 principal, uint256 receivedYield, uint256 protocolFee);
    event CreditLossRecognized(uint256 principal, uint256 interest);
    event RevenueClaimed(uint256 amount);
    event InterestAccrued(uint256 amount);
    event CapitalRetired();

    constructor(
        IERC20Metadata usdg,
        address collateral,
        address engine,
        address treasury,
        uint256 limit,
        uint16 feeBps,
        uint16 aprBps
    ) ERC20("Dockyard research lender share", "drLS") ERC4626(IERC20(address(usdg))) {
        if (
            address(usdg).code.length == 0 || usdg.decimals() != 6 || collateral.code.length == 0
                || collateral == address(usdg) || engine.code.length == 0 || treasury == address(0)
                || treasury == address(this) || limit == 0 || feeBps > 2000 || aprBps > 10000
        ) revert InvalidConfiguration();
        collateralToken = collateral;
        creditEngine = engine;
        feeRecipient = treasury;
        debtLimit = limit;
        revenueFeeBps = feeBps;
        borrowAprBps = aprBps;
        lastAccrual = block.timestamp;
    }

    modifier onlyEngine() {
        if (msg.sender != creditEngine) revert EngineOnly();
        _;
    }

    /// @notice Permanent stop for new lender capital and draws. Redemptions,
    /// repayment and loss accounting remain available under their existing rules.
    function retire() external onlyEngine nonReentrant {
        retired = true;
        emit CapitalRetired();
    }

    function availableCash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - protocolFees;
    }

    /// @dev Principal at book value is not a promise of recovery. Engine losses
    /// must be recognized before withdrawals; otherwise exiting lenders can
    /// leave unrecognized losses to remaining lenders.
    function totalAssets() public view override returns (uint256) {
        (uint256 pending,) = _pendingInterest();
        uint256 grossInterest = interestReceivable + pending;
        return availableCash() + outstandingPrincipal + grossInterest - Math.mulDiv(grossInterest, revenueFeeBps, 10000);
    }

    function pendingInterest() external view returns (uint256 amount) {
        (amount,) = _pendingInterest();
    }

    function accrueInterest() external nonReentrant {
        _accrue();
    }

    // Same accounting principle as Liquity's pre-operation interest checkpoint,
    // but no USDG is minted: accrued interest is a receivable, not spendable cash.
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        _accrue();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        _accrue();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        _accrue();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        _accrue();
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Quote-bound entry points for wallet UIs. Limits apply atomically,
    /// including interest checkpointing and any transfer; a failure rolls back all state.
    function depositWithMinShares(uint256 assets, address receiver, uint256 minShares, uint256 deadline)
        public
        nonReentrant
        returns (uint256 shares)
    {
        _checkDeadline(deadline);
        if (minShares == 0) revert InvalidAmount();
        _accrue();
        shares = super.deposit(assets, receiver);
        if (shares < minShares) revert Slippage();
    }

    function withdrawWithMaxShares(uint256 assets, address receiver, address owner, uint256 maxShares, uint256 deadline)
        public
        nonReentrant
        returns (uint256 shares)
    {
        _checkDeadline(deadline);
        if (maxShares == 0) revert InvalidAmount();
        _accrue();
        shares = super.withdraw(assets, receiver, owner);
        if (shares > maxShares) revert Slippage();
    }

    function redeemWithMinAssets(uint256 shares, address receiver, address owner, uint256 minAssets, uint256 deadline)
        public
        nonReentrant
        returns (uint256 assets)
    {
        _checkDeadline(deadline);
        if (minAssets == 0) revert InvalidAmount();
        _accrue();
        assets = super.redeem(shares, receiver, owner);
        if (assets < minAssets) revert Slippage();
    }

    function _checkDeadline(uint256 deadline) private view {
        if (deadline < block.timestamp || deadline > block.timestamp + 5 minutes) revert InvalidDeadline();
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!capitalOperationsAllowed()) return 0;
        return Math.min(super.maxWithdraw(owner), availableCash());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!capitalOperationsAllowed()) return 0;
        if (availableCash() >= totalAssets()) return balanceOf(owner);
        return Math.min(balanceOf(owner), convertToShares(availableCash()));
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (retired) return 0;
        if (!capitalOperationsAllowed()) return 0;
        if (receiver == address(0) || receiver == address(this) || (totalSupply() != 0 && totalAssets() == 0)) {
            return 0;
        }
        return super.maxDeposit(receiver);
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return maxDeposit(receiver) == 0 ? 0 : super.maxMint(receiver);
    }

    function draw(address recipient, uint256 amount) external onlyEngine nonReentrant {
        if (retired) revert MarketRetired();
        _accrue();
        if (!capitalOperationsAllowed()) revert CapitalOperationsSuspended();
        if (amount == 0) revert InvalidAmount();
        if (amount > availableCash()) revert InsufficientCash();
        if (amount > debtLimit - outstandingPrincipal) revert DebtLimitExceeded();
        outstandingPrincipal += amount;
        _sendExact(recipient, amount);
        emit CreditDrawn(recipient, amount);
    }

    /// @dev Engine supplies real USDG, including received interest/recoveries.
    /// Fee is taken only from received yield, never lender principal. This fee
    /// has no relationship to a token's trading tax or a promised lender APY.
    function repay(uint256 principal, uint256 receivedYield) external onlyEngine nonReentrant {
        _accrue();
        if (principal > outstandingPrincipal || receivedYield > interestReceivable || principal + receivedYield == 0) {
            revert InvalidAmount();
        }
        uint256 beforeBalance = IERC20(asset()).balanceOf(address(this));
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), principal + receivedYield);
        if (IERC20(asset()).balanceOf(address(this)) - beforeBalance != principal + receivedYield) {
            revert UnsupportedTransfer();
        }
        outstandingPrincipal -= principal;
        uint256 feeBefore = Math.mulDiv(interestReceivable, revenueFeeBps, 10000);
        interestReceivable -= receivedYield;
        uint256 fee = feeBefore - Math.mulDiv(interestReceivable, revenueFeeBps, 10000);
        protocolFees += fee;
        emit CreditRepaid(principal, receivedYield, fee);
    }

    function recognizeLoss(uint256 principal, uint256 interest) external onlyEngine nonReentrant {
        _accrue();
        if (principal + interest == 0 || principal > outstandingPrincipal || interest > interestReceivable) {
            revert InvalidAmount();
        }
        outstandingPrincipal -= principal;
        interestReceivable -= interest;
        cumulativeLoss += principal + interest;
        emit CreditLossRecognized(principal, interest);
    }

    /// @notice Anyone may trigger payment, but only to the immutable treasury.
    function claimRevenue() external nonReentrant {
        uint256 amount = protocolFees;
        if (amount == 0) revert InvalidAmount();
        protocolFees = 0;
        _sendExact(feeRecipient, amount);
        emit RevenueClaimed(amount);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (assets == 0 || shares == 0) revert InvalidAmount();
        uint256 beforeBalance = IERC20(asset()).balanceOf(address(this));
        super._deposit(caller, receiver, assets, shares);
        if (IERC20(asset()).balanceOf(address(this)) - beforeBalance != assets) revert UnsupportedTransfer();
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        if (shares == 0) revert InvalidAmount();
        if (receiver == address(0) || receiver == address(this)) revert InvalidRecipient();
        uint256 beforePool = IERC20(asset()).balanceOf(address(this));
        uint256 beforeReceiver = IERC20(asset()).balanceOf(receiver);
        super._withdraw(caller, receiver, owner, assets, shares);
        if (
            beforePool - IERC20(asset()).balanceOf(address(this)) != assets
                || IERC20(asset()).balanceOf(receiver) - beforeReceiver != assets
        ) revert UnsupportedTransfer();
    }

    function _sendExact(address recipient, uint256 amount) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 beforePool = IERC20(asset()).balanceOf(address(this));
        uint256 beforeRecipient = IERC20(asset()).balanceOf(recipient);
        IERC20(asset()).safeTransfer(recipient, amount);
        if (
            beforePool - IERC20(asset()).balanceOf(address(this)) != amount
                || IERC20(asset()).balanceOf(recipient) - beforeRecipient != amount
        ) revert UnsupportedTransfer();
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @notice Fail closed on pending liquidations or unavailable loan pricing.
    /// Debt-free cash remains withdrawable even when the engine/oracles fail.
    function capitalOperationsAllowed() public view returns (bool) {
        if (outstandingPrincipal == 0 && interestReceivable == 0) return true;
        try ICapitalSafety(creditEngine).capitalOperationsAllowed() returns (bool allowed) {
            return allowed;
        } catch {
            return false;
        }
    }

    function _pendingInterest() private view returns (uint256 amount, uint256 remainder) {
        uint256 timeRate = (block.timestamp - lastAccrual) * borrowAprBps;
        amount = Math.mulDiv(outstandingPrincipal, timeRate, INTEREST_DENOMINATOR);
        uint256 carried = mulmod(outstandingPrincipal, timeRate, INTEREST_DENOMINATOR) + interestRemainder;
        amount += carried / INTEREST_DENOMINATOR;
        remainder = carried % INTEREST_DENOMINATOR;
    }

    function _accrue() private {
        (uint256 interest, uint256 remainder) = _pendingInterest();
        interestReceivable += interest;
        interestRemainder = remainder;
        lastAccrual = block.timestamp;
        if (interest != 0) emit InterestAccrued(interest);
    }
}
