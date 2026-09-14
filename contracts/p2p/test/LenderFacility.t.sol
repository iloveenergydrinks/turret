// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TurretLenderFacility as Facility} from "../src/TurretLenderFacility.sol";
import {V3TestToken} from "./V3TestSupport.sol";

contract Facility1271Signer {
    bytes32 public approved;
    function approve(bytes32 digest) external { approved = digest; }
    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return digest == approved ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract FacilityWriting1271Signer {
    uint256 public calls;
    function isValidSignature(bytes32, bytes calldata) external returns (bytes4) {
        ++calls;
        return 0x1626ba7e;
    }
}

contract LenderFacilityTest is Test {
    uint256 constant OWNER_KEY = 0xA11CE;
    uint256 constant SIGNER_KEY = 0x516;
    address owner;
    address constant BORROWER = address(0xB0B);
    address constant OTHER = address(0xBEEF);
    address constant FEES = address(0xFEE);
    V3TestToken cash;
    V3TestToken token;
    Facility facility;

    function setUp() public {
        vm.warp(1_800_000_000);
        owner = vm.addr(OWNER_KEY);
        cash = new V3TestToken("USDG", 6);
        token = new V3TestToken("MEME", 18);
        facility = new Facility(cash, token, owner, FEES, 1000, _limits());
        address[3] memory actors = [owner, BORROWER, OTHER];
        for (uint256 i; i < actors.length; ++i) {
            cash.mint(actors[i], 2000e6); token.mint(actors[i], 100_000e18);
            vm.startPrank(actors[i]);
            cash.approve(address(facility), type(uint256).max);
            token.approve(address(facility), type(uint256).max);
            vm.stopPrank();
        }
        vm.prank(owner); facility.deposit(1000e6);
    }

    function _limits() internal pure returns (Facility.Limits memory) {
        return Facility.Limits(500e6, 1e6, 300e6, 1 days, 30 days, 1 hours, 1e30, 100);
    }
    function _quote(uint256 nonce) internal view returns (Facility.Quote memory) {
        return Facility.Quote(facility.epoch(), nonce, address(0), 300e6, 1e6, 600e18, 30e6, 7 days, block.timestamp, block.timestamp + 10 minutes);
    }
    function _sign(Facility.Quote memory quote, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, facility.quoteHash(quote));
        return abi.encodePacked(r, s, v);
    }
    function _draw(Facility.Quote memory quote, uint256 principal, address borrower) internal returns (uint256) {
        bytes memory signature = _sign(quote, OWNER_KEY);
        vm.prank(borrower);
        return facility.draw(quote, signature, principal, type(uint256).max, type(uint256).max, principal);
    }
    function _loan(uint256 id) internal view returns (Facility.Loan memory) {
        (bool ok, bytes memory data) = address(facility).staticcall(abi.encodeCall(facility.loans, (id)));
        require(ok);
        return abi.decode(data, (Facility.Loan));
    }
    function _repay(uint256 id) internal { vm.prank(BORROWER); facility.repay(id); }
    function testSignatureViewUsesTheSameStaticContextAsDraw() public {
        FacilityWriting1271Signer signer = new FacilityWriting1271Signer();
        vm.prank(owner); facility.setPolicy(_limits(), address(signer));
        Facility.Quote memory quote = _quote(88);
        assertEq(signer.isValidSignature(bytes32(0), ""), bytes4(0x1626ba7e));
        assertFalse(facility.isValidQuoteSignature(quote, ""));
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidSignature.selector);
        facility.draw(quote, "", 1e6, type(uint256).max, type(uint256).max, 1e6);
        assertEq(signer.calls(), 1);
        assertTrue(facility.isValidQuoteSignature(quote, _sign(quote, OWNER_KEY)));
    }
    function _assertAccounting() internal view {
        uint256 active; uint256 defaults;
        for (uint256 id = 1; id < facility.nextLoanId(); ++id) {
            Facility.Loan memory loan = _loan(id);
            if (loan.status == Facility.Status.Active) active += loan.principal;
            if (loan.status == Facility.Status.Defaulted && !loan.defaultAcknowledged) defaults += loan.principal;
            assertLe(facility.availableCollateral(id), token.balanceOf(loan.vault));
            assertLe(facility.availableRepayment(id) + facility.availableFee(id), cash.balanceOf(loan.vault));
        }
        assertEq(facility.activePrincipal(), active);
        assertEq(facility.unresolvedDefaultPrincipal(), defaults);
    }

    function testDepositOncePartialDrawsAndRecyclingUseOnlyRecoveredCash() public {
        Facility.Quote memory q = _quote(1);
        uint256 first = _draw(q, 100e6, BORROWER);
        uint256 second = _draw(q, 200e6, OTHER);
        assertEq(facility.idleCash(), 700e6);
        assertEq(cash.balanceOf(address(facility)), 700e6);
        assertEq(token.balanceOf(_loan(first).vault), 200e18);
        assertEq(token.balanceOf(_loan(second).vault), 400e18);
        _repay(first);
        assertEq(facility.idleCash(), 700e6, "Nominal repayment must not count as idle cash");
        assertEq(facility.availableRepayment(first), 109e6);
        vm.prank(OTHER); assertEq(facility.recycleRepayment(first), 109e6);
        assertEq(facility.idleCash(), 809e6);
        vm.expectRevert(Facility.CapacityUnavailable.selector); facility.recycleRepayment(first);
        assertEq(facility.collectFee(first), 1e6);
        assertEq(cash.balanceOf(FEES), 1e6);
        vm.prank(BORROWER); facility.withdrawCollateral(first, 200e18, BORROWER);
        assertEq(token.balanceOf(BORROWER), 100_000e18);
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.QuoteUnavailable.selector);
        facility.draw(q, sig, 1e6, type(uint256).max, type(uint256).max, 0);
        _draw(_quote(2), 100e6, BORROWER);
        _assertAccounting();
    }

    function testConflictingQuotePayloadCannotReuseNonceCapacity() public {
        Facility.Quote memory q = _quote(1); _draw(q, 100e6, BORROWER);
        q.interestForCapacity = 40e6;
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.QuoteUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        (, uint256 filled,) = facility.quoteUses(1, 1);
        assertEq(filled, 100e6);
    }

    function testCancellationStopsRemainingFillsWithoutChangingLoan() public {
        Facility.Quote memory q = _quote(1); uint256 id = _draw(q, 100e6, BORROWER);
        vm.prank(owner); facility.cancelQuote(1);
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.QuoteUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        _repay(id);
        assertEq(uint256(_loan(id).status), uint256(Facility.Status.Repaid));
    }

    function testPrivateBorrowerAndIndependentDomainSignatureChecks() public {
        Facility.Quote memory q = _quote(1); q.borrower = BORROWER;
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        vm.chainId(block.chainid + 1);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidSignature.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        Facility second = new Facility(cash, token, owner, FEES, 1000, _limits());
        assertTrue(second.quoteHash(q) != facility.quoteHash(q), "Signature binds the verifying contract");
        sig = _sign(q, SIGNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidSignature.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
    }

    function testSignerRevocationAndLimitsApplyOnChain() public {
        vm.prank(owner); facility.setPolicy(_limits(), vm.addr(SIGNER_KEY));
        Facility.Quote memory q = _quote(1); bytes memory sig = _sign(q, SIGNER_KEY);
        vm.prank(BORROWER); facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        vm.prank(vm.addr(SIGNER_KEY)); vm.expectRevert(Facility.Unauthorized.selector); facility.withdrawIdle(1e6, OTHER);
        vm.prank(vm.addr(SIGNER_KEY)); vm.expectRevert(Facility.Unauthorized.selector); facility.setPolicy(_limits(), OTHER);
        q = _quote(2); q.collateralForCapacity = 1e18; sig = _sign(q, SIGNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        q = _quote(3); sig = _sign(q, SIGNER_KEY);
        vm.prank(owner); facility.setPolicy(_limits(), address(0));
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        assertEq(_loan(1).principal, 100e6);
    }

    function testERC1271SignaturesAreCheckedAtEachFill() public {
        Facility1271Signer signer = new Facility1271Signer();
        vm.prank(owner); facility.setPolicy(_limits(), address(signer));
        Facility.Quote memory q = _quote(1); signer.approve(facility.quoteHash(q));
        vm.prank(BORROWER); facility.draw(q, hex"01", 100e6, 1000e18, 100e6, 0);
        signer.approve(bytes32(0));
        vm.prank(OTHER); vm.expectRevert(Facility.InvalidSignature.selector);
        facility.draw(q, hex"01", 100e6, 1000e18, 100e6, 0);
    }

    function testBorrowerBoundsProtectCollateralInterestAndChangedCapacity() public {
        Facility.Quote memory q = _quote(1); bytes memory sig = _sign(q, OWNER_KEY);
        vm.startPrank(BORROWER);
        vm.expectRevert(Facility.BorrowerBoundsExceeded.selector); facility.draw(q, sig, 100e6, 199e18, 100e6, 0);
        vm.expectRevert(Facility.BorrowerBoundsExceeded.selector); facility.draw(q, sig, 100e6, 200e18, 9e6, 0);
        vm.stopPrank();
        _draw(q, 100e6, OTHER);
        vm.prank(BORROWER); vm.expectRevert(Facility.QuoteUnavailable.selector);
        facility.draw(q, sig, 100e6, 200e18, 10e6, 300e6);
        assertEq(facility.nextLoanId(), 2);
        assertEq(token.balanceOf(BORROWER), 100_000e18);
    }

    function testExposureAndIdleCashAreIndependentDrawBounds() public {
        _draw(_quote(1), 300e6, BORROWER);
        Facility.Quote memory q = _quote(2); bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.CapacityUnavailable.selector);
        facility.draw(q, sig, 300e6, 1000e18, 100e6, 0);
        vm.prank(owner); facility.withdrawIdle(650e6, owner);
        vm.prank(OTHER); vm.expectRevert(Facility.CapacityUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        _draw(q, 50e6, OTHER);
        assertEq(facility.idleCash(), 0);
        _assertAccounting();
    }

    function testLowerLimitDoesNotRewriteActiveLoanAndPausePreservesRecovery() public {
        uint256 id = _draw(_quote(1), 300e6, BORROWER);
        Facility.Limits memory policy = _limits(); policy.maxExposure = 200e6; policy.maxDraw = 200e6;
        vm.prank(owner); facility.setPolicy(policy, address(0));
        Facility.Quote memory q = _quote(2); bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.CapacityUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        vm.prank(owner); facility.setNewLoansPaused(true);
        vm.prank(OTHER); vm.expectRevert(Facility.NewLoansPaused.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        _repay(id); facility.recycleRepayment(id);
        vm.prank(BORROWER); facility.withdrawCollateral(id, 600e18, BORROWER);
        assertEq(facility.idleCash(), 1027e6);
        _assertAccounting();
    }

    function testQuoteTimeAndDurationBoundaries() public {
        Facility.Quote memory q = _quote(1); bytes memory sig = _sign(q, OWNER_KEY);
        vm.warp(q.expiresAt);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        q = _quote(2); q.validAfter += 1; sig = _sign(q, OWNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        q = _quote(3); q.expiresAt = q.validAfter + 2 hours; sig = _sign(q, OWNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        q = _quote(4); q.duration += 1; sig = _sign(q, OWNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidQuote.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
    }

    function testExactRepaymentDeadlineAndDefaultExposureAcknowledgement() public {
        uint256 a = _draw(_quote(1), 100e6, BORROWER);
        uint256 b = _draw(_quote(2), 100e6, OTHER);
        vm.warp(facility.repaymentDeadline(a));
        vm.expectRevert(Facility.TooEarly.selector); facility.claimDefault(a);
        _repay(a);
        vm.warp(block.timestamp + 1);
        vm.prank(OTHER); vm.expectRevert(Facility.DeadlinePassed.selector); facility.repay(b);
        facility.claimDefault(b);
        assertEq(facility.unresolvedDefaultPrincipal(), 100e6);
        assertEq(facility.availableFee(b), 0);
        vm.prank(owner); vm.expectRevert(Facility.WrongStatus.selector); facility.acknowledgeDefault(b);
        vm.prank(owner); facility.withdrawCollateral(b, 200e18, owner);
        assertEq(facility.unresolvedDefaultPrincipal(), 100e6, "Recovery is not automatic exposure reset");
        vm.prank(OTHER); vm.expectRevert(Facility.Unauthorized.selector); facility.acknowledgeDefault(b);
        vm.prank(owner); facility.acknowledgeDefault(b);
        assertEq(facility.unresolvedDefaultPrincipal(), 0);
        assertEq(facility.acknowledgedDefaultPrincipal(), 100e6);
        vm.prank(owner); vm.expectRevert(Facility.WrongStatus.selector); facility.acknowledgeDefault(b);
        _assertAccounting();
    }

    function testDefaultCannotAutomaticallyFreeSignerExposure() public {
        uint256 id = _draw(_quote(1), 300e6, BORROWER);
        _draw(_quote(2), 200e6, OTHER);
        vm.warp(facility.repaymentDeadline(id) + 1); facility.claimDefault(id);
        Facility.Quote memory q = _quote(3); bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(OTHER); vm.expectRevert(Facility.CapacityUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
    }

    function testLostRepaymentBackingHasLenderPriorityAndCannotContaminateAnotherLoan() public {
        uint256 a = _draw(_quote(1), 100e6, BORROWER);
        uint256 b = _draw(_quote(2), 100e6, BORROWER);
        _repay(a); _repay(b);
        cash.removeBalance(_loan(a).vault, 20e6);
        assertEq(facility.availableRepayment(a), 90e6);
        assertEq(facility.availableFee(a), 0);
        assertEq(facility.availableRepayment(b), 109e6);
        facility.recycleRepayment(a);
        assertEq(_loan(a).lenderCredit, 19e6);
        vm.prank(owner); facility.writeOffRepayment(a);
        assertEq(facility.repaymentWrittenOff(), 19e6);
        assertEq(facility.availableFee(a), 0);
        facility.recycleRepayment(b); facility.collectFee(b);
        assertEq(facility.idleCash(), 999e6);
        _assertAccounting();
    }

    function testFrozenFeeRecipientDoesNotBlockRepaymentOrCollateralRecovery() public {
        uint256 id = _draw(_quote(1), 100e6, BORROWER);
        cash.setBlockedRecipient(FEES);
        _repay(id); facility.recycleRepayment(id);
        vm.expectRevert(); facility.collectFee(id);
        vm.prank(BORROWER); facility.withdrawCollateral(id, 200e18, BORROWER);
        assertEq(facility.idleCash(), 1009e6);
        assertEq(_loan(id).feeCredit, 1e6);
    }

    function testLostCollateralRetainsNominalClaimUntilOwnerAcknowledgesIt() public {
        uint256 id = _draw(_quote(1), 100e6, BORROWER);
        token.removeBalance(_loan(id).vault, 50e18); _repay(id);
        vm.prank(BORROWER); facility.withdrawCollateral(id, 150e18, BORROWER);
        assertEq(_loan(id).collateralCredit, 50e18);
        vm.prank(owner); vm.expectRevert(Facility.Unauthorized.selector); facility.writeOffCollateral(id);
        vm.prank(BORROWER); facility.writeOffCollateral(id);
        assertEq(_loan(id).collateralCredit, 0);
        assertEq(facility.availableRepayment(id), 109e6);
    }

    function testIdleLossAndDonationCannotCreateNominalCapital() public {
        cash.mint(address(facility), 10e6);
        assertEq(facility.idleCash(), 1000e6);
        vm.prank(owner); facility.withdrawSurplus(10e6, owner);
        cash.removeBalance(address(facility), 100e6);
        vm.prank(owner); vm.expectRevert(Facility.CapacityUnavailable.selector); facility.deposit(10e6);
        Facility.Quote memory q = _quote(1); bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(BORROWER); vm.expectRevert(Facility.CapacityUnavailable.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        vm.prank(owner); facility.acknowledgeIdleLoss();
        assertEq(facility.idleCash(), 900e6);
        assertEq(facility.idleCashWrittenOff(), 100e6);
        vm.prank(owner); facility.deposit(10e6);
        assertEq(facility.idleCash(), 910e6);
        _draw(q, 100e6, BORROWER);
    }

    function testTransferTaxesAndSkippedTransfersRevertWholeDraw() public {
        Facility.Quote memory q = _quote(1); bytes memory sig = _sign(q, OWNER_KEY);
        token.setFee(1);
        vm.prank(BORROWER); vm.expectRevert(Facility.UnsupportedTransfer.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        token.setFee(0); token.setSenderFee(1);
        vm.prank(BORROWER); vm.expectRevert(Facility.UnsupportedTransfer.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        token.setSenderFee(0); token.setSkipTransfer(true);
        vm.prank(BORROWER); vm.expectRevert(Facility.UnsupportedTransfer.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        token.setSkipTransfer(false); cash.setFee(1);
        vm.prank(BORROWER); vm.expectRevert(Facility.UnsupportedTransfer.selector);
        facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        cash.setFee(0); cash.setReturnFalse(true);
        vm.prank(BORROWER); vm.expectRevert(); facility.draw(q, sig, 100e6, 1000e18, 100e6, 0);
        assertEq(facility.nextLoanId(), 1); assertEq(facility.activePrincipal(), 0);
        assertEq(facility.idleCash(), 1000e6); assertEq(token.balanceOf(BORROWER), 100_000e18);
        (, uint256 filled,) = facility.quoteUses(1, 1); assertEq(filled, 0);
    }

    function testReentrantTokenCallbackCannotRecycleWhileDrawing() public {
        uint256 id = _draw(_quote(1), 100e6, BORROWER); _repay(id);
        token.setCallback(address(facility), abi.encodeCall(facility.recycleRepayment, (id)));
        _draw(_quote(2), 100e6, OTHER);
        assertFalse(token.callbackSucceeded());
        assertEq(facility.idleCash(), 800e6);
        assertEq(facility.availableRepayment(id), 109e6);
        _assertAccounting();
    }

    function testExtensionNeedsCounterpartyAndExactUncancelledTerms() public {
        uint256 id = _draw(_quote(1), 100e6, BORROWER);
        uint256 old = facility.repaymentDeadline(id);
        uint256 later = old + 7 days;
        uint256 expiry = block.timestamp + 1 days;
        vm.prank(BORROWER); facility.proposeExtension(id, later, expiry);
        vm.prank(BORROWER); vm.expectRevert(Facility.Unauthorized.selector); facility.acceptExtension(id, 1, old, later, expiry);
        vm.prank(owner); vm.expectRevert(Facility.InvalidExtension.selector); facility.acceptExtension(id, 1, old, later + 1, expiry);
        vm.prank(BORROWER); facility.cancelExtension(id);
        vm.prank(owner); vm.expectRevert(Facility.InvalidExtension.selector); facility.acceptExtension(id, 1, old, later, expiry);
        vm.prank(BORROWER); facility.proposeExtension(id, later, expiry);
        vm.prank(owner); facility.acceptExtension(id, 2, old, later, expiry);
        assertEq(facility.repaymentDeadline(id), later); assertEq(_loan(id).interest, 10e6);
        vm.warp(old + 1); vm.expectRevert(Facility.TooEarly.selector); facility.claimDefault(id);
        vm.warp(later); _repay(id);
        vm.prank(owner); vm.expectRevert(Facility.WrongStatus.selector); facility.acceptExtension(id, 2, old, later, expiry);
    }

    function testFuzzRoundingNeverUnderchargesProportion(uint96 rawCapacity, uint96 rawPrincipal, uint96 rawCollateral, uint96 rawInterest) public view {
        uint256 capacity = bound(uint256(rawCapacity), 1, type(uint96).max);
        uint256 principal = bound(uint256(rawPrincipal), 1, capacity);
        Facility.Quote memory q = _quote(1);
        q.capacity = capacity; q.collateralForCapacity = uint256(rawCollateral); q.interestForCapacity = uint256(rawInterest);
        (uint256 c, uint256 i) = facility.quoteTerms(q, principal);
        // Products fit 192 bits: cross-multiply independently of the implementation's mulDiv.
        assertGe(c * capacity, principal * q.collateralForCapacity);
        assertGe(i * capacity, principal * q.interestForCapacity);
        if (c > 0) assertLt((c - 1) * capacity, principal * q.collateralForCapacity);
        if (i > 0) assertLt((i - 1) * capacity, principal * q.interestForCapacity);
    }

    function testQuoteHashMatchesFlatEIP712Encoding() public view {
        Facility.Quote memory q = _quote(123);
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("TurretLenderFacility"), keccak256("1"), block.chainid, address(facility)
        ));
        bytes32 fields = keccak256(bytes.concat(
            abi.encode(keccak256("Quote(uint256 epoch,uint256 nonce,address borrower,uint256 capacity,uint256 minDraw,uint256 collateralForCapacity,uint256 interestForCapacity,uint256 duration,uint256 validAfter,uint256 expiresAt)"), q.epoch, q.nonce, q.borrower),
            abi.encode(q.capacity, q.minDraw, q.collateralForCapacity, q.interestForCapacity),
            abi.encode(q.duration, q.validAfter, q.expiresAt)
        ));
        assertEq(facility.quoteHash(q), keccak256(abi.encodePacked(hex"1901", domain, fields)));
    }

    function testFuzzFeeOnlyTakesCollectedInterest(uint16 rawBps) public {
        uint256 bps = uint256(rawBps) % 10_001;
        facility = new Facility(cash, token, owner, FEES, bps, _limits());
        vm.startPrank(owner); cash.approve(address(facility), 500e6); facility.deposit(500e6); vm.stopPrank();
        vm.startPrank(BORROWER);
        cash.approve(address(facility), type(uint256).max); token.approve(address(facility), type(uint256).max);
        vm.stopPrank();
        uint256 id = _draw(_quote(1), 100e6, BORROWER);
        _repay(id);
        Facility.Loan memory loan = _loan(id);
        uint256 expectedFee = 10e6 * bps / 10_000;
        assertEq(loan.feeCredit, expectedFee);
        assertGe(loan.lenderCredit, loan.principal);
        assertEq(loan.lenderCredit + loan.feeCredit, 110e6);
        if (expectedFee != 0) {
            vm.prank(OTHER); facility.collectFee(id);
            assertEq(cash.balanceOf(FEES), expectedFee);
        }
        facility.recycleRepayment(id);
        assertEq(facility.idleCash(), 510e6 - expectedFee);
        assertEq(cash.balanceOf(loan.vault), 0);
    }

    function testDefaultAndLateExtensionRaceHasOneFinalOutcome() public {
        uint256 a = _draw(_quote(1), 100e6, BORROWER);
        uint256 b = _draw(_quote(2), 100e6, BORROWER);
        uint256 old = facility.repaymentDeadline(a);
        vm.warp(old + 1);
        uint256 later = old + 7 days;
        uint256 expiry = block.timestamp + 1 days;
        vm.prank(BORROWER); facility.proposeExtension(a, later, expiry);
        vm.prank(owner); facility.acceptExtension(a, 1, old, later, expiry);
        _repay(a);
        vm.expectRevert(Facility.WrongStatus.selector); facility.claimDefault(a);
        vm.prank(BORROWER); facility.proposeExtension(b, later, expiry);
        facility.claimDefault(b);
        vm.prank(owner); vm.expectRevert(Facility.WrongStatus.selector); facility.acceptExtension(b, 1, old, later, expiry);
        assertEq(facility.collateralOwner(a), BORROWER);
        assertEq(facility.collateralOwner(b), owner);
        _assertAccounting();
    }

    function testRepaymentAndCollateralRecipientAuthorization() public {
        uint256 id = _draw(_quote(1), 100e6, BORROWER);
        vm.prank(OTHER); facility.repay(id); // Anyone can pay, but does not acquire the collateral.
        vm.prank(OTHER); vm.expectRevert(Facility.Unauthorized.selector); facility.withdrawCollateral(id, 200e18, OTHER);
        vm.prank(OTHER); vm.expectRevert(Facility.Unauthorized.selector); facility.withdrawRepayment(id, 109e6, OTHER);
        vm.prank(owner); facility.withdrawRepayment(id, 109e6, owner);
        assertEq(facility.idleCash(), 900e6, "Direct withdrawal must not also credit the facility");
        vm.expectRevert(Facility.CapacityUnavailable.selector); facility.recycleRepayment(id);
        vm.expectRevert(Facility.WrongStatus.selector); facility.repay(id);
        vm.expectRevert(Facility.WrongStatus.selector); facility.claimDefault(id);
        vm.prank(BORROWER); facility.withdrawCollateral(id, 200e18, BORROWER);
        vm.prank(BORROWER); vm.expectRevert(Facility.InvalidWithdrawal.selector); facility.withdrawCollateral(id, 1, BORROWER);
    }

    function testFuzzSequentialLifecycleConservesCashAndCollateral(uint256 seed) public {
        for (uint256 step; step < 32; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;
            uint256 next = facility.nextLoanId();
            uint256 id = next == 1 ? 0 : 1 + (seed >> 8) % (next - 1);
            Facility.Loan memory loan = _loan(id);
            if (action == 0) {
                uint256 principal = (1 + (seed >> 32) % 100) * 1e6;
                if (facility.idleCash() >= principal && facility.activePrincipal() + facility.unresolvedDefaultPrincipal() + principal <= 500e6) {
                    Facility.Quote memory q = _quote(step + 1);
                    _draw(q, principal, (seed & 128) == 0 ? BORROWER : OTHER);
                }
            } else if (action == 1 && loan.status == Facility.Status.Active && block.timestamp <= facility.repaymentDeadline(id)) {
                vm.prank(loan.borrower); facility.repay(id);
            } else if (action == 2 && loan.status == Facility.Status.Active) {
                if (block.timestamp <= facility.repaymentDeadline(id)) vm.warp(facility.repaymentDeadline(id) + 1);
                facility.claimDefault(id);
            } else if (action == 3 && facility.availableRepayment(id) > 0) {
                facility.recycleRepayment(id);
            } else if (action == 4 && facility.availableCollateral(id) > 0) {
                address beneficiary = facility.collateralOwner(id);
                uint256 amount = facility.availableCollateral(id);
                vm.prank(beneficiary); facility.withdrawCollateral(id, amount, beneficiary);
            } else if (action == 5 && loan.status == Facility.Status.Defaulted && !loan.defaultAcknowledged && loan.collateralCredit == 0) {
                vm.prank(owner); facility.acknowledgeDefault(id);
            } else if (action == 6 && facility.availableFee(id) > 0) {
                facility.collectFee(id);
            }
            _assertAccounting();
            _assertConservation();
        }
    }

    function _assertConservation() internal view {
        uint256 cashTotal = cash.balanceOf(owner) + cash.balanceOf(BORROWER) + cash.balanceOf(OTHER)
            + cash.balanceOf(FEES) + cash.balanceOf(address(facility));
        uint256 collateralTotal = token.balanceOf(owner) + token.balanceOf(BORROWER) + token.balanceOf(OTHER);
        uint256 feeClaims; uint256 collectedInterest;
        for (uint256 id = 1; id < facility.nextLoanId(); ++id) {
            Facility.Loan memory loan = _loan(id);
            cashTotal += cash.balanceOf(loan.vault);
            collateralTotal += token.balanceOf(loan.vault);
            feeClaims += loan.feeCredit;
            if (loan.status == Facility.Status.Repaid) collectedInterest += loan.interest;
            if (loan.status == Facility.Status.Active) assertEq(token.balanceOf(loan.vault), loan.collateralAmount);
            else assertEq(token.balanceOf(loan.vault), loan.collateralCredit);
        }
        assertEq(cashTotal, 6000e6, "No cash created or double-spent across repeated cycles");
        assertEq(collateralTotal, 300_000e18, "All deposited collateral remains with its owner or loan vault");
        assertEq(facility.idleCash(), cash.balanceOf(address(facility)));
        // Generated loan sizes make fees integral: compare independently with collected interest.
        assertEq(feeClaims + cash.balanceOf(FEES), collectedInterest / 10);
    }
}
