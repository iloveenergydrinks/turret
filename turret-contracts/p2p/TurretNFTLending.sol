// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "openzeppelin-contracts/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {Clones} from "openzeppelin-contracts/contracts/proxy/Clones.sol";
import {TurretNFTVault} from "./TurretNFTVault.sol";

/// @notice Fixed-term, single-NFT P2P loans. No price oracle, pooled funds, upgrades or admin asset recovery.
/// @dev An allowlist is a compatibility control, not a collateral valuation or a guarantee of transfers.
/// Removing a collection or pausing admission never disables settlement or owned withdrawals.
contract TurretNFTLending is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant GRACE_PERIOD = 1 days;
    uint256 public constant MAX_TIMESTAMP = 8_640_000_000_000;
    uint256 public constant MAX_PAGE_SIZE = 50;
    enum Status { None, Open, Active, Repaid, Defaulted, Cancelled, Expired }
    struct Terms {
        address borrower; // zero permits the current owner of this specific NFT to accept
        address collection;
        uint256 tokenId;
        uint256 principal;
        uint256 interest;
        uint256 duration;
        uint256 expiresAt;
    }
    struct Offer {
        address lender;
        Terms terms;
        address vault;
        uint256 dueAt;
        Status status;
        uint256 usdgCredit;
        address nftBeneficiary;
    }
    IERC20 public immutable loanToken;
    address public immutable vaultImplementation;
    address public owner;
    address public pendingOwner;
    bool public newLoansPaused = true;
    uint256 public nextOfferId = 1;
    uint256 public reservedPrincipal;
    uint256 public activePrincipal;
    uint256 public totalUSDGCredits;
    mapping(address => bool) public allowedCollections;
    mapping(uint256 => Offer) private _offers;
    mapping(address => uint256[]) private _accountOfferIds;

    error Unauthorized();
    error InvalidConfiguration();
    error InvalidTerms();
    error AdmissionPaused();
    error CollectionNotAllowed();
    error WrongStatus();
    error OfferExpired();
    error WrongOwner();
    error DeadlinePassed();
    error TooEarly();
    error UnsupportedTransfer();
    error InvalidWithdrawal();
    error InvalidPagination();

    event CollectionPermissionChanged(address indexed collection, bool allowed);
    event NewLoansPauseChanged(bool paused);
    event OwnerNominated(address indexed nominee);
    event OwnerChanged(address indexed previousOwner, address indexed nextOwner);
    event OfferCreated(uint256 indexed id, address indexed lender, address indexed collection,
        address borrower, uint256 tokenId, uint256 principal, uint256 interest,
        uint256 duration, uint256 expiresAt, address vault);
    event OfferAccepted(uint256 indexed id, address indexed borrower, uint256 dueAt, uint256 finalDeadline);
    event OfferClosed(uint256 indexed id, Status status);
    event LoanRepaid(uint256 indexed id, address indexed payer, uint256 amount);
    event LoanDefaulted(uint256 indexed id);
    event USDGWithdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event NFTWithdrawn(uint256 indexed id, address indexed recipient);

    constructor(IERC20 loanToken_, address owner_) {
        if (address(loanToken_).code.length == 0 || owner_ == address(0) || owner_ == address(this)) {
            revert InvalidConfiguration();
        }
        loanToken = loanToken_;
        owner = owner_;
        vaultImplementation = address(new TurretNFTVault(address(this), loanToken_));
    }

    function setCollectionAllowed(address collection, bool allowed) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        if (allowed && (collection == address(loanToken) || collection == address(this)
            || collection.code.length == 0 || !IERC721(collection).supportsInterface(type(IERC721).interfaceId))) {
            revert InvalidConfiguration();
        }
        allowedCollections[collection] = allowed;
        emit CollectionPermissionChanged(collection, allowed);
    }

    function setNewLoansPaused(bool paused) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        newLoansPaused = paused;
        emit NewLoansPauseChanged(paused);
    }

    function nominateOwner(address nominee) external nonReentrant {
        if (msg.sender != owner) revert Unauthorized();
        if (nominee == address(0) || nominee == address(this)) revert InvalidConfiguration();
        pendingOwner = nominee;
        emit OwnerNominated(nominee);
    }

    function acceptOwnership() external nonReentrant {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnerChanged(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function createOffer(Terms calldata terms) external nonReentrant returns (uint256 id) {
        _admission(terms.collection);
        if (terms.borrower == msg.sender || terms.borrower == address(this)
            || terms.principal == 0 || terms.interest > type(uint256).max - terms.principal
            || terms.duration == 0 || terms.duration % 1 days != 0
            || terms.expiresAt <= block.timestamp || terms.expiresAt > MAX_TIMESTAMP - GRACE_PERIOD
            || terms.duration > MAX_TIMESTAMP - GRACE_PERIOD - terms.expiresAt) revert InvalidTerms();
        // Reject nonexistent NFTs and stale named-borrower requests before reserving lender funds.
        address holder = IERC721(terms.collection).ownerOf(terms.tokenId);
        if (holder == address(0) || (terms.borrower != address(0) && holder != terms.borrower)) revert WrongOwner();
        id = nextOfferId++;
        address vault = Clones.clone(vaultImplementation);
        TurretNFTVault(vault).initialize(IERC721(terms.collection), terms.tokenId);
        _offers[id] = Offer(msg.sender, terms, vault, 0, Status.Open, 0, address(0));
        _accountOfferIds[msg.sender].push(id);
        if (terms.borrower != address(0)) _accountOfferIds[terms.borrower].push(id);
        reservedPrincipal += terms.principal;
        _pull(msg.sender, vault, terms.principal);
        emit OfferCreated(id, msg.sender, terms.collection, terms.borrower, terms.tokenId,
            terms.principal, terms.interest, terms.duration, terms.expiresAt, vault);
    }

    function acceptOffer(uint256 id) external nonReentrant {
        Offer storage offer = _offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        Terms storage terms = offer.terms;
        _admission(terms.collection);
        if (block.timestamp >= terms.expiresAt) revert OfferExpired();
        if (msg.sender == offer.lender || (terms.borrower != address(0) && msg.sender != terms.borrower)) {
            revert Unauthorized();
        }
        if (IERC721(terms.collection).ownerOf(terms.tokenId) != msg.sender) revert WrongOwner();
        if (terms.borrower == address(0)) _accountOfferIds[msg.sender].push(id);
        terms.borrower = msg.sender;
        offer.status = Status.Active;
        offer.dueAt = block.timestamp + terms.duration;
        reservedPrincipal -= terms.principal;
        activePrincipal += terms.principal;
        IERC721(terms.collection).safeTransferFrom(msg.sender, offer.vault, terms.tokenId);
        if (IERC721(terms.collection).ownerOf(terms.tokenId) != offer.vault) revert UnsupportedTransfer();
        TurretNFTVault(offer.vault).transferUSDG(msg.sender, terms.principal);
        emit OfferAccepted(id, msg.sender, offer.dueAt, offer.dueAt + GRACE_PERIOD);
    }

    function cancelOffer(uint256 id) external nonReentrant {
        Offer storage offer = _offers[id];
        if (msg.sender != offer.lender) revert Unauthorized();
        _close(id, Status.Cancelled);
    }

    function expireOffer(uint256 id) external nonReentrant {
        if (block.timestamp < _offers[id].terms.expiresAt) revert TooEarly();
        _close(id, Status.Expired);
    }

    function repay(uint256 id) external nonReentrant {
        Offer storage offer = _offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp > offer.dueAt + GRACE_PERIOD) revert DeadlinePassed();
        uint256 amount = offer.terms.principal + offer.terms.interest;
        offer.status = Status.Repaid;
        activePrincipal -= offer.terms.principal;
        offer.usdgCredit = amount;
        totalUSDGCredits += amount;
        offer.nftBeneficiary = offer.terms.borrower;
        // Only the caller pays. No transfer to a potentially blocked lender during settlement.
        _pull(msg.sender, offer.vault, amount);
        emit LoanRepaid(id, msg.sender, amount);
    }

    function settleDefault(uint256 id) external nonReentrant {
        Offer storage offer = _offers[id];
        if (offer.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= offer.dueAt + GRACE_PERIOD) revert TooEarly();
        offer.status = Status.Defaulted;
        activePrincipal -= offer.terms.principal;
        offer.nftBeneficiary = offer.lender;
        emit LoanDefaulted(id);
    }

    function withdrawUSDG(uint256 id, uint256 amount, address recipient) external nonReentrant {
        Offer storage offer = _offers[id];
        if (msg.sender != offer.lender) revert Unauthorized();
        _recipient(recipient, offer.vault);
        if (amount == 0 || amount > offer.usdgCredit) revert InvalidWithdrawal();
        offer.usdgCredit -= amount;
        totalUSDGCredits -= amount;
        TurretNFTVault(offer.vault).transferUSDG(recipient, amount);
        emit USDGWithdrawn(id, recipient, amount);
    }

    function withdrawNFT(uint256 id, address recipient) external nonReentrant {
        Offer storage offer = _offers[id];
        if (msg.sender != offer.nftBeneficiary) revert Unauthorized();
        _recipient(recipient, offer.vault);
        offer.nftBeneficiary = address(0);
        TurretNFTVault(offer.vault).transferNFT(recipient);
        emit NFTWithdrawn(id, recipient);
    }

    function getOffer(uint256 id) external view returns (Offer memory) { return _offers[id]; }

    function getOfferBatch(uint256[] calldata ids) external view returns (Offer[] memory result) {
        if (ids.length > MAX_PAGE_SIZE) revert InvalidPagination();
        result = new Offer[](ids.length);
        for (uint256 i; i < ids.length; ++i) result[i] = _offers[ids[i]];
    }

    /// @notice Append-only bounded account index. Public discovery uses paginated OfferCreated events.
    function accountOffers(address account, uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor)
    {
        uint256[] storage all = _accountOfferIds[account];
        if (limit == 0 || limit > MAX_PAGE_SIZE || cursor > all.length) revert InvalidPagination();
        uint256 count = all.length - cursor;
        if (count > limit) count = limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) ids[i] = all[cursor + i];
        nextCursor = cursor + count;
    }

    function _close(uint256 id, Status status) private {
        Offer storage offer = _offers[id];
        if (offer.status != Status.Open) revert WrongStatus();
        offer.status = status;
        reservedPrincipal -= offer.terms.principal;
        offer.usdgCredit = offer.terms.principal;
        totalUSDGCredits += offer.terms.principal;
        emit OfferClosed(id, status);
    }

    function _admission(address collection) private view {
        if (newLoansPaused) revert AdmissionPaused();
        if (!allowedCollections[collection]) revert CollectionNotAllowed();
    }

    function _recipient(address recipient, address vault) private view {
        if (recipient == address(0) || recipient == address(this) || recipient == vault
            || recipient == vaultImplementation) revert InvalidWithdrawal();
    }

    function _pull(address from, address vault, uint256 amount) private {
        uint256 beforeFrom = loanToken.balanceOf(from);
        uint256 beforeVault = loanToken.balanceOf(vault);
        loanToken.safeTransferFrom(from, vault, amount);
        if (loanToken.balanceOf(from) != beforeFrom - amount
            || loanToken.balanceOf(vault) != beforeVault + amount) revert UnsupportedTransfer();
    }
}
