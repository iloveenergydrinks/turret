// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VariableCreditBase} from "./VariableCreditBase.sol";
import {SignatureChecker} from "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Operator-priced lending. Custody, accounting, caps and settlement remain on chain.
/// @dev The operator is trusted to price collateral and authorize risk. A compromised
/// signer can cause lender losses. No signer is needed to repay or recover debt-free collateral.
contract TurretVariableCreditEngine is VariableCreditBase {
    string public constant TRUST_MODEL = "CENTRAL_RISK_SIGNER";
    uint256 public constant MAX_APPROVAL_LIFETIME = 60;
    bytes32 public constant APPROVAL_TYPEHASH = keccak256("Approval(address borrower,uint8 action,uint256 collateralAmount,uint256 debtAmount,uint256 maxDebt,uint256 price,uint256 nonce,uint64 observedAt,uint64 deadline,uint256 epoch)");
    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(uint256 value,uint64 observedAt,uint64 deadline,uint256 epoch)");

    struct Approval {
        address borrower;
        uint8 action;
        uint256 collateralAmount;
        uint256 debtAmount;
        uint256 maxDebt;
        uint256 price;
        uint256 nonce;
        uint64 observedAt;
        uint64 deadline;
        uint256 epoch;
    }
    struct Price {
        uint256 value;
        uint64 observedAt;
        uint64 deadline;
        uint256 epoch;
    }
    address public riskSigner;
    uint256 public signerEpoch;
    mapping(address => uint256) public approvalNonces;
    Price public liquidationPrice;
    uint256 private transactionPrice;
    error InvalidApproval();
    event RiskSignerChanged(address indexed signer, uint256 epoch);
    event ApprovalConsumed(address indexed borrower, uint256 nonce, bytes32 digest);
    event ApprovalInvalidated(address indexed borrower, uint256 nonce);
    event PricePublished(uint256 value, uint64 observedAt, uint64 deadline);

    constructor(Config memory c, address signer) VariableCreditBase(c) {
        if (signer == address(0)) revert InvalidConfiguration();
        riskSigner = signer;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("TurretCreditEngine"), keccak256("1"), block.chainid, address(this)
        ));
    }

    function approvalDigest(Approval calldata a) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(APPROVAL_TYPEHASH, a)));
    }

    function priceDigest(Price calldata p) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(PRICE_TYPEHASH, p)));
    }

    function _digest(bytes32 h) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), h));
    }

    function setRiskSigner(address signer) external onlyOwner {
        if (signer == address(0)) revert InvalidConfiguration();
        riskSigner = signer;
        signerEpoch++;
        delete liquidationPrice;
        emit RiskSignerChanged(signer, signerEpoch);
    }

    function invalidateApprovals(uint256 nextNonce) external {
        if (nextNonce <= approvalNonces[msg.sender]) revert InvalidApproval();
        approvalNonces[msg.sender] = nextNonce;
        emit ApprovalInvalidated(msg.sender, nextNonce);
    }

    function _validWindow(uint64 observedAt, uint64 deadline, uint256 epoch) private view returns (bool) {
        return epoch == signerEpoch && observedAt <= block.timestamp && deadline > block.timestamp
            && deadline > observedAt && deadline - observedAt <= MAX_APPROVAL_LIFETIME;
    }

    /// @notice Exact wallet and amount binding. The price exists only inside this transaction.
    function executeApproved(Approval calldata a, bytes calldata signature) external nonReentrant {
        if (a.borrower != msg.sender || a.nonce != approvalNonces[msg.sender] || a.price == 0
            || !_validWindow(a.observedAt, a.deadline, a.epoch)) revert InvalidApproval();
        bytes32 digest = approvalDigest(a);
        if (!SignatureChecker.isValidSignatureNow(riskSigner, digest, signature)) revert InvalidApproval();
        approvalNonces[msg.sender]++;
        transactionPrice = a.price;
        if (a.action == 1 && a.collateralAmount != 0 && a.debtAmount != 0) {
            _depositCollateral(msg.sender, a.collateralAmount);
            _borrow(a.debtAmount);
        } else if (a.action == 2 && a.collateralAmount == 0 && a.debtAmount != 0) {
            _borrow(a.debtAmount);
        } else if (a.action == 3 && a.collateralAmount != 0 && a.debtAmount == 0) {
            _withdrawCollateral(a.collateralAmount, msg.sender);
        } else revert InvalidApproval();
        if (positionDebt(msg.sender) > a.maxDebt) revert Slippage();
        transactionPrice = 0;
        emit ApprovalConsumed(msg.sender, a.nonce, digest);
    }

    function borrowingPrice() public view override returns (uint256) {
        if (transactionPrice == 0) revert OracleUnavailable();
        return transactionPrice;
    }

    /// @notice A current operator valuation is required to seize collateral.
    /// Repayment and debt-free withdrawals never call this function.
    function price() public view override returns (uint256) {
        Price memory p = liquidationPrice;
        if (p.value == 0 || !_validWindow(p.observedAt, p.deadline, p.epoch)) revert OracleUnavailable();
        return p.value;
    }

    function submitPrice(Price calldata p, bytes calldata signature) public {
        if (p.value == 0 || !_validWindow(p.observedAt, p.deadline, p.epoch)
            || p.observedAt < liquidationPrice.observedAt) revert InvalidApproval();
        if (!SignatureChecker.isValidSignatureNow(riskSigner, priceDigest(p), signature)) revert InvalidApproval();
        // Same timestamp cannot replace an already published valuation or extend its lifetime.
        if (p.observedAt == liquidationPrice.observedAt && liquidationPrice.value != 0
            && (p.value != liquidationPrice.value || p.deadline != liquidationPrice.deadline)) revert InvalidApproval();
        liquidationPrice = p;
        emit PricePublished(p.value, p.observedAt, p.deadline);
    }

    function liquidateApproved(address borrower, uint256 maximum, uint256 minimum,
        Price calldata p, bytes calldata signature) external nonReentrant returns (uint256 paid, uint256 seized) {
        submitPrice(p, signature);
        return _liquidate(borrower, maximum, minimum);
    }

    function priceWithApproval(bytes calldata encoded) external returns (uint256) {
        (Price memory p, bytes memory signature) = abi.decode(encoded,(Price,bytes));
        this.submitPrice(p,signature);
        return price();
    }

    function liquidationQuoteWithApproval(address borrower,uint256 maximum,bytes calldata encoded)
        external returns(uint256 paid,uint256 seized) {
        (Price memory p, bytes memory signature) = abi.decode(encoded,(Price,bytes));
        this.submitPrice(p,signature);
        return this.liquidationQuote(borrower,maximum);
    }

    function liquidateWithCallbackApproved(address borrower, uint256 maximum, uint256 minimum,
        Price calldata p, bytes calldata signature, bytes calldata data)
        external nonReentrant returns (uint256 paid, uint256 seized) {
        submitPrice(p, signature);
        return _liquidateWithCallback(borrower, maximum, minimum, data);
    }
}
