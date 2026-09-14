// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {TurretVariableCapitalPool} from "./TurretVariableCapitalPool.sol";

interface IDockyardLiquidationCallback {
    /// @dev Authenticate msg.sender as the expected engine. The engine pulls
    /// exactly repaid USDG from the caller after this callback returns.
    function onDockyardLiquidation(address borrower, uint256 repaid, uint256 seized, bytes calldata data) external;
}

/// @notice Local accounting base adapted from the reviewed isolated engine.
/// @dev Only dual-feed plumbing removed; concrete subclasses must implement guarded price().
abstract contract VariableCreditBase is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 private constant DENOMINATOR = 10000 * 365 days;
    IERC20 public immutable usdg;
    IERC20 public immutable collateralToken;
    uint16 public immutable maxLtvBps;
    uint16 public immutable liquidationLtvBps;
    uint16 public immutable bonusBps;
    uint256 public immutable minimumDebt;
    TurretVariableCapitalPool public pool;
    bool public riskPaused = true;
    bool public retired;
    uint256 public activeDebtPositions;
    /// @notice Version 2 uses individual loan checks and available-cash withdrawals.
    uint256 public constant accountingVersion = 2;
    uint256 public constant MAX_REGISTRY_PAGE = 256;
    uint256 public constant MAX_INTENT_LIFETIME = 30 minutes;
    bytes32 public constant BORROW_INTENT_TYPEHASH = keccak256(
        "BorrowIntent(address owner,uint8 action,uint256 collateralAmount,uint256 debtAmount,uint256 maxDebt,uint256 minPrice,uint256 nonce,uint64 validAfter,uint64 deadline)"
    );

    struct BorrowIntent {
        address owner;
        uint8 action; // 1: deposit and borrow, 2: borrow, 3: withdraw collateral
        uint256 collateralAmount;
        uint256 debtAmount;
        uint256 maxDebt;
        uint256 minPrice;
        uint256 nonce;
        uint64 validAfter;
        uint64 deadline;
    }
    mapping(address => uint256) public borrowIntentNonces;
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
    mapping(address => uint256) public positionRateIntegral;

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
    error InvalidBorrowIntent();
    error InvalidBorrowSignature();
    error MarketRetired();

    event BorrowIntentExecuted(bytes32 indexed digest, address indexed borrower, uint256 indexed nonce, uint8 action);
    event BorrowIntentsInvalidated(address indexed borrower, uint256 nonce);

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
        address guardian;
        uint16 maxLtvBps;
        uint16 liquidationLtvBps;
        uint16 bonusBps;
        uint256 minimumDebt;
    }

    constructor(Config memory c) {
        if (
            c.usdg.code.length == 0 || c.collateral.code.length == 0 || c.usdg == c.collateral
                || c.guardian == address(0) || c.maxLtvBps == 0 || c.maxLtvBps >= c.liquidationLtvBps
                || c.liquidationLtvBps >= 10000 || c.bonusBps > 1500 || c.minimumDebt == 0
                || uint256(c.liquidationLtvBps) * (10000 + c.bonusBps) >= 10000 * 10000
                || IERC20Metadata(c.usdg).decimals() != 6 || IERC20Metadata(c.collateral).decimals() != 18
        ) revert InvalidConfiguration();
        usdg = IERC20(c.usdg);
        collateralToken = IERC20(c.collateral);
        maxLtvBps = c.maxLtvBps;
        liquidationLtvBps = c.liquidationLtvBps;
        bonusBps = c.bonusBps;
        minimumDebt = c.minimumDebt;
        _transferOwnership(c.guardian);
    }

    function bindPool(TurretVariableCapitalPool candidate) external onlyOwner {
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
            // Admission does not quote a loan. Every borrow and debt-bearing
            // collateral exit independently enforces current prices and policy.
            // Owner wallet delays therefore cannot expire an activation proof.
        }
        riskPaused = paused;
        emit RiskPaused(paused);
    }

    function scheduleDebtLimit(uint256 limit) external onlyOwner {
        _requirePool();
        pool.scheduleDebtLimit(limit);
    }

    function executeDebtLimit() external onlyOwner {
        _requirePool();
        pool.executeDebtLimit();
    }

    function cancelDebtLimit() external onlyOwner {
        _requirePool();
        pool.cancelDebtLimit();
    }

    function lowerDebtLimit(uint256 limit) external onlyOwner {
        _requirePool();
        pool.lowerDebtLimit(limit);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        // A successor must review and schedule its own cap increase.
        if (address(pool) != address(0)) pool.cancelDebtLimit();
        super.transferOwnership(newOwner);
    }

    /// @notice Close admission permanently without moving funds or forgiving debt.
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

    function price() public view virtual returns (uint256);

    /// @notice Risk-increasing actions may require stricter policy than liquidation.
    /// The generic token engine uses the same price; stock engines enforce a
    /// current trading-session approval here without making repayment depend on it.
    function borrowingPrice() public view virtual returns (uint256) {
        return price();
    }

    function positionDebt(address borrower) public view returns (uint256) {
        Position memory p = positions[borrower];
        if (p.principal == 0) return p.interest;
        (uint256 pending,) = _interest(borrower, p);
        return p.principal + p.interest + pending;
    }

    function activeBorrowerAt(uint256 index) external view returns (address) {
        return activeBorrowers[index];
    }

    struct PositionSnapshot {
        address borrower;
        uint256 collateral;
        uint256 principal;
        uint256 debt;
    }

    /// @notice Bounded keeper discovery without one RPC request per field/loan.
    /// All pages must use one canonical block; quotes are rechecked before execution.
    function activePositionPage(uint256 offset, uint256 limit)
        external
        view
        returns (PositionSnapshot[] memory result)
    {
        if (limit == 0 || limit > MAX_REGISTRY_PAGE) revert InvalidAmount();
        uint256 count = activeBorrowers.length;
        if (offset >= count) return new PositionSnapshot[](0);
        uint256 length = Math.min(limit, count - offset);
        result = new PositionSnapshot[](length);
        for (uint256 i; i < length; ++i) {
            address borrower = activeBorrowers[offset + i];
            Position storage p = positions[borrower];
            result[i] = PositionSnapshot(borrower, p.collateral, p.principal, positionDebt(borrower));
        }
    }

    /// @notice Capital entry/exit uses book value and available cash. A lender
    /// remaining when bad debt is recognized bears that loss; no borrower scan
    /// or price attestation delays an otherwise liquid withdrawal.
    function capitalOperationsAllowed() external view returns (bool) {
        return address(pool) != address(0) && !pool.liquidationSettlementActive();
    }

    function borrowIntentDigest(BorrowIntent calldata instruction) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DockyardBorrowIntent"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return
            keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(BORROW_INTENT_TYPEHASH, instruction))));
    }

    /// @notice Sign loan terms first; any submitter can attach current public
    /// proofs later. Funds always go to the signing owner, never the relayer.
    function executeBorrowIntent(BorrowIntent calldata instruction, bytes calldata signature, bytes calldata proof)
        external
        nonReentrant
    {
        if (
            instruction.owner == address(0) || instruction.owner == address(this)
                || instruction.nonce != borrowIntentNonces[instruction.owner]
                || instruction.deadline <= instruction.validAfter
                || instruction.deadline - instruction.validAfter > MAX_INTENT_LIFETIME
                || block.timestamp < instruction.validAfter || block.timestamp >= instruction.deadline
                || instruction.minPrice == 0
        ) revert InvalidBorrowIntent();
        bytes32 digest = borrowIntentDigest(instruction);
        if (!SignatureChecker.isValidSignatureNow(instruction.owner, digest, signature)) {
            revert InvalidBorrowSignature();
        }
        borrowIntentNonces[instruction.owner]++;
        if (instruction.action != 3 || positionDebt(instruction.owner) != 0) {
            _refreshExecutionProof(proof);
            if (borrowingPrice() < instruction.minPrice) revert Slippage();
        }
        if (instruction.action == 1) {
            _depositCollateralFrom(instruction.owner, instruction.owner, instruction.collateralAmount);
            _borrowFor(instruction.owner, instruction.debtAmount);
        } else if (instruction.action == 2 && instruction.collateralAmount == 0) {
            _borrowFor(instruction.owner, instruction.debtAmount);
        } else if (instruction.action == 3 && instruction.debtAmount == 0) {
            _withdrawCollateralFor(instruction.owner, instruction.collateralAmount, instruction.owner);
        } else {
            revert InvalidBorrowIntent();
        }
        if (positionDebt(instruction.owner) > instruction.maxDebt) revert Slippage();
        emit BorrowIntentExecuted(digest, instruction.owner, instruction.nonce, instruction.action);
    }

    /// @notice Cancels all lower nonces, including during an oracle outage.
    function invalidateBorrowIntents(uint256 nextNonce) external {
        if (nextNonce <= borrowIntentNonces[msg.sender]) revert InvalidBorrowIntent();
        borrowIntentNonces[msg.sender] = nextNonce;
        emit BorrowIntentsInvalidated(msg.sender, nextNonce);
    }

    function _refreshExecutionProof(bytes calldata proof) internal virtual {
        if (proof.length != 0) revert InvalidBorrowIntent();
    }

    function depositCollateral(address borrower, uint256 amount) external nonReentrant {
        _depositCollateral(borrower, amount);
    }

    function depositAndBorrow(uint256 collateralAmount, uint256 borrowAmount) external nonReentrant {
        _depositCollateral(msg.sender, collateralAmount);
        _borrow(borrowAmount);
    }

    function _depositCollateral(address borrower, uint256 amount) internal {
        _depositCollateralFrom(msg.sender, borrower, amount);
    }

    function _depositCollateralFrom(address payer, address borrower, uint256 amount) private {
        _requirePool();
        if (borrower == address(0) || borrower == address(this)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();
        if (retired && positions[borrower].principal + positions[borrower].interest == 0) revert MarketRetired();
        _pullExact(collateralToken, payer, amount);
        positions[borrower].collateral += amount;
        emit CollateralDeposited(borrower, payer, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        _borrow(amount);
    }

    function _borrow(uint256 amount) internal {
        _borrowFor(msg.sender, amount);
    }

    function _borrowFor(address borrower, uint256 amount) private {
        _requirePool();
        if (riskPaused) revert NotReady();
        if (amount == 0) revert InvalidAmount();
        Position storage p = positions[borrower];
        _settle(borrower, p);
        if (p.principal + p.interest + amount < minimumDebt) revert InvalidAmount();
        if (!_safe(p.collateral, p.principal + p.interest + amount, borrowingPrice(), maxLtvBps)) {
            revert UnsafePosition();
        }
        if (p.principal == 0) {
            activeBorrowers.push(borrower);
            activeIndex[borrower] = activeBorrowers.length;
            activeDebtPositions++;
        }
        p.principal += amount;
        pool.draw(borrower, amount);
        emit Borrowed(borrower, amount);
    }

    function withdrawCollateral(uint256 amount, address recipient) external nonReentrant {
        _withdrawCollateral(amount, recipient);
    }

    function _withdrawCollateral(uint256 amount, address recipient) internal {
        _withdrawCollateralFor(msg.sender, amount, recipient);
    }

    function _withdrawCollateralFor(address borrower, uint256 amount, address recipient) private {
        _requirePool();
        if (amount == 0) revert InvalidAmount();
        Position storage p = positions[borrower];
        _settle(borrower, p);
        if (amount > p.collateral) revert InvalidAmount();
        uint256 debt = p.principal + p.interest;
        if (debt != 0 && (riskPaused || !_safe(p.collateral - amount, debt, borrowingPrice(), maxLtvBps))) {
            revert UnsafePosition();
        }
        p.collateral -= amount;
        _sendExact(collateralToken, recipient, amount);
        emit CollateralWithdrawn(borrower, recipient, amount);
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
        _settle(borrower, p);
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
        return _executeLiquidation(borrower, maxRepay, minCollateral, false, "");
    }

    /// @notice Receive collateral, fund repayment in a callback, then settle
    /// atomically. No external route is trusted by the engine and no lender cash
    /// is advanced. Failure to deliver the exact USDG repayment reverts all steps.
    function liquidateWithCallback(address borrower, uint256 maxRepay, uint256 minCollateral, bytes calldata data)
        external
        nonReentrant
        returns (uint256 paid, uint256 seized)
    {
        return _liquidateWithCallback(borrower, maxRepay, minCollateral, data);
    }

    function _liquidateWithCallback(address borrower, uint256 maxRepay, uint256 minCollateral, bytes memory data)
        internal
        returns (uint256 paid, uint256 seized)
    {
        if (msg.sender.code.length == 0) revert InvalidRecipient();
        return _executeLiquidation(borrower, maxRepay, minCollateral, true, data);
    }

    function _executeLiquidation(
        address borrower,
        uint256 maxRepay,
        uint256 minCollateral,
        bool callback,
        bytes memory data
    ) private returns (uint256 paid, uint256 seized) {
        _requirePool();
        Position storage p = positions[borrower];
        _settle(borrower, p);
        uint256 debt = p.principal + p.interest;
        uint256 value = price();
        (paid, seized) = _liquidationQuote(p.collateral, debt, value, maxRepay);
        if (seized < minCollateral) revert Slippage();
        pool.beginLiquidationSettlement();
        p.collateral -= seized;
        if (callback) {
            _sendExact(collateralToken, msg.sender, seized);
            IDockyardLiquidationCallback(msg.sender).onDockyardLiquidation(borrower, paid, seized, data);
        }
        _repay(borrower, p, paid);
        if (p.collateral == 0 && p.principal + p.interest > 0) {
            pool.recognizeLoss(p.principal, p.interest);
            emit PositionLoss(borrower, p.principal, p.interest);
            p.principal = 0;
            p.interest = 0;
        }
        _finish(borrower, p);
        if (!callback) _sendExact(collateralToken, msg.sender, seized);
        pool.endLiquidationSettlement();
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
            if (paid < repayCap) {
                // Preserve both meaningful debt and collateral that can cover
                // the minimum repayment plus its bonus. Debt alone is not
                // enough: an insolvent loan can retain large debt but only a
                // micro-USDG of sellable collateral after a near-full exit.
                if (repayCap <= minimumDebt) revert InvalidAmount();
                uint256 reservedCollateral = _collateralForRepayment(minimumDebt, value);
                if (reservedCollateral >= collateral) revert InvalidAmount();
                paid =
                    Math.min(paid, Math.min(debt - minimumDebt, _coveredDebt(collateral - reservedCollateral, value)));
                if (paid == 0) revert InvalidAmount();
            }
            seized = Math.min(collateral, _collateralForRepayment(paid, value));
        }
        if (seized == 0) revert Slippage();
    }

    function _coveredDebt(uint256 collateral, uint256 value) private view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(collateral, value, 1e18), 10000, 10000 + bonusBps) / 1e12;
    }

    function _collateralForRepayment(uint256 paid, uint256 value) private view returns (uint256) {
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

    function _settle(address borrower, Position storage p) private {
        pool.accrueInterest();
        (uint256 interest, uint256 remainder) = _interest(borrower, p);
        p.interest += interest;
        p.remainder = remainder;
        p.updatedAt = block.timestamp;
        positionRateIntegral[borrower] = pool.currentRateIntegral();
    }

    function _interest(address borrower, Position memory p) private view returns (uint256 amount, uint256 remainder) {
        uint256 timeRate = pool.currentRateIntegral() - positionRateIntegral[borrower];
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
