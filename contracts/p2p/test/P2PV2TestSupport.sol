// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {P2PToken, P2PNoReturnToken, IERC20} from "./P2PTestSupport.sol";
import {TurretP2PLendingV2} from "../src/TurretP2PLendingV2.sol";

abstract contract P2PV2TestBase is Test {
    P2PToken internal usd;
    P2PToken internal slv;
    TurretP2PLendingV2 internal market;
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
        market = new TurretP2PLendingV2(usd, slv, guardian);
        _fundAndApprove(lender);
        _fundAndApprove(borrower);
        _fundAndApprove(thirdParty);
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
        return market.createOffer(address(0), PRINCIPAL, COLLATERAL, INTEREST, 30 days, block.timestamp + 1 hours);
    }

    function _active() internal returns (uint256 id) {
        id = _create();
        vm.prank(borrower);
        market.acceptOffer(id);
    }

    function _offer(uint256 id) internal view returns (TurretP2PLendingV2.Offer memory offer) {
        (bool ok, bytes memory encoded) = address(market).staticcall(abi.encodeWithSelector(market.offers.selector, id));
        require(ok, "read offer failed");
        offer = abi.decode(encoded, (TurretP2PLendingV2.Offer));
    }

    function _assertSolvent() internal view {
        assertGe(usd.balanceOf(address(market)), market.reservedPrincipal() + market.totalCredits(address(usd)));
        assertGe(slv.balanceOf(address(market)), market.lockedCollateral() + market.totalCredits(address(slv)));
    }

    function _assertStatus(uint256 id, TurretP2PLendingV2.Status expected) internal view {
        assertEq(uint256(_offer(id).status), uint256(expected));
    }
}
