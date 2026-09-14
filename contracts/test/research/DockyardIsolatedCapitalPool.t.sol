// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";

contract CapitalMockToken is ERC20 {
    bool public taxed;
    address public callbackPool;
    bool public callbackSucceeded;
    constructor() ERC20("Mock USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTaxed(bool value) external {
        taxed = value;
    }

    function setCallback(address value) external {
        callbackPool = value;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (callbackPool != address(0)) {
            (callbackSucceeded,) = callbackPool.call(abi.encodeWithSignature("accrueInterest()"));
        }
        if (taxed && amount > 0) {
            _burn(from, 1);
            amount -= 1;
        }
        super._transfer(from, to, amount);
    }
}

contract DockyardIsolatedCapitalPoolTest is Test {
    bool public mockCapitalAllowed = true;
    bool public mockSafetyUnavailable;

    function capitalOperationsAllowed() external view returns (bool) {
        require(!mockSafetyUnavailable, "unavailable safety check");
        return mockCapitalAllowed;
    }
    CapitalMockToken cash;
    CapitalMockToken collateral;
    DockyardIsolatedCapitalPool pool;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address borrower = makeAddr("borrower");
    address treasury = makeAddr("treasury");

    function setUp() public {
        cash = new CapitalMockToken();
        collateral = new CapitalMockToken();
        pool = new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(collateral), address(this), treasury, 1000e6, 1000, 1000
        );
        cash.mint(alice, 1000e6);
        cash.mint(bob, 1000e6);
        cash.mint(address(this), 1000e6);
        cash.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        cash.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        cash.approve(address(pool), type(uint256).max);
    }

    function depositAlice(uint256 amount) internal {
        vm.prank(alice);
        pool.deposit(amount, alice);
    }

    function testSafetyHookFailureBlocksCapitalButRepaymentRemainsAvailable() public {
        depositAlice(100e6);
        pool.draw(borrower, 70e6);
        mockSafetyUnavailable = true;
        assertFalse(pool.capitalOperationsAllowed());
        assertEq(pool.maxWithdraw(alice), 0);
        assertEq(pool.maxDeposit(bob), 0);
        vm.expectRevert(DockyardIsolatedCapitalPool.CapitalOperationsSuspended.selector);
        pool.draw(borrower, 1e6);
        pool.repay(70e6, 0);
        assertTrue(pool.capitalOperationsAllowed());
        vm.prank(alice);
        pool.withdraw(100e6, alice, alice);
        assertEq(cash.balanceOf(alice), 1000e6);
    }

    function testDepositAndRedeemIdleCapital() public {
        depositAlice(100e6);
        assertEq(pool.decimals(), 12);
        assertEq(pool.balanceOf(alice), 100e12);
        uint256 shares = pool.balanceOf(alice);
        vm.prank(alice);
        assertEq(pool.redeem(shares, alice, alice), 100e6);
        assertEq(cash.balanceOf(alice), 1000e6);
        assertEq(pool.totalAssets(), 0);
    }

    function testGuardedDepositAndFullRedeem() public {
        uint256 quoted = pool.previewDeposit(100e6);
        vm.prank(alice);
        assertEq(pool.depositWithMinShares(100e6, alice, quoted, block.timestamp + 300), quoted);
        vm.prank(alice);
        assertEq(pool.redeemWithMinAssets(quoted, alice, alice, 100e6, block.timestamp + 300), 100e6);
        assertEq(pool.balanceOf(alice), 0);
        assertEq(cash.balanceOf(alice), 1000e6);
    }

    function testGuardedDepositRollsBackWhenDonationChangesQuote() public {
        depositAlice(100e6);
        uint256 quoted = pool.previewDeposit(10e6);
        cash.transfer(address(pool), 50e6);
        uint256 assetsBefore = pool.totalAssets();
        vm.prank(bob);
        vm.expectRevert(DockyardIsolatedCapitalPool.Slippage.selector);
        pool.depositWithMinShares(10e6, bob, quoted, block.timestamp + 300);
        assertEq(pool.balanceOf(bob), 0);
        assertEq(cash.balanceOf(bob), 1000e6);
        assertEq(pool.totalAssets(), assetsBefore);
    }

    function testGuardedWithdrawAndRedeemRejectLossChangedQuote() public {
        depositAlice(100e6);
        uint256 shares = pool.previewWithdraw(10e6);
        uint256 assets = pool.previewRedeem(10e12);
        pool.draw(borrower, 50e6);
        pool.recognizeLoss(50e6, 0);
        vm.startPrank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.Slippage.selector);
        pool.withdrawWithMaxShares(10e6, alice, alice, shares, block.timestamp + 300);
        vm.expectRevert(DockyardIsolatedCapitalPool.Slippage.selector);
        pool.redeemWithMinAssets(10e12, alice, alice, assets, block.timestamp + 300);
        vm.stopPrank();
        assertEq(pool.balanceOf(alice), 100e12);
        assertEq(cash.balanceOf(alice), 900e6);
        assertEq(pool.availableCash(), 50e6);
    }

    function testGuardedWithdrawWorksAtExactQuoteAndDeadline() public {
        depositAlice(100e6);
        uint256 shares = pool.previewWithdraw(25e6);
        vm.prank(alice);
        assertEq(pool.withdrawWithMaxShares(25e6, alice, alice, shares, block.timestamp), shares);
        assertEq(cash.balanceOf(alice), 925e6);
    }

    function testGuardedActionsRejectExpiredOrUnboundedDeadlines() public {
        depositAlice(100e6);
        vm.startPrank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidDeadline.selector);
        pool.depositWithMinShares(1e6, alice, 1, block.timestamp - 1);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidDeadline.selector);
        pool.withdrawWithMaxShares(1e6, alice, alice, 1e12, block.timestamp + 301);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidDeadline.selector);
        pool.redeemWithMinAssets(1e12, alice, alice, 1, block.timestamp - 1);
        vm.stopPrank();
    }

    function testGuardedEntryPointsRetainCashLimitsAndSafetyHook() public {
        depositAlice(100e6);
        pool.draw(borrower, 70e6);
        vm.prank(alice);
        vm.expectRevert("ERC4626: withdraw more than max");
        pool.withdrawWithMaxShares(31e6, alice, alice, 100e12, block.timestamp + 300);
        mockCapitalAllowed = false;
        vm.prank(bob);
        vm.expectRevert("ERC4626: deposit more than max");
        pool.depositWithMinShares(1e6, bob, 1, block.timestamp + 300);
    }

    function testGuardedRedeemPreservesDelegatedOwnerAllowance() public {
        depositAlice(100e6);
        vm.prank(bob);
        vm.expectRevert("ERC20: insufficient allowance");
        pool.redeemWithMinAssets(10e12, bob, alice, 10e6, block.timestamp + 300);
        vm.prank(alice);
        pool.approve(bob, 10e12);
        vm.prank(bob);
        pool.redeemWithMinAssets(10e12, bob, alice, 10e6, block.timestamp + 300);
        assertEq(pool.allowance(alice, bob), 0);
        assertEq(cash.balanceOf(bob), 1010e6);
    }

    function testGuardedDepositRejectsTokenCallbackReentry() public {
        cash.setCallback(address(pool));
        vm.prank(alice);
        pool.depositWithMinShares(10e6, alice, 10e12, block.timestamp + 300);
        assertFalse(cash.callbackSucceeded());
    }

    function testBorrowDoesNotReduceShareValueButLimitsWithdrawal() public {
        depositAlice(100e6);
        pool.draw(borrower, 70e6);
        assertEq(pool.totalAssets(), 100e6);
        assertEq(pool.availableCash(), 30e6);
        assertEq(pool.maxWithdraw(alice), 30e6);
        assertLe(pool.previewRedeem(pool.maxRedeem(alice)), 30e6);
        vm.startPrank(alice);
        vm.expectRevert("ERC4626: withdraw more than max");
        pool.withdraw(31e6, alice, alice);
        pool.withdraw(30e6, alice, alice);
        vm.stopPrank();
        assertEq(pool.availableCash(), 0);
        assertEq(pool.outstandingPrincipal(), 70e6);
    }

    function testReceivedInterestBenefitsLendersAndFeeIsOnlyOnInterest() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        pool.repay(100e6, 10e6);
        assertEq(pool.totalAssets(), 109e6);
        assertEq(pool.protocolFees(), 1e6);
        assertEq(pool.outstandingPrincipal(), 0);
        uint256 lenderAssets = pool.previewRedeem(pool.balanceOf(alice));
        assertApproxEqAbs(lenderAssets, 109e6, 1);
        vm.prank(bob);
        pool.claimRevenue();
        assertEq(cash.balanceOf(treasury), 1e6);
        assertEq(pool.totalAssets(), 109e6);
        uint256 shares = pool.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(shares, alice, alice);
        assertEq(cash.balanceOf(alice), 900e6 + lenderAssets);
    }

    function testPrincipalRepaymentHasNoRevenueFee() public {
        depositAlice(100e6);
        pool.draw(borrower, 70e6);
        pool.repay(70e6, 0);
        assertEq(pool.totalAssets(), 100e6);
        assertEq(pool.protocolFees(), 0);
    }

    function testRecognizedLossReducesBothLendersClaims() public {
        depositAlice(100e6);
        vm.prank(bob);
        pool.deposit(100e6, bob);
        pool.draw(borrower, 100e6);
        pool.recognizeLoss(40e6, 0);
        assertEq(pool.totalAssets(), 160e6);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(alice)), 80e6, 1);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(bob)), 80e6, 1);
        assertEq(pool.cumulativeLoss(), 40e6);
    }

    function testPoolsDoNotShareCapitalOrLosses() public {
        DockyardIsolatedCapitalPool other = new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(collateral), address(this), treasury, 1000e6, 1000, 1000
        );
        cash.approve(address(other), 100e6);
        other.deposit(100e6, address(this));
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        pool.recognizeLoss(100e6, 0);
        assertEq(other.totalAssets(), 100e6);
        assertEq(other.availableCash(), 100e6);
    }

    function testCompleteLossBlocksNewCapitalUntilWorthlessSharesBurned() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        pool.recognizeLoss(100e6, 0);
        assertEq(pool.maxDeposit(bob), 0);
        assertEq(pool.maxMint(bob), 0);
        vm.prank(bob);
        vm.expectRevert("ERC4626: deposit more than max");
        pool.deposit(10e6, bob);
        uint256 shares = pool.balanceOf(alice);
        vm.prank(alice);
        assertEq(pool.redeem(shares, alice, alice), 0);
        assertEq(pool.totalSupply(), 0);
        vm.prank(bob);
        pool.deposit(10e6, bob);
        assertEq(pool.totalAssets(), 10e6);
    }

    function testOnlyEngineCanDrawRepayOrRecognizeLoss() public {
        depositAlice(100e6);
        vm.startPrank(bob);
        vm.expectRevert(DockyardIsolatedCapitalPool.EngineOnly.selector);
        pool.draw(bob, 1e6);
        vm.expectRevert(DockyardIsolatedCapitalPool.EngineOnly.selector);
        pool.repay(1e6, 0);
        vm.expectRevert(DockyardIsolatedCapitalPool.EngineOnly.selector);
        pool.recognizeLoss(1e6, 0);
        vm.stopPrank();
    }

    function testEngineCannotDrawBeyondCashOrLimit() public {
        depositAlice(1000e6);
        vm.prank(bob);
        pool.deposit(100e6, bob);
        vm.expectRevert(DockyardIsolatedCapitalPool.DebtLimitExceeded.selector);
        pool.draw(borrower, 1001e6);
        vm.expectRevert(DockyardIsolatedCapitalPool.InsufficientCash.selector);
        pool.draw(borrower, 1101e6);
    }

    function testCannotOverRepayOrWriteOffMoreThanDebt() public {
        depositAlice(100e6);
        pool.draw(borrower, 10e6);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidAmount.selector);
        pool.repay(11e6, 0);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidAmount.selector);
        pool.recognizeLoss(11e6, 0);
        assertEq(pool.outstandingPrincipal(), 10e6);
    }

    function testCannotWithdrawSomeoneElsesSharesWithoutAllowance() public {
        depositAlice(100e6);
        vm.prank(bob);
        vm.expectRevert("ERC20: insufficient allowance");
        pool.withdraw(10e6, bob, alice);
        vm.prank(alice);
        pool.approve(bob, 10e12);
        vm.prank(bob);
        pool.withdraw(10e6, bob, alice);
        assertEq(pool.allowance(alice, bob), 0);
    }

    function testRejectsTaxedDepositsAndRepaymentsAtomically() public {
        cash.setTaxed(true);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.UnsupportedTransfer.selector);
        pool.deposit(10e6, alice);
        assertEq(pool.totalSupply(), 0);
        assertEq(cash.balanceOf(alice), 1000e6);
        cash.setTaxed(false);
        depositAlice(100e6);
        pool.draw(borrower, 10e6);
        cash.setTaxed(true);
        vm.expectRevert(DockyardIsolatedCapitalPool.UnsupportedTransfer.selector);
        pool.repay(10e6, 0);
        assertEq(pool.outstandingPrincipal(), 10e6);
    }

    function testRejectsTaxedDrawAndWithdrawalAtomically() public {
        depositAlice(100e6);
        cash.setTaxed(true);
        vm.expectRevert(DockyardIsolatedCapitalPool.UnsupportedTransfer.selector);
        pool.draw(borrower, 10e6);
        assertEq(pool.outstandingPrincipal(), 0);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.UnsupportedTransfer.selector);
        pool.withdraw(10e6, alice, alice);
        assertEq(pool.totalAssets(), 100e6);
    }

    function testDonationAttackDoesNotProfitAttacker() public {
        vm.startPrank(bob);
        pool.deposit(1, bob);
        cash.transfer(address(pool), 100e6);
        vm.stopPrank();
        depositAlice(100e6);
        uint256 shares = pool.balanceOf(bob);
        vm.prank(bob);
        uint256 recovered = pool.redeem(shares, bob, bob);
        assertLt(recovered, 100e6 + 1);
        assertGt(pool.balanceOf(alice), 0);
    }

    function testRejectsSelfRecipientsAndZeroShares() public {
        vm.prank(alice);
        vm.expectRevert("ERC4626: deposit more than max");
        pool.deposit(10e6, address(pool));
        depositAlice(100e6);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidRecipient.selector);
        pool.draw(address(pool), 10e6);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidRecipient.selector);
        pool.withdraw(1e6, address(pool), alice);
        vm.prank(alice);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidAmount.selector);
        pool.deposit(0, alice);
    }

    function testLateLenderCannotCapturePreviouslyAccruedInterest() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        assertEq(pool.totalAssets(), 109e6);
        assertEq(pool.availableCash(), 0);
        assertEq(pool.protocolFees(), 0);
        uint256 quotedShares = pool.previewDeposit(100e6);
        vm.prank(bob);
        uint256 shares = pool.deposit(100e6, bob);
        assertEq(shares, quotedShares);
        assertLt(shares, pool.balanceOf(alice));
        assertEq(pool.interestReceivable(), 10e6);
        pool.repay(100e6, 10e6);
        assertApproxEqAbs(pool.convertToAssets(shares), 100e6, 1);
        assertApproxEqAbs(pool.convertToAssets(pool.balanceOf(alice)), 109e6, 1);
    }

    function testInterestCannotBeClaimedBeforePayment() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidAmount.selector);
        pool.claimRevenue();
        assertEq(pool.maxWithdraw(alice), 0);
        assertEq(pool.maxRedeem(alice), 0);
    }

    function testRepeatedAccrualCarriesFractionalInterestInsteadOfErasingIt() public {
        depositAlice(100e6);
        pool.draw(borrower, 12345678);
        uint256 start = block.timestamp;
        for (uint256 i = 1; i <= 100; ++i) {
            vm.warp(start + i);
            pool.accrueInterest();
        }
        assertEq(pool.interestReceivable(), uint256(12345678) * 1000 * 100 / (10000 * 365 days));
    }

    function testNewDrawDoesNotReceiveRetroactiveInterest() public {
        depositAlice(200e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        pool.draw(borrower, 100e6);
        assertEq(pool.interestReceivable(), 10e6);
        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        assertEq(pool.interestReceivable(), 30e6);
    }

    function testLostInterestAndPrincipalReduceClaimsWithoutChargingUnpaidFees() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        pool.recognizeLoss(100e6, 10e6);
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.protocolFees(), 0);
        assertEq(pool.interestReceivable(), 0);
        assertEq(pool.cumulativeLoss(), 110e6);
    }

    function testSplittingInterestRepaymentDoesNotAvoidReservedFee() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        uint256 beforeAssets = pool.totalAssets();
        pool.repay(0, 1);
        pool.repay(0, 2);
        pool.repay(0, 10e6 - 3);
        assertEq(pool.protocolFees(), 1e6);
        assertEq(pool.totalAssets(), beforeAssets);
    }

    function testUnaccruedYieldCannotBeReportedAsInterest() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidAmount.selector);
        pool.repay(100e6, 1);
        assertEq(pool.outstandingPrincipal(), 100e6);
    }

    function testMintQuotesIncludePendingInterest() public {
        depositAlice(100e6);
        pool.draw(borrower, 100e6);
        vm.warp(block.timestamp + 365 days);
        uint256 assets = pool.previewMint(10e12);
        vm.prank(bob);
        assertEq(pool.mint(10e12, bob), assets);
        assertEq(pool.balanceOf(bob), 10e12);
    }

    function testTransferCallbackCannotReenterAccounting() public {
        cash.setCallback(address(pool));
        depositAlice(100e6);
        assertFalse(cash.callbackSucceeded());
        pool.draw(borrower, 10e6);
        assertFalse(cash.callbackSucceeded());
        pool.repay(10e6, 0);
        assertFalse(cash.callbackSucceeded());
        vm.prank(alice);
        pool.withdraw(10e6, alice, alice);
        assertFalse(cash.callbackSucceeded());
    }

    function testRejectsInvalidConfiguration() public {
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidConfiguration.selector);
        new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(collateral), bob, treasury, 1000e6, 1000, 1000
        );
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidConfiguration.selector);
        new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(collateral), address(this), treasury, 1000e6, 2001, 1000
        );
        vm.expectRevert(DockyardIsolatedCapitalPool.InvalidConfiguration.selector);
        new DockyardIsolatedCapitalPool(
            IERC20Metadata(address(cash)), address(cash), address(this), treasury, 1000e6, 1000, 1000
        );
    }

    function testFuzzRepaymentConservesPrincipalAndDistributesOnlyNetYield(uint96 drawRaw, uint96 yieldRaw) public {
        uint256 amount = bound(uint256(drawRaw), 1, 1000e6);
        uint256 elapsed = bound(uint256(yieldRaw), 0, 365 days);
        depositAlice(1000e6);
        pool.draw(borrower, amount);
        vm.warp(block.timestamp + elapsed);
        uint256 income = pool.pendingInterest();
        cash.mint(address(this), income);
        pool.repay(amount, income);
        uint256 fee = income * 1000 / 10000;
        assertEq(pool.totalAssets(), 1000e6 + income - fee);
        assertEq(pool.protocolFees(), fee);
        assertEq(pool.outstandingPrincipal(), 0);
        assertLe(pool.previewRedeem(pool.maxRedeem(alice)), pool.availableCash());
    }
}
