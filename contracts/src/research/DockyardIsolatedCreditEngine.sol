// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {DockyardIsolatedCapitalPool} from "./DockyardIsolatedCapitalPool.sol";

interface IIsolatedPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Research engine for one ERC-20 collateral and one separately funded USDG pool.
/// @dev Not production approved: deployed token/oracle verification and stressed
/// liquidation execution are required. Oracle addresses must have independent data.
contract DockyardIsolatedCreditEngine is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant DENOMINATOR = 10000 * 365 days;
    IERC20 public immutable usdg;
    IERC20 public immutable collateralToken;
    IIsolatedPriceFeed public immutable primary;
    IIsolatedPriceFeed public immutable secondary;
    uint256 public immutable staleness;
    uint16 public immutable maxLtvBps;
    uint16 public immutable liquidationLtvBps;
    uint16 public immutable bonusBps;
    uint16 public immutable deviationBps;
    uint256 public immutable minimumDebt;
    uint8 private immutable primaryDecimals;
    uint8 private immutable secondaryDecimals;
    DockyardIsolatedCapitalPool public pool;
    bool public riskPaused = true;
    bool public retired;
    uint256 public activeDebtPositions;
    uint256 public constant MAX_ACTIVE_POSITIONS = 64;
    address[] private activeBorrowers;
    mapping(address => uint256) private activeIndex;

    struct Position {
        uint256 collateral;
        uint256 principal;
        uint256 interest;
        uint256 remainder;
        uint256 updatedAt;
    }
    mapping(address => Position) public positions;

    error InvalidConfiguration();
    error PoolAlreadyBound();
    error NotReady();
    error InvalidAmount();
    error InvalidRecipient();
    error UnsupportedTransfer();
    error OracleUnavailable();
    error OracleMismatch();
    error UnsafePosition();
    error HealthyPosition();
    error Slippage();
    error PositionLimitReached();
    error MarketRetired();

    event PoolBound(address indexed pool);
    event RiskPaused(bool paused);
    event MarketRetirement();
    event CollateralDeposited(address indexed borrower, address indexed payer, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, address indexed recipient, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(address indexed borrower, address indexed payer, uint256 principal, uint256 interest);
    event Liquidated(address indexed borrower, address indexed liquidator, uint256 repaid, uint256 seized);
    event PositionLoss(address indexed borrower, uint256 principal, uint256 interest);
    event RoundingInterestCleared(uint256 amount);

    struct Config {
        address usdg;
        address collateral;
        address primary;
        address secondary;
        address guardian;
        uint256 staleness;
        uint16 maxLtvBps;
        uint16 liquidationLtvBps;
        uint16 bonusBps;
        uint16 deviationBps;
        uint256 minimumDebt;
    }

    constructor(Config memory c) {
        if (
            c.usdg.code.length == 0 || c.collateral.code.length == 0 || c.usdg == c.collateral
                || c.primary.code.length == 0 || c.secondary.code.length == 0 || c.primary == c.secondary
                || c.guardian == address(0) || c.staleness == 0 || c.maxLtvBps == 0
                || c.maxLtvBps >= c.liquidationLtvBps || c.liquidationLtvBps >= 10000 || c.bonusBps > 1500
                || c.deviationBps == 0 || c.deviationBps > 2500 || c.minimumDebt == 0
                || uint256(c.liquidationLtvBps) * (10000 + c.bonusBps) >= 10000 * 10000
                || IERC20Metadata(c.usdg).decimals() != 6 || IERC20Metadata(c.collateral).decimals() != 18
        ) revert InvalidConfiguration();
        usdg = IERC20(c.usdg);
        collateralToken = IERC20(c.collateral);
        primary = IIsolatedPriceFeed(c.primary);
        secondary = IIsolatedPriceFeed(c.secondary);
        primaryDecimals = primary.decimals();
        secondaryDecimals = secondary.decimals();
        if (primaryDecimals > 18 || secondaryDecimals > 18) revert InvalidConfiguration();
        staleness = c.staleness;
        maxLtvBps = c.maxLtvBps;
        liquidationLtvBps = c.liquidationLtvBps;
        bonusBps = c.bonusBps;
        deviationBps = c.deviationBps;
        minimumDebt = c.minimumDebt;
        _transferOwnership(c.guardian);
    }

    function bindPool(DockyardIsolatedCapitalPool candidate) external onlyOwner {
        if (address(pool) != address(0)) revert PoolAlreadyBound();
        if (
            candidate.creditEngine() != address(this) || candidate.asset() != address(usdg)
                || candidate.collateralToken() != address(collateralToken)
        ) revert InvalidConfiguration();
        pool = candidate;
        emit PoolBound(address(candidate));
    }

    function setRiskPaused(bool paused) external onlyOwner {
        if (!paused) {
            if (retired) revert MarketRetired();
            _requirePool();
            price();
        }
        riskPaused = paused;
        emit RiskPaused(paused);
    }

    /// @notice Irreversibly close admission before a replacement deployment.
    /// This moves no funds and forgives no debt. Existing borrowers retain
    /// repayment/top-up paths; lenders settle under the normal loss/cash rules.
    function retireMarket() external onlyOwner nonReentrant {
        _requirePool();
        retired = true;
        riskPaused = true;
        pool.retire();
        emit RiskPaused(true);
        emit MarketRetirement();
    }

    function renounceOwnership() public view override onlyOwner {
        revert InvalidConfiguration();
    }

    function price() public view virtual returns (uint256) {
        uint256 a = _read(primary, primaryDecimals);
        uint256 b = _read(secondary, secondaryDecimals);
        uint256 low = Math.min(a, b);
        if (Math.mulDiv(Math.max(a, b) - low, 10000, low, Math.Rounding.Up) > deviationBps) revert OracleMismatch();
        return low;
    }

    /// @notice Risk-increasing actions may require stricter policy than liquidation.
    /// The generic token engine uses the same price; stock engines enforce a
    /// current trading-session approval here without making repayment depend on it.
    function borrowingPrice() public view virtual returns (uint256) {
        return price();
    }

    function positionDebt(address borrower) public view returns (uint256) {
        Position memory p = positions[borrower];
        if (p.principal == 0) return p.interest;
        (uint256 pending,) = _interest(p);
        return p.principal + p.interest + pending;
    }

    function activeBorrowerAt(uint256 index) external view returns (address) {
        return activeBorrowers[index];
    }

    /// @notice A bounded on-chain scan prevents share entry/exit at book value
    /// while a loan awaits liquidation. No oracle dependency after all debt closes.
    function capitalOperationsAllowed() external view returns (bool) {
        if (activeBorrowers.length == 0) return true;
        if (riskPaused) return false;
        uint256 value;
        try this.borrowingPrice() returns (uint256 validPrice) {
            value = validPrice;
        } catch {
            return false;
        }
        for (uint256 i; i < activeBorrowers.length; ++i) {
            address borrower = activeBorrowers[i];
            if (!_safe(positions[borrower].collateral, positionDebt(borrower), value, liquidationLtvBps)) return false;
        }
        return true;
    }

    function depositCollateral(address borrower, uint256 amount) external nonReentrant {
        _depositCollateral(borrower, amount);
    }

    function depositAndBorrow(uint256 collateralAmount, uint256 borrowAmount) external nonReentrant {
        _depositCollateral(msg.sender, collateralAmount);
        _borrow(borrowAmount);
    }

    function _depositCollateral(address borrower, uint256 amount) internal {
        _requirePool();
        if (borrower == address(0) || borrower == address(this)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();
        if (retired && positions[borrower].principal + positions[borrower].interest == 0) revert MarketRetired();
        _pullExact(collateralToken, msg.sender, amount);
        positions[borrower].collateral += amount;
        emit CollateralDeposited(borrower, msg.sender, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        _borrow(amount);
    }

    function _borrow(uint256 amount) internal {
        _requirePool();
        if (riskPaused) revert NotReady();
        if (amount == 0) revert InvalidAmount();
        Position storage p = positions[msg.sender];
        _settle(p);
        if (p.principal + p.interest + amount < minimumDebt) revert InvalidAmount();
        if (!_safe(p.collateral, p.principal + p.interest + amount, borrowingPrice(), maxLtvBps)) revert UnsafePosition();
        if (p.principal == 0) {
            if (activeBorrowers.length == MAX_ACTIVE_POSITIONS) revert PositionLimitReached();
            activeBorrowers.push(msg.sender);
            activeIndex[msg.sender] = activeBorrowers.length;
            activeDebtPositions++;
        }
        p.principal += amount;
        pool.draw(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    function withdrawCollateral(uint256 amount, address recipient) external nonReentrant {
        _withdrawCollateral(amount, recipient);
    }

    function _withdrawCollateral(uint256 amount, address recipient) internal {
        _requirePool();
        if (amount == 0) revert InvalidAmount();
        Position storage p = positions[msg.sender];
        _settle(p);
        if (amount > p.collateral) revert InvalidAmount();
        uint256 debt = p.principal + p.interest;
        if (debt != 0 && (riskPaused || !_safe(p.collateral - amount, debt, borrowingPrice(), maxLtvBps))) {
            revert UnsafePosition();
        }
        p.collateral -= amount;
        _sendExact(collateralToken, recipient, amount);
        emit CollateralWithdrawn(msg.sender, recipient, amount);
    }

    /// @notice Repay up to maxAmount, interest first; no oracle or unpause required.
    function repay(address borrower, uint256 maxAmount) external nonReentrant returns (uint256 paid) {
        return _repayUpTo(borrower, maxAmount);
    }

    /// @notice Full repayment and collateral return in one transaction. An
    /// insufficient maximum reverts everything, including the USDG transfer.
    function close(uint256 maxRepay, address recipient) external nonReentrant returns (uint256 paid) {
        paid = _repayUpTo(msg.sender, maxRepay);
        if (positions[msg.sender].principal + positions[msg.sender].interest != 0) revert UnsafePosition();
        uint256 amount = positions[msg.sender].collateral;
        if (amount != 0) _withdrawCollateral(amount, recipient);
    }

    function _repayUpTo(address borrower, uint256 maxAmount) private returns (uint256 paid) {
        _requirePool();
        Position storage p = positions[borrower];
        _settle(p);
        paid = Math.min(maxAmount, p.principal + p.interest);
        if (paid == 0) revert InvalidAmount();
        uint256 remaining = p.principal + p.interest - paid;
        if (remaining != 0 && remaining < minimumDebt) revert InvalidAmount();
        _repay(borrower, p, paid);
        _finish(borrower, p);
    }

    /// @notice Liquidator pays USDG and receives collateral. Selling the tokens
    /// is a separate keeper operation; minCollateral protects against quote changes.
    function liquidate(address borrower, uint256 maxRepay, uint256 minCollateral)
        external
        nonReentrant
        returns (uint256 paid, uint256 seized)
    {
        return _liquidate(borrower, maxRepay, minCollateral);
    }

    function _liquidate(address borrower, uint256 maxRepay, uint256 minCollateral)
        internal
        returns (uint256 paid, uint256 seized)
    {
        _requirePool();
        Position storage p = positions[borrower];
        _settle(p);
        uint256 debt = p.principal + p.interest;
        uint256 value = price();
        (paid, seized) = _liquidationQuote(p.collateral, debt, value, maxRepay);
        if (seized < minCollateral) revert Slippage();
        _repay(borrower, p, paid);
        p.collateral -= seized;
        if (p.collateral == 0 && p.principal + p.interest > 0) {
            pool.recognizeLoss(p.principal, p.interest);
            emit PositionLoss(borrower, p.principal, p.interest);
            p.principal = 0;
            p.interest = 0;
        }
        _finish(borrower, p);
        _sendExact(collateralToken, msg.sender, seized);
        emit Liquidated(borrower, msg.sender, paid, seized);
    }

    function liquidationQuote(address borrower, uint256 maxRepay) external view returns (uint256 paid, uint256 seized) {
        return _liquidationQuote(positions[borrower].collateral, positionDebt(borrower), price(), maxRepay);
    }

    function _liquidationQuote(uint256 collateral, uint256 debt, uint256 value, uint256 maxRepay)
        private
        view
        returns (uint256 paid, uint256 seized)
    {
        if (debt == 0 || _safe(collateral, debt, value, liquidationLtvBps)) revert HealthyPosition();
        uint256 covered = _coveredDebt(collateral, value);
        // Require at least one micro-USDG for a sub-unit dust position.
        uint256 repayCap = Math.min(debt, Math.max(covered, 1));
        paid = Math.min(maxRepay, repayCap);
        if (paid == 0) revert InvalidAmount();
        if (covered < debt && paid == repayCap) {
            seized = collateral;
        } else {
            // Reserve both debt AND collateral recovery for the next liquidator.
            // Insolvent debt alone can be large while its collateral is dust.
            // Round reserved collateral up, then the permitted payment down, so
            // seizure rounding cannot consume that reserve. Never raise maxRepay.
            if (paid < debt) {
                if (debt <= minimumDebt) revert InvalidAmount();
                uint256 reserve = _collateralForPayment(minimumDebt, value);
                if (reserve >= collateral) revert InvalidAmount();
                uint256 partialCap = Math.min(debt - minimumDebt, _coveredDebt(collateral - reserve, value));
                paid = Math.min(paid, partialCap);
                if (paid == 0) revert InvalidAmount();
            }
            seized = Math.min(collateral, _collateralForPayment(paid, value));
        }
        if (seized == 0) revert Slippage();
    }

    function _coveredDebt(uint256 collateral, uint256 value) private view returns (uint256) {
        uint256 collateralValue = Math.mulDiv(collateral, value, 1e18);
        return Math.mulDiv(collateralValue, 10000, 10000 + bonusBps) / 1e12;
    }

    function _collateralForPayment(uint256 paid, uint256 value) private view returns (uint256) {
        uint256 bonusValue = Math.mulDiv(paid * 1e12, 10000 + bonusBps, 10000, Math.Rounding.Up);
        return Math.mulDiv(bonusValue, 1e18, value, Math.Rounding.Up);
    }

    function _repay(address borrower, Position storage p, uint256 amount) private {
        uint256 interest = Math.min(amount, p.interest);
        uint256 principal = amount - interest;
        _pullExact(usdg, msg.sender, amount);
        usdg.safeApprove(address(pool), amount);
        pool.repay(principal, interest);
        p.interest -= interest;
        p.principal -= principal;
        emit Repaid(borrower, msg.sender, principal, interest);
    }

    function _settle(Position storage p) private {
        pool.accrueInterest();
        (uint256 interest, uint256 remainder) = _interest(p);
        p.interest += interest;
        p.remainder = remainder;
        p.updatedAt = block.timestamp;
    }

    function _interest(Position memory p) private view returns (uint256 amount, uint256 remainder) {
        uint256 timeRate = (block.timestamp - p.updatedAt) * pool.borrowAprBps();
        amount = Math.mulDiv(p.principal, timeRate, DENOMINATOR);
        uint256 carry = mulmod(p.principal, timeRate, DENOMINATOR) + p.remainder;
        return (amount + carry / DENOMINATOR, carry % DENOMINATOR);
    }

    function _finish(address borrower, Position storage p) private {
        if (p.principal + p.interest != 0) return;
        activeDebtPositions--;
        uint256 index = activeIndex[borrower] - 1;
        address last = activeBorrowers[activeBorrowers.length - 1];
        activeBorrowers[index] = last;
        activeIndex[last] = index + 1;
        activeBorrowers.pop();
        delete activeIndex[borrower];
        p.remainder = 0;
        if (activeDebtPositions == 0) {
            // Sum of individual floors can be below the aggregate floor. Once
            // all loans close, remove only the remaining interest receivable.
            uint256 dust = pool.interestReceivable();
            if (dust != 0) {
                pool.recognizeLoss(0, dust);
                emit RoundingInterestCleared(dust);
            }
        }
    }

    function _safe(uint256 amount, uint256 debt, uint256 value, uint256 ltv) private pure returns (bool) {
        return debt <= Math.mulDiv(Math.mulDiv(amount, value, 1e18), ltv, 10000) / 1e12;
    }

    function _read(IIsolatedPriceFeed feed, uint8 decimals_) private view returns (uint256) {
        if (feed.decimals() != decimals_) revert OracleUnavailable();
        try feed.latestRoundData() returns (uint80 round, int256 answer, uint256, uint256 updated, uint80 answered) {
            if (
                answer <= 0 || round == 0 || answered < round || updated == 0 || updated > block.timestamp
                    || block.timestamp - updated > staleness
            ) revert OracleUnavailable();
            return uint256(answer) * 10 ** (18 - decimals_);
        } catch {
            revert OracleUnavailable();
        }
    }

    function _requirePool() private view {
        if (address(pool) == address(0)) revert NotReady();
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTransfer();
    }

    function _sendExact(IERC20 token, address to, uint256 amount) private {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        uint256 beforePool = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (beforePool - token.balanceOf(address(this)) != amount || token.balanceOf(to) - beforeRecipient != amount) {
            revert UnsupportedTransfer();
        }
    }
}
