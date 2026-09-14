// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {TurretP2PVaultV3} from "./TurretP2PVaultV3.sol";

/// @notice Local release-C candidate. One lender, one token pair, isolated loan custody.
/// @dev Not deployed or admitted by the production registry. See turret-p2p-facility-spec.md.
contract TurretLenderFacility is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    uint256 public constant GRACE_PERIOD = 1 days;
    uint256 public constant MAX_TIMESTAMP = 8_640_000_000_000;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 epoch,uint256 nonce,address borrower,uint256 capacity,uint256 minDraw,uint256 collateralForCapacity,uint256 interestForCapacity,uint256 duration,uint256 validAfter,uint256 expiresAt)"
    );

    struct Limits {
        uint256 maxExposure;
        uint256 minDraw;
        uint256 maxDraw;
        uint256 minDuration;
        uint256 maxDuration;
        uint256 maxQuoteLifetime;
        uint256 minCollateralPerPrincipalWad;
        uint256 minInterestBps;
    }
    struct Quote {
        uint256 epoch;
        uint256 nonce;
        address borrower;
        uint256 capacity;
        uint256 minDraw;
        uint256 collateralForCapacity;
        uint256 interestForCapacity;
        uint256 duration;
        uint256 validAfter;
        uint256 expiresAt;
    }
    struct QuoteUse { bytes32 digest; uint256 filled; bool cancelled; }
    enum Status { None, Active, Repaid, Defaulted }
    struct Loan {
        address borrower;
        address vault;
        uint256 principal;
        uint256 collateralAmount;
        uint256 interest;
        uint256 dueAt;
        uint256 lenderCredit;
        uint256 feeCredit;
        uint256 collateralCredit;
        Status status;
        bool defaultAcknowledged;
    }
    struct Extension {
        address proposer;
        uint256 nonce;
        uint256 oldDeadline;
        uint256 newDeadline;
        uint256 expiresAt;
    }

    IERC20 public immutable loanToken;
    IERC20 public immutable collateralToken;
    address public immutable lender;
    address public immutable feeRecipient;
    uint256 public immutable feeBps;
    address public immutable vaultImplementation;
    address public quoteSigner;
    Limits public limits;
    uint256 public epoch = 1;
    bool public newLoansPaused;
    uint256 public idleCash;
    uint256 public activePrincipal;
    uint256 public unresolvedDefaultPrincipal;
    uint256 public acknowledgedDefaultPrincipal;
    uint256 public idleCashWrittenOff;
    uint256 public repaymentWrittenOff;
    uint256 public nextLoanId = 1;
    mapping(uint256 => mapping(uint256 => QuoteUse)) public quoteUses;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => Extension) public extensions;
    mapping(uint256 => uint256) public extensionNonce;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidQuote();
    error InvalidSignature();
    error QuoteUnavailable();
    error BorrowerBoundsExceeded();
    error CapacityUnavailable();
    error NewLoansPaused();
    error UnsupportedTransfer();
    error InvalidWithdrawal();
    error WrongStatus();
    error DeadlinePassed();
    error TooEarly();
    error InvalidExtension();

    event PolicyChanged(uint256 indexed epoch, address indexed signer, Limits limits);
    event PauseChanged(bool paused);
    event QuoteCancelled(uint256 indexed epoch, uint256 indexed nonce);
    event Deposited(uint256 amount);
    event IdleWithdrawn(address indexed recipient, uint256 amount);
    event SurplusWithdrawn(address indexed recipient, uint256 amount);
    event IdleLossAcknowledged(uint256 amount);
    event LoanOpened(uint256 indexed id, address indexed borrower, bytes32 indexed quoteDigest,
        uint256 principal, uint256 collateralAmount, uint256 interest, uint256 dueAt, address vault);
    event LoanRepaid(uint256 indexed id, address indexed payer, uint256 lenderCredit, uint256 feeCredit);
    event LoanDefaulted(uint256 indexed id, uint256 principal);
    event RepaymentRecycled(uint256 indexed id, uint256 amount);
    event RepaymentWithdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event FeeCollected(uint256 indexed id, address indexed recipient, uint256 amount);
    event CollateralWithdrawn(uint256 indexed id, address indexed owner, address recipient, uint256 amount);
    event CreditWrittenOff(uint256 indexed id, address indexed token, uint256 amount);
    event DefaultAcknowledged(uint256 indexed id, uint256 principalBasis);
    event ExtensionProposed(uint256 indexed id, Extension proposal);
    event ExtensionCancelled(uint256 indexed id, uint256 nonce);
    event ExtensionAccepted(uint256 indexed id, uint256 nonce, uint256 newDeadline);

    modifier onlyLender() { if (msg.sender != lender) revert Unauthorized(); _; }

    constructor(IERC20 cash, IERC20 collateral, address owner, address recipient, uint256 protocolFeeBps, Limits memory initialLimits)
        EIP712("TurretLenderFacility", "1")
    {
        if (address(cash).code.length == 0 || address(collateral).code.length == 0 || cash == collateral
            || owner == address(0) || owner == address(this) || recipient == address(0)
            || recipient == address(this) || protocolFeeBps > 10_000) revert InvalidConfiguration();
        _validateLimits(initialLimits);
        loanToken = cash; collateralToken = collateral; lender = owner;
        feeRecipient = recipient; feeBps = protocolFeeBps; limits = initialLimits;
        vaultImplementation = address(new TurretP2PVaultV3(address(this), cash, collateral));
        emit PolicyChanged(epoch, address(0), initialLimits);
    }

    /// @notice Revokes every previous quote, including quotes signed directly by the lender.
    function setPolicy(Limits calldata next, address signer) external onlyLender nonReentrant {
        _validateLimits(next);
        if (signer == address(this)) revert InvalidConfiguration();
        limits = next; quoteSigner = signer; ++epoch;
        emit PolicyChanged(epoch, signer, next);
    }

    function setNewLoansPaused(bool paused) external onlyLender nonReentrant {
        newLoansPaused = paused;
        emit PauseChanged(paused);
    }

    function cancelQuote(uint256 nonce) external onlyLender nonReentrant {
        quoteUses[epoch][nonce].cancelled = true;
        emit QuoteCancelled(epoch, nonce);
    }

    function deposit(uint256 amount) external onlyLender nonReentrant {
        if (amount == 0 || loanToken.balanceOf(address(this)) < idleCash) revert CapacityUnavailable();
        _pullExact(loanToken, msg.sender, address(this), amount);
        idleCash += amount;
        emit Deposited(amount);
    }

    function withdrawIdle(uint256 amount, address recipient) external onlyLender nonReentrant {
        if (amount == 0 || amount > idleCash) revert InvalidWithdrawal();
        idleCash -= amount;
        _sendCash(recipient, amount);
        emit IdleWithdrawn(recipient, amount);
    }

    function withdrawSurplus(uint256 amount, address recipient) external onlyLender nonReentrant {
        uint256 actual = loanToken.balanceOf(address(this));
        if (actual < idleCash || amount == 0 || amount > actual - idleCash) revert InvalidWithdrawal();
        _sendCash(recipient, amount);
        emit SurplusWithdrawn(recipient, amount);
    }

    function acknowledgeIdleLoss() external onlyLender nonReentrant {
        uint256 actual = loanToken.balanceOf(address(this));
        if (actual >= idleCash) revert InvalidWithdrawal();
        uint256 loss = idleCash - actual;
        idleCash = actual; idleCashWrittenOff += loss;
        emit IdleLossAcknowledged(loss);
    }

    function quoteHash(Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, quote)));
    }

    /// @notice Current signature authority only; does not validate terms, expiry or available cash.
    /// @dev Shares draw's STATICCALL context for contract signers. Off-chain raw calls to a
    ///      signer's isValidSignature could otherwise accept a state-writing implementation.
    function isValidQuoteSignature(Quote calldata quote, bytes calldata signature) public view returns (bool) {
        bytes32 digest = quoteHash(quote);
        return SignatureChecker.isValidSignatureNow(lender, digest, signature)
            || (quoteSigner != address(0) && SignatureChecker.isValidSignatureNow(quoteSigner, digest, signature));
    }

    /// @notice Arithmetic only; this is not a promise of signature validity or remaining capital.
    function quoteTerms(Quote calldata quote, uint256 principal) public pure returns (uint256 collateral, uint256 interest) {
        if (principal == 0 || quote.capacity == 0 || principal > quote.capacity) revert InvalidQuote();
        collateral = Math.mulDiv(principal, quote.collateralForCapacity, quote.capacity, Math.Rounding.Up);
        interest = Math.mulDiv(principal, quote.interestForCapacity, quote.capacity, Math.Rounding.Up);
    }

    function draw(Quote calldata quote, bytes calldata signature, uint256 principal,
        uint256 maxCollateral, uint256 maxInterest, uint256 minRemainingCapacity)
        external nonReentrant returns (uint256 id)
    {
        if (newLoansPaused) revert NewLoansPaused();
        (uint256 collateral, uint256 interest) = _checkQuote(quote, principal);
        if (collateral > maxCollateral || interest > maxInterest) revert BorrowerBoundsExceeded();
        bytes32 digest = quoteHash(quote);
        if (!isValidQuoteSignature(quote, signature)) revert InvalidSignature();
        QuoteUse storage used = quoteUses[epoch][quote.nonce];
        if (used.cancelled || (used.filled != 0 && used.digest != digest)
            || used.filled > quote.capacity || principal > quote.capacity - used.filled
            || quote.capacity - used.filled < minRemainingCapacity) revert QuoteUnavailable();
        uint256 exposure = activePrincipal + unresolvedDefaultPrincipal;
        if (exposure > limits.maxExposure || principal > limits.maxExposure - exposure
            || principal > idleCash || loanToken.balanceOf(address(this)) < idleCash) revert CapacityUnavailable();
        used.digest = digest; used.filled += principal;
        idleCash -= principal; activePrincipal += principal;
        id = nextLoanId++;
        address vault = Clones.clone(vaultImplementation);
        Loan storage loan = loans[id];
        loan.borrower = msg.sender; loan.vault = vault; loan.principal = principal;
        loan.collateralAmount = collateral; loan.interest = interest;
        loan.dueAt = block.timestamp + quote.duration; loan.status = Status.Active;
        _pullExact(collateralToken, msg.sender, vault, collateral);
        _sendCash(msg.sender, principal);
        emit LoanOpened(id, msg.sender, digest, principal, collateral, interest, loan.dueAt, vault);
    }

    function repay(uint256 id) external nonReentrant {
        Loan storage loan = loans[id];
        if (loan.status != Status.Active) revert WrongStatus();
        if (block.timestamp > loan.dueAt + GRACE_PERIOD) revert DeadlinePassed();
        loan.status = Status.Repaid; activePrincipal -= loan.principal;
        loan.feeCredit = Math.mulDiv(loan.interest, feeBps, 10_000);
        loan.lenderCredit = loan.principal + loan.interest - loan.feeCredit;
        loan.collateralCredit = loan.collateralAmount;
        _pullExact(loanToken, msg.sender, loan.vault, loan.principal + loan.interest);
        emit LoanRepaid(id, msg.sender, loan.lenderCredit, loan.feeCredit);
    }

    function claimDefault(uint256 id) external nonReentrant {
        Loan storage loan = loans[id];
        if (loan.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= loan.dueAt + GRACE_PERIOD) revert TooEarly();
        loan.status = Status.Defaulted; activePrincipal -= loan.principal;
        unresolvedDefaultPrincipal += loan.principal;
        loan.collateralCredit = loan.collateralAmount;
        emit LoanDefaulted(id, loan.principal);
    }

    /// @notice Anyone may return recovered lender cash to this facility, never to themselves.
    function recycleRepayment(uint256 id) external nonReentrant returns (uint256 amount) {
        Loan storage loan = loans[id];
        amount = availableRepayment(id);
        if (amount == 0 || loanToken.balanceOf(address(this)) < idleCash) revert CapacityUnavailable();
        loan.lenderCredit -= amount;
        _vaultSend(loan, loanToken, address(this), amount);
        idleCash += amount;
        emit RepaymentRecycled(id, amount);
    }

    function withdrawRepayment(uint256 id, uint256 amount, address recipient) external onlyLender nonReentrant {
        Loan storage loan = loans[id];
        if (amount == 0 || amount > availableRepayment(id) || recipient == address(this)) revert InvalidWithdrawal();
        loan.lenderCredit -= amount;
        _vaultSend(loan, loanToken, recipient, amount);
        emit RepaymentWithdrawn(id, recipient, amount);
    }

    function collectFee(uint256 id) external nonReentrant returns (uint256 amount) {
        Loan storage loan = loans[id];
        amount = availableFee(id);
        if (amount == 0) revert InvalidWithdrawal();
        loan.feeCredit -= amount;
        _vaultSend(loan, loanToken, feeRecipient, amount);
        emit FeeCollected(id, feeRecipient, amount);
    }

    function withdrawCollateral(uint256 id, uint256 amount, address recipient) external nonReentrant {
        Loan storage loan = loans[id];
        if (msg.sender != collateralOwner(id)) revert Unauthorized();
        if (amount == 0 || amount > availableCollateral(id) || recipient == address(this)) revert InvalidWithdrawal();
        loan.collateralCredit -= amount;
        _vaultSend(loan, collateralToken, recipient, amount);
        emit CollateralWithdrawn(id, msg.sender, recipient, amount);
    }

    function writeOffRepayment(uint256 id) external onlyLender nonReentrant {
        Loan storage loan = loans[id];
        uint256 available = availableRepayment(id);
        if (available >= loan.lenderCredit) revert InvalidWithdrawal();
        uint256 loss = loan.lenderCredit - available;
        loan.lenderCredit = available; repaymentWrittenOff += loss;
        emit CreditWrittenOff(id, address(loanToken), loss);
    }

    function writeOffCollateral(uint256 id) external nonReentrant {
        Loan storage loan = loans[id];
        if (msg.sender != collateralOwner(id)) revert Unauthorized();
        uint256 available = availableCollateral(id);
        if (available >= loan.collateralCredit) revert InvalidWithdrawal();
        uint256 loss = loan.collateralCredit - available;
        loan.collateralCredit = available;
        emit CreditWrittenOff(id, address(collateralToken), loss);
    }

    function acknowledgeDefault(uint256 id) external onlyLender nonReentrant {
        Loan storage loan = loans[id];
        if (loan.status != Status.Defaulted || loan.defaultAcknowledged || loan.collateralCredit != 0) revert WrongStatus();
        loan.defaultAcknowledged = true;
        unresolvedDefaultPrincipal -= loan.principal;
        acknowledgedDefaultPrincipal += loan.principal;
        emit DefaultAcknowledged(id, loan.principal);
    }

    function proposeExtension(uint256 id, uint256 newDeadline, uint256 expiresAt) external nonReentrant {
        Loan storage loan = loans[id];
        if (msg.sender != lender && msg.sender != loan.borrower) revert Unauthorized();
        if (loan.status != Status.Active) revert WrongStatus();
        uint256 oldDeadline = loan.dueAt + GRACE_PERIOD;
        if (newDeadline <= oldDeadline || newDeadline <= block.timestamp || newDeadline > MAX_TIMESTAMP
            || expiresAt <= block.timestamp || expiresAt > newDeadline) revert InvalidExtension();
        Extension memory proposal = Extension(msg.sender, ++extensionNonce[id], oldDeadline, newDeadline, expiresAt);
        extensions[id] = proposal;
        emit ExtensionProposed(id, proposal);
    }

    function cancelExtension(uint256 id) external nonReentrant {
        if (msg.sender != extensions[id].proposer) revert Unauthorized();
        uint256 nonce = extensions[id].nonce;
        delete extensions[id];
        emit ExtensionCancelled(id, nonce);
    }

    function acceptExtension(uint256 id, uint256 nonce, uint256 oldDeadline, uint256 newDeadline, uint256 expiresAt) external nonReentrant {
        Loan storage loan = loans[id];
        Extension memory proposal = extensions[id];
        if ((msg.sender != lender && msg.sender != loan.borrower) || msg.sender == proposal.proposer) revert Unauthorized();
        if (loan.status != Status.Active) revert WrongStatus();
        if (proposal.proposer == address(0) || proposal.nonce != nonce || proposal.oldDeadline != oldDeadline
            || proposal.newDeadline != newDeadline || proposal.expiresAt != expiresAt
            || block.timestamp >= expiresAt || block.timestamp >= newDeadline || loan.dueAt + GRACE_PERIOD != oldDeadline) revert InvalidExtension();
        loan.dueAt = newDeadline - GRACE_PERIOD;
        delete extensions[id];
        emit ExtensionAccepted(id, nonce, newDeadline);
    }

    function repaymentDeadline(uint256 id) external view returns (uint256) {
        return loans[id].status == Status.None ? 0 : loans[id].dueAt + GRACE_PERIOD;
    }

    function availableRepayment(uint256 id) public view returns (uint256) {
        Loan storage loan = loans[id];
        return loan.lenderCredit == 0 ? 0 : Math.min(loan.lenderCredit, loanToken.balanceOf(loan.vault));
    }

    /// @notice Lender claims have priority over fees after loss of USDG backing in this vault.
    function availableFee(uint256 id) public view returns (uint256) {
        Loan storage loan = loans[id];
        if (loan.feeCredit == 0) return 0;
        uint256 balance = loanToken.balanceOf(loan.vault);
        return balance <= loan.lenderCredit ? 0 : Math.min(loan.feeCredit, balance - loan.lenderCredit);
    }

    function availableCollateral(uint256 id) public view returns (uint256) {
        Loan storage loan = loans[id];
        return loan.collateralCredit == 0 ? 0 : Math.min(loan.collateralCredit, collateralToken.balanceOf(loan.vault));
    }

    function collateralOwner(uint256 id) public view returns (address) {
        Loan storage loan = loans[id];
        if (loan.status == Status.Repaid) return loan.borrower;
        if (loan.status == Status.Defaulted) return lender;
        return address(0);
    }

    function _checkQuote(Quote calldata quote, uint256 principal) private view returns (uint256 collateral, uint256 interest) {
        if (quote.epoch != epoch || msg.sender == lender || (quote.borrower != address(0) && quote.borrower != msg.sender)
            || quote.borrower == address(this) || quote.capacity == 0 || quote.minDraw == 0 || quote.minDraw > quote.capacity
            || quote.collateralForCapacity == 0 || quote.interestForCapacity > type(uint256).max - quote.capacity
            || quote.validAfter > block.timestamp || quote.expiresAt <= block.timestamp || quote.expiresAt <= quote.validAfter
            || quote.expiresAt - quote.validAfter > limits.maxQuoteLifetime
            || quote.expiresAt > MAX_TIMESTAMP - GRACE_PERIOD
            || quote.duration > MAX_TIMESTAMP - GRACE_PERIOD - quote.expiresAt
            || quote.duration < limits.minDuration || quote.duration > limits.maxDuration || quote.duration % 1 days != 0
            || principal < quote.minDraw || principal < limits.minDraw || principal > limits.maxDraw) revert InvalidQuote();
        (collateral, interest) = quoteTerms(quote, principal);
        if (collateral < Math.mulDiv(principal, limits.minCollateralPerPrincipalWad, 1e18, Math.Rounding.Up)
            || interest < Math.mulDiv(principal, limits.minInterestBps, 10_000, Math.Rounding.Up)) revert InvalidQuote();
    }

    function _validateLimits(Limits memory policy) private pure {
        if (policy.maxExposure == 0 || policy.minDraw == 0 || policy.minDraw > policy.maxDraw
            || policy.maxDraw > policy.maxExposure || policy.minDuration == 0 || policy.minDuration % 1 days != 0
            || policy.maxDuration < policy.minDuration || policy.maxDuration % 1 days != 0 || policy.maxDuration > MAX_TIMESTAMP - GRACE_PERIOD
            || policy.maxQuoteLifetime == 0 || policy.minCollateralPerPrincipalWad == 0 || policy.minInterestBps > 10_000) revert InvalidConfiguration();
    }

    function _pullExact(IERC20 token, address from, address to, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(from);
        uint256 recipientBefore = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        if (token.balanceOf(from) != senderBefore - amount || token.balanceOf(to) != recipientBefore + amount) revert UnsupportedTransfer();
    }

    function _sendCash(address recipient, uint256 amount) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidWithdrawal();
        uint256 beforeFacility = loanToken.balanceOf(address(this));
        uint256 beforeRecipient = loanToken.balanceOf(recipient);
        loanToken.safeTransfer(recipient, amount);
        if (loanToken.balanceOf(address(this)) != beforeFacility - amount || loanToken.balanceOf(recipient) != beforeRecipient + amount) revert UnsupportedTransfer();
    }

    function _vaultSend(Loan storage loan, IERC20 token, address recipient, uint256 amount) private {
        TurretP2PVaultV3(loan.vault).transferTo(token, recipient, amount);
    }
}
