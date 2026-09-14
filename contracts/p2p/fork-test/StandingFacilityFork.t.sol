// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderFacility as Facility} from "../src/TurretLenderFacility.sol";
import {TurretLenderFacilityFactory as Factory} from "../src/TurretLenderFacilityFactory.sol";

/// @dev Local fork only: existing balances, real token implementations, no mint/deal/storage edits.
contract StandingFacilityForkTest is Test {
    IERC20 cash = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint256 constant OWNER_KEY = 0xA11CE; // Local test signing only; never broadcast.
    address owner;
    address borrower;
    address[] tokens;
    address[] holders;
    uint256[] amounts;
    Factory factory;
    function setUp() public {
        vm.createSelectFork(vm.envString("P2P_FORK_RPC"), vm.envUint("P2P_FORK_BLOCK"));
        assertEq(block.chainid, 4663);
        owner = vm.addr(OWNER_KEY); borrower = makeAddr("standing borrower");
        tokens = vm.envAddress("P2P_FORK_TOKENS", ",");
        holders = vm.envAddress("P2P_FORK_HOLDERS", ",");
        amounts = vm.envUint("P2P_FORK_AMOUNTS", ",");
        assertEq(tokens.length, 27); assertEq(holders.length, tokens.length); assertEq(amounts.length, tokens.length);
        factory = new Factory(cash, tokens);
    }
    function _transfer(IERC20 asset, address from, address to, uint256 amount) private {
        uint256 sender = asset.balanceOf(from); uint256 recipient = asset.balanceOf(to);
        assertGe(sender, amount, "Existing holder funding required");
        vm.prank(from); assertTrue(asset.transfer(to, amount));
        assertEq(asset.balanceOf(from), sender - amount); assertEq(asset.balanceOf(to), recipient + amount);
    }
    function _loan(Facility facility, uint256 id) private view returns (Facility.Loan memory) {
        (bool ok, bytes memory data) = address(facility).staticcall(abi.encodeCall(facility.loans, (id)));
        require(ok); return abi.decode(data, (Facility.Loan));
    }
    function _draws(Facility facility, IERC20 collateral, uint256 perLoan) private returns (uint256 first, uint256 second) {
        Facility.Quote memory quote = Facility.Quote(1, 1, borrower, 200e6, 1e6, perLoan * 2, 20e6, 7 days, block.timestamp, block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, facility.quoteHash(quote));
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.startPrank(borrower); collateral.approve(address(facility), perLoan * 2);
        first = facility.draw(quote, signature, 100e6, perLoan, 10e6, 200e6);
        second = facility.draw(quote, signature, 100e6, perLoan, 10e6, 100e6); vm.stopPrank();
    }
    function _exercise(uint256 index) private {
        IERC20 collateral = IERC20(tokens[index]); uint256 perLoan = amounts[index] / 2;
        assertGt(perLoan, 0);
        address cashHolder = vm.envAddress("P2P_FORK_CASH_HOLDER");
        _transfer(cash, cashHolder, owner, 500e6);
        _transfer(cash, cashHolder, borrower, 20e6);
        _transfer(collateral, holders[index], borrower, perLoan * 2);
        Facility.Limits memory policy = Facility.Limits(500e6, 1e6, 100e6, 7 days, 7 days, 1 hours, perLoan * 1e18 / 100e6, 1000);
        vm.prank(owner); address deployed = factory.createFacility(address(collateral), policy);
        Facility facility = Facility(deployed);
        assertEq(factory.getFacility(owner, address(collateral)), deployed);
        assertEq(factory.createdAtBlock(deployed), block.number); assertEq(factory.facilityCount(), 1);
        vm.startPrank(owner); cash.approve(deployed, 500e6); facility.deposit(500e6); vm.stopPrank();
        (uint256 first, uint256 second) = _draws(facility, collateral, perLoan);
        assertEq(cash.balanceOf(borrower), 220e6); assertEq(facility.idleCash(), 300e6);
        assertEq(collateral.balanceOf(_loan(facility, first).vault), perLoan);
        assertEq(collateral.balanceOf(_loan(facility, second).vault), perLoan);
        vm.warp(facility.repaymentDeadline(first));
        vm.prank(owner); facility.setNewLoansPaused(true);
        vm.startPrank(borrower); cash.approve(deployed, 110e6); facility.repay(first); vm.stopPrank();
        assertEq(facility.idleCash(), 300e6); assertEq(facility.availableRepayment(first), 110e6);
        assertEq(facility.recycleRepayment(first), 110e6); assertEq(facility.idleCash(), 410e6);
        vm.prank(borrower); facility.withdrawCollateral(first, perLoan, borrower);
        vm.warp(block.timestamp + 1); facility.claimDefault(second);
        assertEq(facility.unresolvedDefaultPrincipal(), 100e6);
        vm.prank(owner); facility.withdrawCollateral(second, perLoan, owner);
        vm.prank(owner); facility.acknowledgeDefault(second);
        vm.prank(owner); facility.withdrawIdle(410e6, owner);
        assertEq(facility.activePrincipal(), 0); assertEq(facility.idleCash(), 0);
        assertEq(facility.unresolvedDefaultPrincipal(), 0); assertEq(facility.acknowledgedDefaultPrincipal(), 100e6);
        assertEq(cash.balanceOf(owner), 410e6); assertEq(cash.balanceOf(borrower), 110e6);
        assertEq(collateral.balanceOf(owner), perLoan); assertEq(collateral.balanceOf(borrower), perLoan);
        assertEq(cash.balanceOf(deployed), 0);
        for (uint256 id = 1; id <= 2; ++id) {
            assertEq(cash.balanceOf(_loan(facility, id).vault), 0);
            assertEq(collateral.balanceOf(_loan(facility, id).vault), 0);
        }
    }
    function testAAPLStandingLifecycle() public { _exercise(0); }
    function testMSFTStandingLifecycle() public { _exercise(1); }
    function testGOOGLStandingLifecycle() public { _exercise(2); }
    function testAMZNStandingLifecycle() public { _exercise(3); }
    function testMETAStandingLifecycle() public { _exercise(4); }
    function testNVDAStandingLifecycle() public { _exercise(5); }
    function testAMDStandingLifecycle() public { _exercise(6); }
    function testMUStandingLifecycle() public { _exercise(7); }
    function testTSLAStandingLifecycle() public { _exercise(8); }
    function testSLVStandingLifecycle() public { _exercise(9); }
    function testCASHCATStandingLifecycle() public { _exercise(10); }
    function testPONSStandingLifecycle() public { _exercise(11); }
    function testSPYStandingLifecycle() public { _exercise(12); }
    function testQQQStandingLifecycle() public { _exercise(13); }
    function testGLDStandingLifecycle() public { _exercise(14); }
    function testCOINStandingLifecycle() public { _exercise(15); }
    function testPLTRStandingLifecycle() public { _exercise(16); }
    function testNFLXStandingLifecycle() public { _exercise(17); }
    function testINDEXStandingLifecycle() public { _exercise(18); }
    function testPIPEDOGStandingLifecycle() public { _exercise(19); }
    function testTENDIESStandingLifecycle() public { _exercise(20); }
    function testHMMStandingLifecycle() public { _exercise(21); }
    function testIFStandingLifecycle() public { _exercise(22); }
    function testJUGGERNAUTStandingLifecycle() public { _exercise(23); }
    function testYOLOStandingLifecycle() public { _exercise(24); }
    function testAMCStandingLifecycle() public { _exercise(25); }
    function testMANYStandingLifecycle() public { _exercise(26); }
}
