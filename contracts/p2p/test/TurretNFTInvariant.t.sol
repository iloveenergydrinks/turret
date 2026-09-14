// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {TestNFT, P2PToken, TurretNFTLending} from "./TurretNFTLending.t.sol";

contract NFTLifecycleHandler is Test {
    TurretNFTLending public market;
    P2PToken public usd;
    TestNFT public nft;
    address public constant LENDER = address(0xA11CE);
    address public constant BORROWER = address(0xB0B);
    address public constant PAYER = address(0xCA11);
    uint256 public minted;
    constructor(TurretNFTLending m, P2PToken u, TestNFT n) { market = m; usd = u; nft = n; }
    function create(uint96 amount, uint96 interest, bool publicOffer) external {
        if (market.newLoansPaused() || !market.allowedCollections(address(nft)) || minted >= 32) return;
        amount = uint96(bound(amount, 1, 1000e6)); interest = uint96(bound(interest, 0, 100e6));
        uint256 id = minted++;
        nft.mint(BORROWER, id);
        vm.prank(BORROWER); nft.approve(address(market), id);
        vm.prank(LENDER); market.createOffer(TurretNFTLending.Terms(publicOffer ? address(0) : BORROWER,
            address(nft), id, amount, interest, 1 days, block.timestamp + 2 days));
    }
    function step(uint256 seed, uint8 action, uint96 portion) external {
        if (market.nextOfferId() == 1) return;
        uint256 id = bound(seed, 1, market.nextOfferId() - 1);
        TurretNFTLending.Offer memory o = market.getOffer(id);
        action %= 7;
        if (action == 0 && o.status == TurretNFTLending.Status.Open && block.timestamp < o.terms.expiresAt
            && !market.newLoansPaused() && market.allowedCollections(address(nft))) {
            vm.prank(BORROWER); market.acceptOffer(id);
        } else if (action == 1 && o.status == TurretNFTLending.Status.Open) {
            vm.prank(LENDER); market.cancelOffer(id);
        } else if (action == 2 && o.status == TurretNFTLending.Status.Open && block.timestamp >= o.terms.expiresAt) {
            market.expireOffer(id);
        } else if (action == 3 && o.status == TurretNFTLending.Status.Active && block.timestamp <= o.dueAt + 1 days) {
            vm.prank(PAYER); market.repay(id);
        } else if (action == 4 && o.status == TurretNFTLending.Status.Active && block.timestamp > o.dueAt + 1 days) {
            market.settleDefault(id);
        } else if (action == 5 && o.usdgCredit > 0) {
            uint256 amount = bound(portion, 1, o.usdgCredit);
            vm.prank(LENDER); market.withdrawUSDG(id, amount, LENDER);
        } else if (action == 6 && o.nftBeneficiary != address(0)) {
            vm.prank(o.nftBeneficiary); market.withdrawNFT(id, o.nftBeneficiary);
        }
    }
    function advance(uint32 seconds_) external { vm.warp(block.timestamp + bound(seconds_, 0, 3 days)); }
    function admission(bool paused, bool allowed) external {
        market.setNewLoansPaused(paused); market.setCollectionAllowed(address(nft), allowed);
    }
}

contract TurretNFTInvariantTest is StdInvariant, Test {
    P2PToken usd; TestNFT nft; TurretNFTLending market; NFTLifecycleHandler handler;
    function setUp() public {
        vm.warp(1_800_000_000);
        usd = new P2PToken("USDG", 6); nft = new TestNFT();
        market = new TurretNFTLending(usd, address(this));
        market.setCollectionAllowed(address(nft), true); market.setNewLoansPaused(false);
        handler = new NFTLifecycleHandler(market, usd, nft);
        market.nominateOwner(address(handler)); vm.prank(address(handler)); market.acceptOwnership();
        usd.mint(handler.LENDER(), 1_000_000e6); usd.mint(handler.PAYER(), 1_000_000e6);
        vm.prank(handler.LENDER()); usd.approve(address(market), type(uint256).max);
        vm.prank(handler.PAYER()); usd.approve(address(market), type(uint256).max);
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.create.selector; selectors[1] = handler.step.selector;
        selectors[2] = handler.advance.selector; selectors[3] = handler.admission.selector;
        targetSelector(FuzzSelector(address(handler), selectors)); targetContract(address(handler));
    }
    function invariantAccountingAndCustodyConserveEveryAsset() public view {
        uint256 reserved; uint256 active; uint256 credits;
        uint256 balances = usd.balanceOf(handler.LENDER()) + usd.balanceOf(handler.PAYER()) + usd.balanceOf(handler.BORROWER());
        for (uint256 id = 1; id < market.nextOfferId(); id++) {
            TurretNFTLending.Offer memory o = market.getOffer(id);
            uint256 backing = o.usdgCredit;
            if (o.status == TurretNFTLending.Status.Open) { reserved += o.terms.principal; backing += o.terms.principal; }
            if (o.status == TurretNFTLending.Status.Active) { active += o.terms.principal; assertEq(nft.ownerOf(o.terms.tokenId), o.vault); }
            if (o.nftBeneficiary != address(0)) {
                assertEq(nft.ownerOf(o.terms.tokenId), o.vault);
                assertEq(o.nftBeneficiary, o.status == TurretNFTLending.Status.Repaid ? handler.BORROWER() : handler.LENDER());
            }
            credits += o.usdgCredit;
            assertEq(usd.balanceOf(o.vault), backing);
            balances += usd.balanceOf(o.vault);
        }
        assertEq(market.reservedPrincipal(), reserved); assertEq(market.activePrincipal(), active);
        assertEq(market.totalUSDGCredits(), credits); assertEq(usd.balanceOf(address(market)), 0);
        assertEq(balances, 2_000_000e6);
    }
}
