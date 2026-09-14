// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {P2PToken, IERC20} from "./P2PTestSupport.sol";
import {TurretP2PLendingV3} from "../src/TurretP2PLendingV3.sol";
import {TurretP2PVaultV3} from "../src/TurretP2PVaultV3.sol";

contract V3TestToken is P2PToken {
    constructor(string memory name, uint8 precision) P2PToken(name, precision) {}
    function removeBalance(address account, uint256 value) external { _burn(account, value); }
}

abstract contract V3TestBase is Test {
    V3TestToken internal usd;
    V3TestToken internal collateral;
    TurretP2PLendingV3 internal market;
    address internal constant LENDER = address(0xA11CE);
    address internal constant BORROWER = address(0xB0B);
    address internal constant PAYER = address(0xCA11);
    address internal constant OTHER = address(0xBEEF);
    address internal constant GUARDIAN = address(0x600D);
    uint256 internal constant P = 100e6;
    uint256 internal constant C = 40e18;
    uint256 internal constant I = 5e6;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usd = new V3TestToken("USDG", 6);
        collateral = new V3TestToken("SLV", 18);
        market = new TurretP2PLendingV3(usd, collateral, GUARDIAN);
        address[4] memory actors = [LENDER, BORROWER, PAYER, OTHER];
        for (uint256 a; a < actors.length; ++a) {
            usd.mint(actors[a], 1_000_000e6);
            collateral.mint(actors[a], 1_000_000e18);
            vm.startPrank(actors[a]);
            usd.approve(address(market), type(uint256).max);
            collateral.approve(address(market), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _create(address maker, address taker, uint256 principal) internal returns (uint256) {
        vm.prank(maker);
        return market.createOffer(taker, principal, C, I, 10 days, block.timestamp + 1 days);
    }

    function _active() internal returns (uint256 id) {
        id = _create(LENDER, BORROWER, P);
        vm.prank(BORROWER);
        market.acceptOffer(id);
    }

    function _credit(address owner, uint256 face) internal returns (uint256 id) {
        id = _create(owner, address(0), face);
        vm.prank(owner);
        market.cancelOffer(id);
    }

    function _offer(uint256 id) internal view returns (TurretP2PLendingV3.Offer memory offer) {
        (bool ok, bytes memory data) = address(market).staticcall(abi.encodeCall(market.offers, (id)));
        require(ok);
        return abi.decode(data, (TurretP2PLendingV3.Offer));
    }

    function _assertCredit(uint256 id, IERC20 token, address owner, uint256 face, uint256 available) internal view {
        (address actualOwner, uint256 actualFace, uint256 actualAvailable) = market.loanCredit(id, token);
        assertEq(actualOwner, owner);
        assertEq(actualFace, face);
        assertEq(actualAvailable, available);
    }

    function _assertStatus(uint256 id, TurretP2PLendingV3.Status expected) internal view {
        assertEq(uint256(_offer(id).status), uint256(expected));
    }

    function _sources(uint256 id, uint256 value) internal pure returns (uint256[] memory ids, uint256[] memory amounts) {
        ids = new uint256[](1); amounts = new uint256[](1); ids[0] = id; amounts[0] = value;
    }

    /// @dev Cross-check every per-loan claim against aggregate nominal ownership, independently
    /// of token backing. External burns must change availability without changing nominal rights.
    function _assertAccounting() internal view {
        uint256 committed; uint256 reserved; uint256 locked;
        uint256 usdClaims; uint256 collateralClaims;
        address[4] memory actors = [LENDER, BORROWER, PAYER, OTHER];
        uint256[4] memory actorUsd; uint256[4] memory actorCollateral;
        for (uint256 id = 1; id < market.nextOfferId(); ++id) {
            TurretP2PLendingV3.Offer memory o = _offer(id);
            if (o.status == TurretP2PLendingV3.Status.Open || o.status == TurretP2PLendingV3.Status.Active) committed += o.principal;
            if (o.status == TurretP2PLendingV3.Status.Open) reserved += o.principal;
            if (o.status == TurretP2PLendingV3.Status.Active) locked += o.collateralAmount;
            (address uOwner, uint256 uFace, uint256 uAvailable) = market.loanCredit(id, usd);
            (address cOwner, uint256 cFace, uint256 cAvailable) = market.loanCredit(id, collateral);
            usdClaims += uFace; collateralClaims += cFace;
            uint256 uBalance = usd.balanceOf(market.vaults(id));
            uint256 cBalance = collateral.balanceOf(market.vaults(id));
            assertEq(uAvailable, uFace < uBalance ? uFace : uBalance);
            assertEq(cAvailable, cFace < cBalance ? cFace : cBalance);
            for (uint256 a; a < actors.length; ++a) {
                if (uOwner == actors[a]) actorUsd[a] += uFace;
                if (cOwner == actors[a]) actorCollateral[a] += cFace;
            }
        }
        assertEq(market.committedPrincipal(), committed);
        assertEq(market.reservedPrincipal(), reserved);
        assertEq(market.lockedCollateral(), locked);
        assertEq(market.totalCredits(address(usd)), usdClaims);
        assertEq(market.totalCredits(address(collateral)), collateralClaims);
        for (uint256 a; a < actors.length; ++a) {
            assertEq(market.credits(address(usd), actors[a]), actorUsd[a]);
            assertEq(market.credits(address(collateral), actors[a]), actorCollateral[a]);
        }
        assertEq(usd.balanceOf(address(market)), 0);
        assertEq(collateral.balanceOf(address(market)), 0);
    }
}
