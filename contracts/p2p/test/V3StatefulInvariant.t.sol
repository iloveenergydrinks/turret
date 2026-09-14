// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {V3TestBase, TurretP2PLendingV3} from "./V3TestSupport.sol";

/// @dev The model records actual cash flows, face claims and party rights separately. Token
/// confiscation and donations alter model assets only, never model claims or agreed debt.
contract V3StatefulHandler is V3TestBase {
    struct Model {
        address lender; address borrower; uint256 principal; uint256 expiresAt; uint256 dueAt;
        TurretP2PLendingV3.Status status; uint256 usdBalance; uint256 collateralBalance;
        uint256 usdFace; uint256 collateralFace; uint256 extensionNonce;
    }
    mapping(uint256 => Model) private model;
    uint256 public count;
    uint256 public funded;
    uint256 public accepted;
    uint256 public settled;
    uint256 public lostUsd;
    uint256 public lostCollateral;
    uint256 public writtenOffUsd;
    uint256 public writtenOffCollateral;
    uint256 public creditRepayments;

    constructor() {
        setUp();
        for (uint256 i; i < 6; ++i) create(i, P + i * 1e6);
        accept(0); accept(1); accept(2);
        close(3, false);
    }
    function _actor(uint256 seed) private pure returns (address) {
        return [LENDER, BORROWER, PAYER, OTHER][seed % 4];
    }
    function _id(uint256 seed) private view returns (uint256) { return 1 + seed % count; }
    function create(uint256 seed, uint256 principalSeed) public {
        if (count == 24) return;
        address lender = _actor(seed); address borrower = _actor(seed % 4 + 1);
        uint256 principal = bound(principalSeed, 1e6, 10_000e6);
        uint256 id = _create(lender, borrower, principal);
        ++count; ++funded;
        model[id] = Model(lender, borrower, principal, block.timestamp + 1 days, 0,
            TurretP2PLendingV3.Status.Open, principal, 0, 0, 0, 0);
    }
    function accept(uint256 seed) public {
        uint256 id = _id(seed); Model storage m = model[id];
        if (m.status != TurretP2PLendingV3.Status.Open || block.timestamp >= m.expiresAt || m.usdBalance < m.principal) return;
        vm.prank(m.borrower); market.acceptOffer(id);
        m.status = TurretP2PLendingV3.Status.Active; m.dueAt = block.timestamp + 10 days;
        m.usdBalance -= m.principal; m.collateralBalance += C; ++accepted;
    }
    function close(uint256 seed, bool useExpiry) public {
        uint256 id = _id(seed); Model storage m = model[id];
        if (m.status != TurretP2PLendingV3.Status.Open) return;
        if (useExpiry && block.timestamp < m.expiresAt) return;
        if (useExpiry) market.expireOffer(id);
        else { vm.prank(m.lender); market.cancelOffer(id); }
        m.status = useExpiry ? TurretP2PLendingV3.Status.Expired : TurretP2PLendingV3.Status.Cancelled;
        m.usdFace = m.principal;
    }
    function settle(uint256 seed, uint256 payerSeed) public {
        uint256 id = _id(seed); Model storage m = model[id];
        if (m.status != TurretP2PLendingV3.Status.Active) return;
        if (block.timestamp <= m.dueAt + 1 days) {
            vm.prank(_actor(payerSeed)); market.repay(id);
            m.status = TurretP2PLendingV3.Status.Repaid;
            m.usdBalance += m.principal + I; m.usdFace = m.principal + I;
        } else {
            market.claimDefault(id); m.status = TurretP2PLendingV3.Status.Defaulted;
        }
        m.collateralFace = C; ++settled;
    }
    function repayCredit(uint256 sourceSeed, uint256 targetSeed, uint256 amountSeed) public {
        uint256 source = _id(sourceSeed); uint256 target = _id(targetSeed);
        Model storage s = model[source]; Model storage t = model[target];
        uint256 available = s.usdFace < s.usdBalance ? s.usdFace : s.usdBalance;
        if (source == target || available == 0 || t.status != TurretP2PLendingV3.Status.Active || block.timestamp > t.dueAt + 1 days) return;
        uint256 debt = t.principal + I;
        uint256 amount = bound(amountSeed, 1, available < debt ? available : debt);
        (uint256[] memory ids, uint256[] memory amounts) = _sources(source, amount);
        vm.prank(s.lender); market.repayWithCredits(target, ids, amounts, debt - amount);
        s.usdFace -= amount; s.usdBalance -= amount;
        t.usdBalance += debt; t.usdFace = debt; t.collateralFace = C;
        t.status = TurretP2PLendingV3.Status.Repaid; ++settled; ++creditRepayments;
    }
    function changeBacking(uint256 seed, uint256 amountSeed, bool isCollateral, bool donation) public {
        uint256 id = _id(seed); Model storage m = model[id];
        uint256 balance = isCollateral ? m.collateralBalance : m.usdBalance;
        uint256 amount = bound(amountSeed, 0, donation ? (isCollateral ? 5e18 : 20e6) : balance);
        if (isCollateral) {
            if (donation) { collateral.mint(market.vaults(id), amount); m.collateralBalance += amount; }
            else { collateral.removeBalance(market.vaults(id), amount); m.collateralBalance -= amount; lostCollateral += amount; }
        } else {
            if (donation) { usd.mint(market.vaults(id), amount); m.usdBalance += amount; }
            else { usd.removeBalance(market.vaults(id), amount); m.usdBalance -= amount; lostUsd += amount; }
        }
    }
    function withdraw(uint256 seed, uint256 amountSeed, bool isCollateral, bool realizeLoss) public {
        uint256 id = _id(seed); Model storage m = model[id];
        uint256 face = isCollateral ? m.collateralFace : m.usdFace;
        if (face == 0) return;
        uint256 balance = isCollateral ? m.collateralBalance : m.usdBalance;
        uint256 available = face < balance ? face : balance;
        if (!realizeLoss && available == 0) return;
        uint256 amount = realizeLoss ? available : bound(amountSeed, 1, available);
        address owner = isCollateral && m.status == TurretP2PLendingV3.Status.Repaid ? m.borrower : m.lender;
        vm.prank(owner);
        if (realizeLoss) market.withdrawAvailableCredit(id, isCollateral ? collateral : usd, amount, owner);
        else market.withdrawCredit(id, isCollateral ? collateral : usd, amount, owner);
        if (isCollateral) {
            m.collateralBalance -= amount; m.collateralFace -= realizeLoss ? face : amount;
            if (realizeLoss) writtenOffCollateral += face - amount;
        } else {
            m.usdBalance -= amount; m.usdFace -= realizeLoss ? face : amount;
            if (realizeLoss) writtenOffUsd += face - amount;
        }
    }
    function extend(uint256 seed, uint256 extraSeed, bool lenderProposes) public {
        uint256 id = _id(seed); Model storage m = model[id];
        if (m.status != TurretP2PLendingV3.Status.Active) return;
        uint256 old = m.dueAt + 1 days;
        uint256 next = old + bound(extraSeed, 1, 30) * 1 days;
        if (next <= block.timestamp + 1 days) next = block.timestamp + 2 days;
        uint256 expires = block.timestamp + 1 days;
        vm.prank(lenderProposes ? m.lender : m.borrower); market.proposeExtension(id, next, expires);
        vm.prank(lenderProposes ? m.borrower : m.lender);
        market.acceptExtension(id, ++m.extensionNonce, old, next, expires);
        m.dueAt = next - 1 days;
    }
    function elapse(uint256 seed) public { vm.warp(block.timestamp + bound(seed, 0, 2 days)); }

    /// @dev Every fuzzed state must still permit all contracts to reach terminal status and
    /// every owner to close its claim, including fully confiscated balances, without an admin.
    function closeAndRecoverAll() external {
        uint256 lastDeadline = block.timestamp;
        for (uint256 id = 1; id <= count; ++id) {
            if (model[id].status == TurretP2PLendingV3.Status.Active && model[id].dueAt + 1 days >= lastDeadline) {
                lastDeadline = model[id].dueAt + 1 days + 1;
            }
        }
        vm.warp(lastDeadline);
        for (uint256 id = 1; id <= count; ++id) {
            if (model[id].status == TurretP2PLendingV3.Status.Open) close(id - 1, false);
            if (model[id].status == TurretP2PLendingV3.Status.Active) settle(id - 1, 0);
            withdraw(id - 1, 0, false, true);
            withdraw(id - 1, 0, true, true);
        }
        this.assertModel();
        assertEq(market.committedPrincipal(), 0); assertEq(market.reservedPrincipal(), 0);
        assertEq(market.lockedCollateral(), 0); assertEq(market.totalCredits(address(usd)), 0);
        assertEq(market.totalCredits(address(collateral)), 0);
    }

    function assertModel() external view {
        uint256 expectedCommitted; uint256 expectedReserved; uint256 expectedLocked;
        uint256 expectedUsdClaims; uint256 expectedCollateralClaims;
        uint256[4] memory expectedUsdByActor; uint256[4] memory expectedCollateralByActor;
        for (uint256 id = 1; id <= count; ++id) {
            Model memory m = model[id]; TurretP2PLendingV3.Offer memory o = _offer(id);
            assertEq(o.lender, m.lender); assertEq(o.borrower, m.borrower);
            assertEq(o.principal, m.principal); assertEq(o.collateralAmount, C); assertEq(o.interest, I);
            assertEq(o.duration, 10 days); assertEq(o.expiresAt, m.expiresAt); assertEq(o.dueAt, m.dueAt);
            assertEq(uint256(o.status), uint256(m.status));
            assertEq(usd.balanceOf(market.vaults(id)), m.usdBalance);
            assertEq(collateral.balanceOf(market.vaults(id)), m.collateralBalance);
            address uOwner = m.status == TurretP2PLendingV3.Status.Repaid || m.status == TurretP2PLendingV3.Status.Cancelled
                || m.status == TurretP2PLendingV3.Status.Expired ? m.lender : address(0);
            address cOwner = m.status == TurretP2PLendingV3.Status.Repaid ? m.borrower
                : m.status == TurretP2PLendingV3.Status.Defaulted ? m.lender : address(0);
            _assertCredit(id, usd, uOwner, m.usdFace, m.usdFace < m.usdBalance ? m.usdFace : m.usdBalance);
            _assertCredit(id, collateral, cOwner, m.collateralFace, m.collateralFace < m.collateralBalance ? m.collateralFace : m.collateralBalance);
            if (m.status == TurretP2PLendingV3.Status.Open || m.status == TurretP2PLendingV3.Status.Active) expectedCommitted += m.principal;
            if (m.status == TurretP2PLendingV3.Status.Open) expectedReserved += m.principal;
            if (m.status == TurretP2PLendingV3.Status.Active) expectedLocked += C;
            expectedUsdClaims += m.usdFace; expectedCollateralClaims += m.collateralFace;
            for (uint256 a; a < 4; ++a) {
                if (uOwner == _actor(a)) expectedUsdByActor[a] += m.usdFace;
                if (cOwner == _actor(a)) expectedCollateralByActor[a] += m.collateralFace;
            }
        }
        assertEq(market.nextOfferId(), count + 1);
        assertEq(market.committedPrincipal(), expectedCommitted); assertEq(market.reservedPrincipal(), expectedReserved);
        assertEq(market.lockedCollateral(), expectedLocked);
        assertEq(market.totalCredits(address(usd)), expectedUsdClaims);
        assertEq(market.totalCredits(address(collateral)), expectedCollateralClaims);
        assertEq(usd.balanceOf(address(market)), 0); assertEq(collateral.balanceOf(address(market)), 0);
        for (uint256 a; a < 4; ++a) {
            address actor = _actor(a);
            assertEq(market.credits(address(usd), actor), expectedUsdByActor[a]);
            assertEq(market.credits(address(collateral), actor), expectedCollateralByActor[a]);
            (uint256[] memory active,,) = market.getActiveLoanIds(actor, 0, 50, 0);
            uint256 expectedCount;
            for (uint256 id = 1; id <= count; ++id) {
                if (model[id].status == TurretP2PLendingV3.Status.Active && (model[id].lender == actor || model[id].borrower == actor)) {
                    ++expectedCount; uint256 matches;
                    for (uint256 n; n < active.length; ++n) if (active[n] == id) ++matches;
                    assertEq(matches, 1);
                }
            }
            assertEq(active.length, expectedCount);
        }
    }
}

contract V3StatefulInvariantTest is StdInvariant, Test {
    V3StatefulHandler internal handler;
    function setUp() public {
        handler = new V3StatefulHandler();
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.create.selector; selectors[1] = handler.accept.selector;
        selectors[2] = handler.close.selector; selectors[3] = handler.settle.selector;
        selectors[4] = handler.repayCredit.selector; selectors[5] = handler.changeBacking.selector;
        selectors[6] = handler.withdraw.selector; selectors[7] = handler.extend.selector; selectors[8] = handler.elapse.selector;
        targetSelector(FuzzSelector(address(handler), selectors)); targetContract(address(handler));
    }
    function invariantEachVaultMatchesIndependentCashFlowsClaimsTermsAndActiveMembership() public view { handler.assertModel(); }
    function afterInvariant() public { handler.closeAndRecoverAll(); }
}
