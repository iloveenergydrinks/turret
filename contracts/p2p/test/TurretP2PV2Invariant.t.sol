// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {P2PToken, IERC20, TurretP2PLendingV2} from "./P2PV2TestSupport.sol";

/// @dev Stateful model uses independent transition, cash flow and credit ledgers.
///      24 actors can all lend, borrow public offers and receive private offers. No target reverts are
///      swallowed: fail_on_revert makes unexpected handler or market errors fail fuzzing.
contract P2PV2Handler is Test {
    P2PToken public usd;
    P2PToken public slv;
    TurretP2PLendingV2 public market;
    address[] public actors;
    mapping(address => uint256) public actorIndex;
    mapping(uint256 => TurretP2PLendingV2.Status) public expectedStatus;
    mapping(uint256 => bytes32) public originalTerms;
    mapping(uint256 => uint256) public expectedDueAt;
    mapping(uint256 => address) public expectedBorrower;
    mapping(uint256 => bool) public expectedPublic;
    mapping(uint256 => uint256) public expectedCreatedAt;
    mapping(address => uint256[]) private expectedAccountIds;
    uint256[] private expectedPublicIds;
    mapping(address => uint256) public usdWithdrawn;
    mapping(address => uint256) public slvWithdrawn;
    uint256 public principalFunded;
    uint256 public principalDisbursed;
    uint256 public repaymentsFunded;
    uint256 public collateralDeposited;
    uint256 public totalUsdWithdrawn;
    uint256 public totalSlvWithdrawn;
    uint256 public usdDonated;
    uint256 public slvDonated;
    uint256 public acceptedCount;
    uint256 public settledCount;
    uint256 public expiredCount;
    uint256 public cancelledCount;

    constructor() {
        vm.warp(1_800_000_000);
        usd = new P2PToken("USDG", 6);
        slv = new P2PToken("SLV", 18);
        for (uint256 i; i < 24; ++i) {
            address actor = address(uint160(10_000 + i));
            actors.push(actor);
            actorIndex[actor] = i;
        }
        market = new TurretP2PLendingV2(usd, slv, address(this));
        for (uint256 i; i < 24; ++i) {
            usd.mint(actors[i], 1_000_000_000e6);
            slv.mint(actors[i], 1_000_000e18);
            vm.startPrank(actors[i]);
            usd.approve(address(market), type(uint256).max);
            slv.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
        // Seed meaningful positions, so short sequences still exercise settlements.
        for (uint256 i; i < 8; ++i) create(i, i + 12, 100e6, 40e18, 5e6, i);
        for (uint256 i; i < 4; ++i) accept(i);
    }

    function create(uint256 lenderSeed, uint256 borrowerSeed, uint256 pSeed,
        uint256 cSeed, uint256 interestSeed, uint256 termSeed) public {
        if (market.newLoansPaused() || market.nextOfferId() > 256) return;
        TurretP2PLendingV2.Offer memory o;
        o.principal = bound(pSeed, 1, 50_000e6);
        o.collateralAmount = bound(cSeed, 1, 2_000e18);
        o.interest = bound(interestSeed, 0, 100_000e6);
        o.lender = actors[lenderSeed % 24];
        o.borrower = borrowerSeed % 2 == 0 ? address(0) : actors[(lenderSeed % 24 + 1 + borrowerSeed % 23) % 24];
        o.duration = (1 + termSeed % 90) * 1 days;
        o.expiresAt = block.timestamp + (1 + termSeed % 60) * 1 days;
        vm.prank(o.lender);
        uint256 id = market.createOffer(o.borrower, o.principal, o.collateralAmount, o.interest, o.duration, o.expiresAt);
        expectedStatus[id] = TurretP2PLendingV2.Status.Open;
        originalTerms[id] = _terms(offer(id));
        expectedBorrower[id] = o.borrower;
        expectedPublic[id] = o.borrower == address(0);
        expectedCreatedAt[id] = block.timestamp;
        expectedAccountIds[o.lender].push(id);
        if (o.borrower == address(0)) expectedPublicIds.push(id);
        else expectedAccountIds[o.borrower].push(id);
        principalFunded += o.principal;
    }

    function accept(uint256 seed) public {
        uint256 id = _id(seed);
        TurretP2PLendingV2.Offer memory o = offer(id);
        if (market.newLoansPaused() || o.status != TurretP2PLendingV2.Status.Open || block.timestamp >= o.expiresAt) return;
        address taker = o.borrower;
        if (taker == address(0)) {
            taker = actors[(actorIndex[o.lender] + 1 + seed % 23) % 24];
            expectedAccountIds[taker].push(id);
        }
        vm.prank(taker);
        market.acceptOffer(id);
        expectedBorrower[id] = taker;
        expectedStatus[id] = TurretP2PLendingV2.Status.Active;
        expectedDueAt[id] = block.timestamp + o.duration;
        acceptedCount++;
        principalDisbursed += o.principal;
        collateralDeposited += o.collateralAmount;
    }

    function cancel(uint256 seed) public {
        uint256 id = _id(seed);
        TurretP2PLendingV2.Offer memory o = offer(id);
        if (o.status != TurretP2PLendingV2.Status.Open) return;
        vm.prank(o.lender);
        market.cancelOffer(id);
        expectedStatus[id] = TurretP2PLendingV2.Status.Cancelled;
        cancelledCount++;
    }

    function expire(uint256 seed, uint256 callerSeed) public {
        uint256 id = _id(seed);
        TurretP2PLendingV2.Offer memory o = offer(id);
        if (o.status != TurretP2PLendingV2.Status.Open || block.timestamp < o.expiresAt) return;
        vm.prank(actors[callerSeed % 24]);
        market.expireOffer(id);
        expectedStatus[id] = TurretP2PLendingV2.Status.Expired;
        expiredCount++;
    }

    function repay(uint256 seed, uint256 payerSeed) public {
        uint256 id = _id(seed);
        TurretP2PLendingV2.Offer memory o = offer(id);
        if (o.status != TurretP2PLendingV2.Status.Active || block.timestamp > market.repaymentDeadline(id)) return;
        vm.prank(actors[payerSeed % 24]);
        market.repay(id);
        expectedStatus[id] = TurretP2PLendingV2.Status.Repaid;
        settledCount++;
        repaymentsFunded += o.principal + o.interest;
    }

    function claimDefault(uint256 seed, uint256 callerSeed) public {
        uint256 id = _id(seed);
        TurretP2PLendingV2.Offer memory o = offer(id);
        if (o.status != TurretP2PLendingV2.Status.Active || block.timestamp <= market.repaymentDeadline(id)) return;
        vm.prank(actors[callerSeed % 24]);
        market.claimDefault(id);
        expectedStatus[id] = TurretP2PLendingV2.Status.Defaulted;
        settledCount++;
    }

    function withdraw(uint256 actorSeed, uint256 tokenSeed, uint256 amountSeed, uint256 recipientSeed) public {
        address actor = actors[actorSeed % 24];
        IERC20 token = tokenSeed % 2 == 0 ? IERC20(address(usd)) : IERC20(address(slv));
        uint256 credit = market.credits(address(token), actor);
        if (credit == 0) return;
        uint256 amount = bound(amountSeed, 1, credit);
        vm.prank(actor);
        market.withdraw(token, amount, actors[recipientSeed % 24]);
        if (address(token) == address(usd)) {
            usdWithdrawn[actor] += amount;
            totalUsdWithdrawn += amount;
        } else {
            slvWithdrawn[actor] += amount;
            totalSlvWithdrawn += amount;
        }
    }

    function elapse(uint256 secondsSeed) public {
        vm.warp(block.timestamp + bound(secondsSeed, 0, 8 days));
    }

    function pause(bool value) public { market.setNewLoansPaused(value); }

    function donate(uint256 usdSeed, uint256 slvSeed) public {
        uint256 usdAmount = bound(usdSeed, 0, 100e6);
        uint256 slvAmount = bound(slvSeed, 0, 100e18);
        usd.mint(address(market), usdAmount);
        slv.mint(address(market), slvAmount);
        usdDonated += usdAmount;
        slvDonated += slvAmount;
    }

    function assertModel() public view {
        uint256 reserved;
        uint256 committed;
        uint256 collateral;
        uint256 active;
        uint256 terminal;
        uint256[] memory earnedUsd = new uint256[](24);
        uint256[] memory earnedSlv = new uint256[](24);
        for (uint256 id = 1; id < market.nextOfferId(); ++id) {
            TurretP2PLendingV2.Offer memory o = offer(id);
            assertEq(uint256(o.status), uint256(expectedStatus[id]), "unexpected transition or double settlement");
            assertEq(_terms(o), originalTerms[id], "immutable offer terms changed");
            assertEq(o.dueAt, expectedDueAt[id], "due date changed");
            assertEq(o.borrower, expectedBorrower[id], "public borrower bound incorrectly");
            assertEq(market.isPublicOffer(id), expectedPublic[id], "visibility changed");
            assertEq(market.offerCreatedAt(id), expectedCreatedAt[id], "creation time changed");
            uint256 lenderIdx = actorIndex[o.lender];
            uint256 borrowerIdx = actorIndex[o.borrower];
            if (o.status == TurretP2PLendingV2.Status.Open) {
                reserved += o.principal;
                committed += o.principal;
            } else if (o.status == TurretP2PLendingV2.Status.Active) {
                committed += o.principal;
                collateral += o.collateralAmount;
                active++;
            } else if (o.status == TurretP2PLendingV2.Status.Repaid) {
                earnedUsd[lenderIdx] += o.principal + o.interest;
                earnedSlv[borrowerIdx] += o.collateralAmount;
                terminal++;
            } else if (o.status == TurretP2PLendingV2.Status.Defaulted) {
                earnedSlv[lenderIdx] += o.collateralAmount;
                terminal++;
            } else {
                assertTrue(o.status == TurretP2PLendingV2.Status.Cancelled || o.status == TurretP2PLendingV2.Status.Expired);
                earnedUsd[lenderIdx] += o.principal;
                terminal++;
            }
        }
        assertEq(market.committedPrincipal(), committed);
        assertEq(market.reservedPrincipal(), reserved);
        assertEq(market.lockedCollateral(), collateral);
        assertEq(active + settledCount, acceptedCount);
        assertEq(terminal, settledCount + expiredCount + cancelledCount);
        uint256 usdCredits;
        uint256 slvCredits;
        for (uint256 i; i < 24; ++i) {
            uint256 expectedUsd = earnedUsd[i] - usdWithdrawn[actors[i]];
            uint256 expectedSlv = earnedSlv[i] - slvWithdrawn[actors[i]];
            assertEq(market.credits(address(usd), actors[i]), expectedUsd, "USDG credit owner/amount");
            assertEq(market.credits(address(slv), actors[i]), expectedSlv, "collateral credit owner/amount");
            usdCredits += expectedUsd;
            slvCredits += expectedSlv;
        }
        _assertIndexes();
        assertEq(market.totalCredits(address(usd)), usdCredits);
        assertEq(market.totalCredits(address(slv)), slvCredits);
        assertEq(usd.balanceOf(address(market)), reserved + usdCredits + usdDonated, "USDG solvency");
        assertEq(slv.balanceOf(address(market)), collateral + slvCredits + slvDonated, "collateral solvency");
        assertEq(usd.balanceOf(address(market)), principalFunded - principalDisbursed + repaymentsFunded - totalUsdWithdrawn + usdDonated, "USDG cash flow");
        assertEq(slv.balanceOf(address(market)), collateralDeposited - totalSlvWithdrawn + slvDonated, "collateral cash flow");
    }

    /// @dev At the end of each fuzz sequence, recovery must drain every liability even
    ///      while paused and when lenders never return to claim their overdue loans.
    function closeAndWithdrawEverything() external {
        market.setNewLoansPaused(true);
        vm.warp(block.timestamp + 100 days);
        for (uint256 id = 1; id < market.nextOfferId(); ++id) {
            TurretP2PLendingV2.Status status = offer(id).status;
            if (status == TurretP2PLendingV2.Status.Open) expire(id - 1, 23);
            else if (status == TurretP2PLendingV2.Status.Active) claimDefault(id - 1, 23);
        }
        for (uint256 i; i < 24; ++i) {
            withdraw(i, 0, market.credits(address(usd), actors[i]), i);
            withdraw(i, 1, market.credits(address(slv), actors[i]), i);
        }
        assertModel();
        assertEq(market.committedPrincipal(), 0);
        assertEq(market.reservedPrincipal(), 0);
        assertEq(market.lockedCollateral(), 0);
        assertEq(market.totalCredits(address(usd)), 0);
        assertEq(market.totalCredits(address(slv)), 0);
        assertEq(usd.balanceOf(address(market)), usdDonated);
        assertEq(slv.balanceOf(address(market)), slvDonated);
    }

    function _assertIndexes() private view {
        for (uint256 i; i < actors.length; ++i) {
            uint256 remaining = expectedAccountIds[actors[i]].length;
            uint256 cursor;
            do {
                (uint256[] memory ids, uint256 next) = market.getAccountOfferIds(actors[i], cursor, 50);
                uint256 count = remaining < 50 ? remaining : 50;
                assertEq(ids.length, count, "account index length");
                for (uint256 j; j < count; ++j) {
                    assertEq(ids[j], expectedAccountIds[actors[i]][remaining - 1 - j], "missing/duplicate account association");
                }
                remaining -= count;
                assertEq(next, remaining, "account cursor");
                cursor = next;
            } while (cursor != 0);
        }
        uint256 remainingPublic = expectedPublicIds.length;
        uint256 publicCursor;
        do {
            (uint256[] memory ids, uint256 next) = market.getPublicOfferIds(publicCursor, 50);
            uint256 count = remainingPublic < 50 ? remainingPublic : 50;
            assertEq(ids.length, count, "public index length");
            for (uint256 j; j < count; ++j) {
                assertEq(ids[j], expectedPublicIds[remainingPublic - 1 - j], "private offer leaked or public entry missing");
            }
            remainingPublic -= count;
            assertEq(next, remainingPublic, "public cursor");
            publicCursor = next;
        } while (publicCursor != 0);
    }

    function offer(uint256 id) public view returns (TurretP2PLendingV2.Offer memory o) {
        (bool ok, bytes memory encoded) = address(market).staticcall(abi.encodeWithSelector(market.offers.selector, id));
        require(ok, "read offer failed");
        o = abi.decode(encoded, (TurretP2PLendingV2.Offer));
    }

    function _id(uint256 seed) private view returns (uint256) { return 1 + seed % (market.nextOfferId() - 1); }
    function _terms(TurretP2PLendingV2.Offer memory o) private pure returns (bytes32) {
        return keccak256(abi.encode(o.lender, o.principal, o.collateralAmount, o.interest, o.duration, o.expiresAt));
    }
}

contract TurretP2PV2InvariantTest is StdInvariant, Test {
    P2PV2Handler internal handler;

    function setUp() public {
        handler = new P2PV2Handler();
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = P2PV2Handler.create.selector;
        selectors[1] = P2PV2Handler.accept.selector;
        selectors[2] = P2PV2Handler.cancel.selector;
        selectors[3] = P2PV2Handler.expire.selector;
        selectors[4] = P2PV2Handler.repay.selector;
        selectors[5] = P2PV2Handler.claimDefault.selector;
        selectors[6] = P2PV2Handler.withdraw.selector;
        selectors[7] = P2PV2Handler.elapse.selector;
        selectors[8] = P2PV2Handler.pause.selector;
        selectors[9] = P2PV2Handler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariantEveryLiabilityBackedEveryCreditOwnedEveryLoanSettledAtMostOnce() public view {
        handler.assertModel();
    }

    function afterInvariant() public { handler.closeAndWithdrawEverything(); }
}
