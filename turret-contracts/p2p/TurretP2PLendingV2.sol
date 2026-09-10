// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

/// @notice Unaudited prototype for fixed-term, permissionless, collateral-forfeiture loans.
/// @dev One immutable token pair per deployment. No pool funds, oracles, swaps, proxy,
///      transferable claims, or partial fills. A default is settled entirely in collateral.
///      Only qualified, non-rebasing, exact-transfer ERC20 tokens may be used.
contract TurretP2PLendingV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant GRACE_PERIOD = 1 days;
    uint256 public constant MAX_PAGE_SIZE = 50;
    /// @notice Latest Unix second representable by JavaScript Date (milliseconds / 1000).
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

    IERC20 public immutable loanToken;
    IERC20 public immutable collateralToken;
    address public immutable guardian;
    /// @notice Visibility is permanent even after a public offer binds its borrower.
    mapping(uint256 => bool) public isPublicOffer;
    mapping(uint256 => uint64) public offerCreatedAt;
    mapping(address => uint256[]) private _accountOfferIds;
    uint256[] private _publicOfferIds;

    bool public newLoansPaused;
    uint256 public nextOfferId = 1;
    /// @notice Principal in open offers plus active loans. Credits awaiting withdrawal excluded.
    uint256 public committedPrincipal;
    uint256 public reservedPrincipal;
    uint256 public lockedCollateral;
    mapping(uint256 => Offer) public offers;
    mapping(address => mapping(address => uint256)) public credits;
    mapping(address => uint256) public totalCredits;

    error InvalidConfiguration();
    error InvalidTerms();
    error NewLoansPaused();
    error Unauthorized();
    error WrongStatus();
    error OfferExpired();
    error TooEarly();
    error RepaymentDeadlinePassed();
    error InvalidPagination();
    error UnsupportedTransfer();
    error InvalidWithdrawal();

    event OfferCreated(uint256 indexed id, address indexed lender, address indexed borrower,
        uint256 principal, uint256 collateralAmount, uint256 interest, uint256 duration, uint256 expiresAt);
    event OfferAccepted(uint256 indexed id, uint256 dueAt, uint256 repaymentDeadline);
    event OfferClosed(uint256 indexed id, Status status);
    event LoanRepaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LoanDefaulted(uint256 indexed id);
    event CreditAdded(address indexed token, address indexed account, uint256 amount);
    event Withdrawn(address indexed token, address indexed account, address indexed recipient, uint256 amount);
    event NewLoansPauseChanged(bool paused);

    constructor(IERC20 loanToken_, IERC20 collateralToken_, address guardian_) {
        if (address(loanToken_).code.length == 0 || address(collateralToken_).code.length == 0
            || loanToken_ == collateralToken_ || guardian_ == address(0)) revert InvalidConfiguration();
        loanToken = loanToken_;
        collateralToken = collateralToken_;
        guardian = guardian_;
    }

    /// @notice Fund a public offer (borrower = zero) or a private offer for one wallet.
    ///         The entire fixed interest is owed even on early repayment.
    /// @dev An offer is immutable after creation; cancel and create a new one to change terms.
    function createOffer(address borrower, uint256 principal, uint256 collateralAmount,
        uint256 interest, uint256 duration, uint256 expiresAt) external nonReentrant returns (uint256 id) {
        if (newLoansPaused) revert NewLoansPaused();
        // Ensure every possible acceptance before expiry has a representable final deadline.
        // These are numeric bounds, not economic principal, interest or shared-capacity limits.
        if (borrower == address(this) || borrower == msg.sender
            || principal == 0 || collateralAmount == 0 || interest > type(uint256).max - principal
            || duration == 0 || duration % 1 days != 0
            || expiresAt <= block.timestamp || expiresAt > MAX_TIMESTAMP - GRACE_PERIOD
            || duration > MAX_TIMESTAMP - GRACE_PERIOD - expiresAt) revert InvalidTerms();
        id = nextOfferId++;
        offers[id] = Offer(msg.sender, borrower, principal, collateralAmount, interest, duration, expiresAt, 0, Status.Open);
        offerCreatedAt[id] = uint64(block.timestamp);
        _accountOfferIds[msg.sender].push(id);
        if (borrower == address(0)) {
            isPublicOffer[id] = true;
            _publicOfferIds.push(id);
        } else {
            _accountOfferIds[borrower].push(id);
        }
        committedPrincipal += principal;
        reservedPrincipal += principal;
        _pullExact(loanToken, msg.sender, principal);
        emit OfferCreated(id, msg.sender, borrower, principal, collateralAmount, interest, duration, expiresAt);
    }

    /// @notice Lock the agreed collateral and receive the already funded principal in one transaction.
    function acceptOffer(uint256 id) external nonReentrant {
        if (newLoansPaused) revert NewLoansPaused();
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (msg.sender == offer.lender || (offer.borrower != address(0) && msg.sender != offer.borrower)) {
            revert Unauthorized();
        }
        if (block.timestamp >= offer.expiresAt) revert OfferExpired();
        if (isPublicOffer[id]) {
            offer.borrower = msg.sender;
            _accountOfferIds[msg.sender].push(id);
        }
        offer.status = Status.Active;
        offer.dueAt = block.timestamp + offer.duration;
        reservedPrincipal -= offer.principal;
        lockedCollateral += offer.collateralAmount;
        _pullExact(collateralToken, msg.sender, offer.collateralAmount);
        _pushExact(loanToken, msg.sender, offer.principal);
        emit OfferAccepted(id, offer.dueAt, offer.dueAt + GRACE_PERIOD);
    }

    /// @notice Cancel an unaccepted offer at any time, including while paused or expired.
    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (msg.sender != offer.lender) revert Unauthorized();
        _closeOffer(id, offer, Status.Cancelled);
    }

    /// @notice Anyone may release expired funding, but only its lender receives the credit.
    function expireOffer(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        if (block.timestamp < offer.expiresAt) revert TooEarly();
        _closeOffer(id, offer, Status.Expired);
    }

    /// @notice Full repayment, including the agreed fixed interest; the caller supplies the funds.
    /// @dev Never spends a borrower's allowance when another account calls. Withdrawal is separate
    ///      so a blocked recipient cannot prevent debt settlement or another account's recovery.
    function repay(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp > offer.dueAt + GRACE_PERIOD) revert RepaymentDeadlinePassed();
        uint256 repayment = offer.principal + offer.interest;
        offer.status = Status.Repaid;
        committedPrincipal -= offer.principal;
        lockedCollateral -= offer.collateralAmount;
        _credit(loanToken, offer.lender, repayment);
        _credit(collateralToken, offer.borrower, offer.collateralAmount);
        _pullExact(loanToken, msg.sender, repayment);
        emit LoanRepaid(id, msg.sender, repayment);
    }

    /// @notice Anyone can settle after the final deadline; ALL collateral is assigned to the lender.
    /// @dev No USDG recovery is guaranteed. This doesn't require a swap or a price oracle.
    function claimDefault(uint256 id) external nonReentrant {
        Offer storage offer = offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= offer.dueAt + GRACE_PERIOD) revert TooEarly();
        offer.status = Status.Defaulted;
        committedPrincipal -= offer.principal;
        lockedCollateral -= offer.collateralAmount;
        _credit(collateralToken, offer.lender, offer.collateralAmount);
        emit LoanDefaulted(id);
    }

    /// @notice Withdraw only your own credits. Repayments, defaults and cancellations remain
    ///         available when new loans are paused; underlying token restrictions still apply.
    function withdraw(IERC20 token, uint256 amount, address recipient) external nonReentrant {
        if ((token != loanToken && token != collateralToken) || amount == 0
            || recipient == address(0) || recipient == address(this)
            || amount > credits[address(token)][msg.sender]) revert InvalidWithdrawal();
        credits[address(token)][msg.sender] -= amount;
        totalCredits[address(token)] -= amount;
        _pushExact(token, recipient, amount);
        emit Withdrawn(address(token), msg.sender, recipient, amount);
    }

    /// @notice Guardian can pause offer creation and acceptance only. No custody or term-changing powers.
    function setNewLoansPaused(bool paused) external nonReentrant {
        if (msg.sender != guardian) revert Unauthorized();
        newLoansPaused = paused;
        emit NewLoansPauseChanged(paused);
    }

    function repaymentDeadline(uint256 id) external view returns (uint256) {
        uint256 dueAt = offers[id].dueAt;
        return dueAt == 0 ? 0 : dueAt + GRACE_PERIOD;
    }

    /// @notice Account history, newest association first. A public borrower is added on acceptance.
    /// @dev Cursor zero starts at the newest entry. Nonzero cursors are stable array boundaries:
    ///      newly appended entries do not shift a page already in progress. nextCursor zero is exhausted.
    ///      Keep paginating until exhausted; status and offer visibility are read separately.
    function getAccountOfferIds(address account, uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor) {
        return _page(_accountOfferIds[account], cursor, limit);
    }

    /// @notice Public-offer history only, newest first; callers filter closed or expired offers.
    function getPublicOfferIds(uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor) {
        return _page(_publicOfferIds, cursor, limit);
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
        _credit(loanToken, offer.lender, offer.principal);
        emit OfferClosed(id, status);
    }

    function _credit(IERC20 token, address account, uint256 amount) private {
        credits[address(token)][account] += amount;
        totalCredits[address(token)] += amount;
        emit CreditAdded(address(token), account, amount);
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(from);
        uint256 escrowBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) != escrowBefore + amount
            || token.balanceOf(from) != senderBefore - amount) revert UnsupportedTransfer();
    }

    function _pushExact(IERC20 token, address recipient, uint256 amount) private {
        uint256 escrowBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (token.balanceOf(address(this)) != escrowBefore - amount
            || token.balanceOf(recipient) != recipientBefore + amount) revert UnsupportedTransfer();
    }
}
