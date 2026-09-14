// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretP2PLending} from "../src/TurretP2PLending.sol";

/// @dev Configurable adversarial transfer behavior, never used outside the test suite.
contract P2PToken is ERC20 {
    uint8 private immutable _precision;
    uint256 public fee;
    uint256 public senderFee;
    bool public returnFalse;
    bool public skipTransfer;
    address public blockedRecipient;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;
    uint256 public callbacks;
    bool private inCallback;

    constructor(string memory symbol_, uint8 precision_) ERC20(symbol_, symbol_) {
        _precision = precision_;
    }

    function decimals() public view override returns (uint8) { return _precision; }
    function mint(address account, uint256 amount) external { _mint(account, amount); }
    function setFee(uint256 amount) external { fee = amount; }
    function setSenderFee(uint256 amount) external { senderFee = amount; }
    function setReturnFalse(bool value) external { returnFalse = value; }
    function setSkipTransfer(bool value) external { skipTransfer = value; }
    function setBlockedRecipient(address account) external { blockedRecipient = account; }
    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        if (returnFalse) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual override returns (bool) {
        if (returnFalse) return false;
        _spendAllowance(from, msg.sender, amount);
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (skipTransfer) return;
        require(to != blockedRecipient, "blocked recipient");
        uint256 withheld = fee < amount ? fee : amount;
        _transfer(from, to, amount - withheld);
        if (withheld > 0) _burn(from, withheld);
        if (senderFee > 0) _burn(from, senderFee);
        if (callbackTarget != address(0) && !inCallback) {
            inCallback = true;
            callbacks++;
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
            inCallback = false;
        }
    }
}

contract P2PNoReturnToken is P2PToken {
    constructor(string memory symbol_, uint8 precision_) P2PToken(symbol_, precision_) {}

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        assembly { return(0, 0) }
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        assembly { return(0, 0) }
    }
}

abstract contract P2PTestBase is Test {
    P2PToken internal usd;
    P2PToken internal slv;
    TurretP2PLending internal market;
    address internal lender = address(0xA11CE);
    address internal borrower = address(0xB0B);
    address internal thirdParty = address(0xCA11);
    address internal guardian = address(0x600D);
    uint256 internal constant PRINCIPAL = 100e6;
    uint256 internal constant COLLATERAL = 40e18;
    uint256 internal constant INTEREST = 5e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usd = new P2PToken("USDG", 6);
        slv = new P2PToken("SLV", 18);
        market = new TurretP2PLending(usd, slv, guardian, 1_000e6, 100_000e6, _lenders());
        _fundAndApprove(lender);
        _fundAndApprove(borrower);
        _fundAndApprove(thirdParty);
    }

    function _lenders() internal view returns (address[] memory list) {
        list = new address[](1);
        list[0] = lender;
    }

    function _fundAndApprove(address actor) internal {
        usd.mint(actor, 10_000_000e6);
        slv.mint(actor, 10_000_000e18);
        vm.startPrank(actor);
        usd.approve(address(market), type(uint256).max);
        slv.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function _create() internal returns (uint256) {
        vm.prank(lender);
        return market.createOffer(borrower, PRINCIPAL, COLLATERAL, INTEREST, 30 days, block.timestamp + 1 hours);
    }

    function _active() internal returns (uint256 id) {
        id = _create();
        vm.prank(borrower);
        market.acceptOffer(id);
    }

    function _offer(uint256 id) internal view returns (TurretP2PLending.Offer memory offer) {
        (bool ok, bytes memory encoded) = address(market).staticcall(abi.encodeWithSelector(market.offers.selector, id));
        require(ok, "read offer failed");
        offer = abi.decode(encoded, (TurretP2PLending.Offer));
    }

    function _assertSolvent() internal view {
        assertGe(usd.balanceOf(address(market)), market.reservedPrincipal() + market.totalCredits(address(usd)));
        assertGe(slv.balanceOf(address(market)), market.lockedCollateral() + market.totalCredits(address(slv)));
    }

    function _assertStatus(uint256 id, TurretP2PLending.Status expected) internal view {
        assertEq(uint256(_offer(id).status), uint256(expected));
    }
}
