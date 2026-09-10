// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {EnumerableSet} from "openzeppelin-contracts/contracts/utils/structs/EnumerableSet.sol";
import {TurretP2PVaultV3} from "./TurretP2PVaultV3.sol";

/// @notice Internally reviewed, unaudited fixed-term P2P lending with isolated offer custody.
/// @dev Each offer gets its own non-upgradeable clone before funding. Token losses are borne
///      solely by that offer's eventual beneficiary. No administrator can move custody or
///      change loan terms. Only exact-transfer, non-rebasing tokens are supported.
contract TurretP2PLendingV3 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    uint256 public constant GRACE_PERIOD = 1 days;
    uint256 public constant MAX_PAGE_SIZE = 50;
    uint256 public constant MAX_CREDIT_SOURCES = 16;
    uint256 public constant MAX_TIMESTAMP = 8_640_000_000_000;
    enum Status { None, Open, Active, Repaid, Defaulted, Cancelled, Expired }
    struct Offer {
        address lender;
        address borrower;
        uint256 principal;
        uint256 collateralAmount;
        uint256 interest;
        uint256 duration;
        uint256 expiresAt;
        uint256 dueAt;
        Status status;
    }
    struct ExtensionProposal {
        address proposer;
        uint256 nonce;
        uint256 oldDeadline;
        uint256 newDeadline;
        uint256 expiresAt;
    }

    IERC20 public immutable loanToken;
    IERC20 public immutable collateralToken;
    address public immutable vaultImplementation;
    address public guardian;
    address public pendingGuardian;
    bool public newLoansPaused;
    uint256 public nextOfferId = 1;
    /// @notice Nominal amounts, not manager custody or guaranteed token backing.
    uint256 public committedPrincipal;
    uint256 public reservedPrincipal;
    uint256 public lockedCollateral;
    mapping(uint256 => Offer) public offers;
    mapping(uint256 => address) public vaults;
    mapping(uint256 => bool) public isPublicOffer;
    mapping(uint256 => uint64) public offerCreatedAt;
    /// @notice Nominal credits only. Use loanCredit(id,token) for actual spendable backing.
    mapping(address => mapping(address => uint256)) public credits;
    mapping(address => uint256) public totalCredits;
    mapping(uint256 => mapping(address => uint256)) private _loanCredits;
    mapping(address => uint256[]) private _accountOfferIds;
    mapping(address => uint256[]) private _incomingOfferIds;
    uint256[] private _publicOfferIds;
    mapping(address => EnumerableSet.UintSet) private _activeLoanIds;
    mapping(address => uint256) public activeLoanRevision;
    mapping(uint256 => ExtensionProposal) public extensionProposals;
    mapping(uint256 => uint256) public extensionNonce;

    error InvalidConfiguration();
    error InvalidTerms();
    error NewLoansPaused();
    error Unauthorized();
    error WrongStatus();
    error OfferExpired();
    error TooEarly();
    error RepaymentDeadlinePassed();
    error InvalidPagination();
    error StalePagination();
    error UnsupportedTransfer();
    error InvalidWithdrawal();
    error InsufficientBacking();
    error InvalidCreditSources();
    error InvalidExtension();

    // Original lifecycle events remain available to existing acceptance/settlement indexers.
    event OfferCreated(uint256 indexed id, address indexed lender, address indexed borrower,
        uint256 principal, uint256 collateralAmount, uint256 interest, uint256 duration, uint256 expiresAt);
    event OfferAccepted(uint256 indexed id, uint256 dueAt, uint256 repaymentDeadline);
    event OfferClosed(uint256 indexed id, Status status);
    event LoanRepaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LoanDefaulted(uint256 indexed id);
    event CreditAdded(address indexed token, address indexed account, uint256 amount);
    event Withdrawn(address indexed token, address indexed account, address indexed recipient, uint256 amount);
    event NewLoansPauseChanged(bool paused);
    event VaultCreated(uint256 indexed id, address indexed vault);
    event LoanActivated(uint256 indexed id, address indexed lender, address indexed borrower);
    event LoanSettled(uint256 indexed id, address indexed lender, address indexed borrower, Status status);
    event LoanCreditAdded(uint256 indexed id, address indexed token, address indexed account, uint256 amount);
    event LoanCreditSpent(uint256 indexed sourceId, uint256 indexed targetId, address indexed payer, uint256 amount);
    event LoanCreditWithdrawn(uint256 indexed id, address indexed token, address indexed account,
        address recipient, uint256 amount, uint256 writtenOff);
    event ExtensionProposed(uint256 indexed id, address indexed proposer, uint256 nonce,
        uint256 oldDeadline, uint256 newDeadline, uint256 expiresAt);
    event ExtensionCancelled(uint256 indexed id, uint256 nonce);
    event ExtensionAccepted(uint256 indexed id, address indexed accepter, uint256 nonce,
        uint256 oldDeadline, uint256 newDeadline);
    event GuardianNominated(address indexed guardian, address indexed pendingGuardian);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    constructor(IERC20 loanToken_, IERC20 collateralToken_, address guardian_) {
        if (address(loanToken_).code.length == 0 || address(collateralToken_).code.length == 0
            || loanToken_ == collateralToken_ || guardian_ == address(0) || guardian_ == address(this)) {
            revert InvalidConfiguration();
        }
        loanToken = loanToken_;
        collateralToken = collateralToken_;
        guardian = guardian_;
        vaultImplementation = address(new TurretP2PVaultV3(address(this), loanToken_, collateralToken_));
    }

    function createOffer(address borrower, uint256 principal, uint256 collateralAmount,
        uint256 interest, uint256 duration, uint256 expiresAt) external nonReentrant returns (uint256 id) {
        if (newLoansPaused) revert NewLoansPaused();
        if (borrower == address(this) || borrower == msg.sender
            || principal == 0 || collateralAmount == 0 || interest > type(uint256).max - principal
            || duration == 0 || duration % 1 days != 0
            || expiresAt <= block.timestamp || expiresAt > MAX_TIMESTAMP - GRACE_PERIOD
            || duration > MAX_TIMESTAMP - GRACE_PERIOD - expiresAt) revert InvalidTerms();
        id = nextOfferId++;
        offers[id] = Offer(msg.sender, borrower, principal, collateralAmount, interest, duration, expiresAt, 0, Status.Open);
        offerCreatedAt[id] = uint64(block.timestamp);
        address vault = Clones.clone(vaultImplementation);
        vaults[id] = vault;
        _accountOfferIds[msg.sender].push(id);
        if (borrower == address(0)) {
            isPublicOffer[id] = true;
            _publicOfferIds.push(id);
        } else {
            _incomingOfferIds[borrower].push(id);
        }
        committedPrincipal += principal;
        reservedPrincipal += principal;
        _pullToExact(loanToken, msg.sender, vault, principal);
        emit VaultCreated(id, vault);
        emit OfferCreated(id, msg.sender, borrower, principal, collateralAmount, interest, duration, expiresAt);
    }

    function acceptOffer(uint256 id) external nonReentrant {
        if (newLoansPaused) revert NewLoansPaused();
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (msg.sender == offer.lender || (offer.borrower != address(0) && msg.sender != offer.borrower)) revert Unauthorized();
        if (block.timestamp >= offer.expiresAt) revert OfferExpired();
        address vault = vaults[id];
        if (loanToken.balanceOf(vault) < offer.principal) revert InsufficientBacking();
        offer.borrower = msg.sender;
        _accountOfferIds[msg.sender].push(id);
        offer.status = Status.Active;
        offer.dueAt = block.timestamp + offer.duration;
        reservedPrincipal -= offer.principal;
        lockedCollateral += offer.collateralAmount;
        _addActive(offer.lender, id);
        _addActive(msg.sender, id);
        _pullToExact(collateralToken, msg.sender, vault, offer.collateralAmount);
        TurretP2PVaultV3(vault).transferTo(loanToken, msg.sender, offer.principal);
        emit OfferAccepted(id, offer.dueAt, offer.dueAt + GRACE_PERIOD);
        emit LoanActivated(id, offer.lender, msg.sender);
    }

    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (msg.sender != offer.lender) revert Unauthorized();
        _closeOffer(id, offer, Status.Cancelled);
    }

    function expireOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (block.timestamp < offer.expiresAt) revert TooEarly();
        _closeOffer(id, offer, Status.Expired);
    }

    /// @notice Settle the full agreed debt from the caller's wallet. Credit withdrawal is separate.
    /// @dev Repayment does not promise restoration of collateral externally removed by its issuer.
    function repay(uint256 id) external nonReentrant {
        Offer storage offer = _repayable(id);
        uint256 repayment = offer.principal + offer.interest;
        _pullToExact(loanToken, msg.sender, vaults[id], repayment);
        _finishRepayment(id, offer, repayment);
    }

    /// @notice Settle in full using selected caller-owned USDG credits and an exact wallet amount.
    /// @dev Source IDs are strictly increasing. Predonated target funds never count as repayment.
    ///      Every source transfer, wallet transfer and state change reverts together on failure.
    function repayWithCredits(uint256 id, uint256[] calldata sourceIds, uint256[] calldata sourceAmounts,
        uint256 walletAmount) external nonReentrant {
        Offer storage offer = _repayable(id);
        if (sourceIds.length != sourceAmounts.length || sourceIds.length > MAX_CREDIT_SOURCES) revert InvalidCreditSources();
        uint256 repayment = offer.principal + offer.interest;
        uint256 creditAmount;
        for (uint256 i; i < sourceIds.length; ++i) {
            if (sourceIds[i] == 0 || sourceIds[i] == id || sourceAmounts[i] == 0
                || (i > 0 && sourceIds[i] <= sourceIds[i - 1])) revert InvalidCreditSources();
            creditAmount += sourceAmounts[i];
        }
        if (creditAmount > repayment || walletAmount != repayment - creditAmount) revert InvalidCreditSources();
        address target = vaults[id];
        uint256 beforeTarget = loanToken.balanceOf(target);
        for (uint256 i; i < sourceIds.length; ++i) {
            _spendCredit(sourceIds[i], loanToken, sourceAmounts[i]);
            TurretP2PVaultV3(vaults[sourceIds[i]]).transferTo(loanToken, target, sourceAmounts[i]);
            emit LoanCreditSpent(sourceIds[i], id, msg.sender, sourceAmounts[i]);
        }
        if (walletAmount != 0) _pullToExact(loanToken, msg.sender, target, walletAmount);
        if (loanToken.balanceOf(target) != beforeTarget + repayment) revert UnsupportedTransfer();
        _finishRepayment(id, offer, repayment);
    }

    function claimDefault(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= offer.dueAt + GRACE_PERIOD) revert TooEarly();
        offer.status = Status.Defaulted;
        committedPrincipal -= offer.principal;
        lockedCollateral -= offer.collateralAmount;
        _credit(id, collateralToken, offer.lender, offer.collateralAmount);
        _settled(id, offer);
        emit LoanDefaulted(id);
    }

    /// @notice The named beneficiary's nominal claim and currently transferable backing.
    function loanCredit(uint256 id, IERC20 token) public view returns (address beneficiary, uint256 nominal, uint256 available) {
        beneficiary = _beneficiary(id, token);
        nominal = _loanCredits[id][address(token)];
        if (nominal != 0) {
            uint256 balance = token.balanceOf(vaults[id]);
            available = balance < nominal ? balance : nominal;
        }
    }

    /// @notice Withdraw an exact backed portion of your own claim; any remaining claim is preserved.
    function withdrawCredit(uint256 id, IERC20 token, uint256 amount, address recipient) external nonReentrant {
        _validRecipient(recipient);
        _spendCredit(id, token, amount);
        TurretP2PVaultV3(vaults[id]).transferTo(token, recipient, amount);
        emit Withdrawn(address(token), msg.sender, recipient, amount);
        emit LoanCreditWithdrawn(id, address(token), msg.sender, recipient, amount, 0);
    }

    /// @notice Explicitly close your entire claim, withdrawing available tokens and writing off loss.
    /// @dev minReceived protects against a changed balance between review and execution. Zero payout
    ///      is possible only when caller explicitly permits minReceived=0. Other vaults are untouched.
    function withdrawAvailableCredit(uint256 id, IERC20 token, uint256 minReceived, address recipient) external nonReentrant {
        _validRecipient(recipient);
        (address beneficiary, uint256 nominal, uint256 available) = loanCredit(id, token);
        if (beneficiary != msg.sender) revert Unauthorized();
        if (nominal == 0 || available < minReceived) revert InvalidWithdrawal();
        _debitCredit(id, token, nominal);
        if (available != 0) TurretP2PVaultV3(vaults[id]).transferTo(token, recipient, available);
        emit Withdrawn(address(token), msg.sender, recipient, available);
        emit LoanCreditWithdrawn(id, address(token), msg.sender, recipient, available, nominal - available);
    }

    function proposeExtension(uint256 id, uint256 newDeadline, uint256 expiresAt) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (msg.sender != offer.borrower && msg.sender != offer.lender) revert Unauthorized();
        uint256 oldDeadline = offer.dueAt + GRACE_PERIOD;
        if (newDeadline <= oldDeadline || newDeadline > MAX_TIMESTAMP || expiresAt <= block.timestamp
            || expiresAt > newDeadline || newDeadline <= block.timestamp) revert InvalidExtension();
        uint256 nonce = ++extensionNonce[id];
        extensionProposals[id] = ExtensionProposal(msg.sender, nonce, oldDeadline, newDeadline, expiresAt);
        emit ExtensionProposed(id, msg.sender, nonce, oldDeadline, newDeadline, expiresAt);
    }

    /// @notice The other loan party accepts exactly the proposed final deadline; interest is unchanged.
    function acceptExtension(uint256 id, uint256 nonce, uint256 oldDeadline, uint256 newDeadline,
        uint256 expiresAt) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        ExtensionProposal memory proposal = extensionProposals[id];
        if (msg.sender == proposal.proposer || (msg.sender != offer.borrower && msg.sender != offer.lender)) revert Unauthorized();
        if (proposal.proposer == address(0) || proposal.nonce != nonce || proposal.oldDeadline != oldDeadline
            || proposal.newDeadline != newDeadline || proposal.expiresAt != expiresAt
            || offer.dueAt + GRACE_PERIOD != oldDeadline || block.timestamp >= expiresAt) revert InvalidExtension();
        delete extensionProposals[id];
        offer.dueAt = newDeadline - GRACE_PERIOD;
        emit ExtensionAccepted(id, msg.sender, nonce, oldDeadline, newDeadline);
    }

    function cancelExtension(uint256 id, uint256 nonce) external nonReentrant {
        ExtensionProposal memory proposal = extensionProposals[id];
        if (proposal.proposer != msg.sender) revert Unauthorized();
        if (proposal.nonce != nonce) revert InvalidExtension();
        delete extensionProposals[id];
        emit ExtensionCancelled(id, nonce);
    }

    function setNewLoansPaused(bool paused) external nonReentrant {
        if (msg.sender != guardian) revert Unauthorized();
        newLoansPaused = paused;
        emit NewLoansPauseChanged(paused);
    }

    function nominateGuardian(address replacement) external nonReentrant {
        if (msg.sender != guardian) revert Unauthorized();
        if (replacement == address(0) || replacement == address(this) || replacement == guardian) revert InvalidConfiguration();
        pendingGuardian = replacement;
        emit GuardianNominated(guardian, replacement);
    }

    function cancelGuardianNomination() external nonReentrant {
        if (msg.sender != guardian) revert Unauthorized();
        pendingGuardian = address(0);
        emit GuardianNominated(guardian, address(0));
    }

    function acceptGuardian() external nonReentrant {
        if (msg.sender != pendingGuardian) revert Unauthorized();
        address previous = guardian;
        guardian = msg.sender;
        pendingGuardian = address(0);
        emit GuardianChanged(previous, msg.sender);
    }

    function repaymentDeadline(uint256 id) external view returns (uint256) {
        uint256 dueAt = offers[id].dueAt;
        return dueAt == 0 ? 0 : dueAt + GRACE_PERIOD;
    }

    function getAccountOfferIds(address account, uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor) {
        return _page(_accountOfferIds[account], cursor, limit);
    }

    function getIncomingOfferIds(address account, uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor) {
        return _page(_incomingOfferIds[account], cursor, limit);
    }

    function getPublicOfferIds(uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor) {
        return _page(_publicOfferIds, cursor, limit);
    }

    /// @notice Revision-checked active set pagination. Restart on any revision change.
    /// @dev expectedRevision=0 permits only the initial cursor=0 request. Read all pages at one
    ///      canonical block or pass the returned revision to reject concurrent set mutations.
    function getActiveLoanIds(address account, uint256 cursor, uint256 limit, uint256 expectedRevision)
        external view returns (uint256[] memory ids, uint256 nextCursor, uint256 revision) {
        revision = activeLoanRevision[account];
        if ((expectedRevision == 0 && cursor != 0) || (expectedRevision != 0 && expectedRevision != revision)) revert StalePagination();
        EnumerableSet.UintSet storage source = _activeLoanIds[account];
        if (limit == 0 || limit > MAX_PAGE_SIZE || cursor > source.length()) revert InvalidPagination();
        uint256 count = source.length() - cursor;
        if (count > limit) count = limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = source.at(cursor + i);
        nextCursor = cursor + count == source.length() ? 0 : cursor + count;
    }

    function _repayable(uint256 id) private view returns (Offer storage offer) {
        offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp > offer.dueAt + GRACE_PERIOD) revert RepaymentDeadlinePassed();
    }

    function _finishRepayment(uint256 id, Offer storage offer, uint256 repayment) private {
        offer.status = Status.Repaid;
        committedPrincipal -= offer.principal;
        lockedCollateral -= offer.collateralAmount;
        _credit(id, loanToken, offer.lender, repayment);
        _credit(id, collateralToken, offer.borrower, offer.collateralAmount);
        _settled(id, offer);
        emit LoanRepaid(id, msg.sender, repayment);
    }

    function _settled(uint256 id, Offer storage offer) private {
        _activeLoanIds[offer.lender].remove(id);
        _activeLoanIds[offer.borrower].remove(id);
        ++activeLoanRevision[offer.lender];
        ++activeLoanRevision[offer.borrower];
        delete extensionProposals[id];
        emit LoanSettled(id, offer.lender, offer.borrower, offer.status);
    }

    function _addActive(address account, uint256 id) private {
        _activeLoanIds[account].add(id);
        ++activeLoanRevision[account];
    }

    function _page(uint256[] storage source, uint256 cursor, uint256 limit)
        private view returns (uint256[] memory ids, uint256 nextCursor) {
        if (limit == 0 || limit > MAX_PAGE_SIZE || cursor > source.length) revert InvalidPagination();
        uint256 end = cursor == 0 ? source.length : cursor;
        uint256 count = end < limit ? end : limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = source[end - 1 - i];
        nextCursor = end - count;
    }

    function _closeOffer(uint256 id, Offer storage offer, Status status) private {
        offer.status = status;
        committedPrincipal -= offer.principal;
        reservedPrincipal -= offer.principal;
        _credit(id, loanToken, offer.lender, offer.principal);
        emit OfferClosed(id, status);
    }

    function _credit(uint256 id, IERC20 token, address account, uint256 amount) private {
        _loanCredits[id][address(token)] += amount;
        credits[address(token)][account] += amount;
        totalCredits[address(token)] += amount;
        emit CreditAdded(address(token), account, amount);
        emit LoanCreditAdded(id, address(token), account, amount);
    }

    function _beneficiary(uint256 id, IERC20 token) private view returns (address) {
        Offer storage offer = offers[id];
        if (token == loanToken && (offer.status == Status.Repaid || offer.status == Status.Cancelled || offer.status == Status.Expired)) return offer.lender;
        if (token == collateralToken && offer.status == Status.Repaid) return offer.borrower;
        if (token == collateralToken && offer.status == Status.Defaulted) return offer.lender;
        return address(0);
    }

    function _spendCredit(uint256 id, IERC20 token, uint256 amount) private {
        (address beneficiary, uint256 nominal, uint256 available) = loanCredit(id, token);
        if (beneficiary != msg.sender) revert Unauthorized();
        if (amount == 0 || amount > nominal) revert InvalidWithdrawal();
        if (amount > available) revert InsufficientBacking();
        _debitCredit(id, token, amount);
    }

    function _debitCredit(uint256 id, IERC20 token, uint256 amount) private {
        _loanCredits[id][address(token)] -= amount;
        credits[address(token)][msg.sender] -= amount;
        totalCredits[address(token)] -= amount;
    }

    function _validRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) revert InvalidWithdrawal();
    }

    function _pullToExact(IERC20 token, address from, address vault, uint256 amount) private {
        uint256 beforeSender = token.balanceOf(from);
        uint256 beforeVault = token.balanceOf(vault);
        token.safeTransferFrom(from, vault, amount);
        if (token.balanceOf(vault) != beforeVault + amount
            || token.balanceOf(from) != beforeSender - amount) revert UnsupportedTransfer();
    }
}
