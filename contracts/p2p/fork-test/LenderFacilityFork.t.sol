// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderFacility as Facility} from "../src/TurretLenderFacility.sol";

/// @dev Real token code and existing balances on a local fork only. No mint/deal/storage edits.
contract LenderFacilityForkTest is Test {
    IERC20 cash = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint256 constant OWNER_KEY = 0xA11CE; // Deterministic local test account, never broadcast.
    address owner;
    address borrower;
    address fees;

    function setUp() public {
        vm.createSelectFork(vm.envString("P2P_FORK_RPC"), vm.envUint("P2P_FORK_BLOCK"));
        assertEq(block.chainid, 4663);
        owner = vm.addr(OWNER_KEY); borrower = makeAddr("facility borrower"); fees = makeAddr("facility fee recipient");
    }

    function testCASHCATFacilityActualTokenLifecycle() public {
        _lifecycle(IERC20(0x020bfC650A365f8BB26819deAAbF3E21291018b4), 0xA70fc67C9F69da90B63a0e4C05D229954574E313);
    }
    function testPONSFacilityActualTokenLifecycle() public {
        _lifecycle(IERC20(0x39dBED3a2bd333467115dE45665cC57F813C4571), 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA);
    }

    function _transfer(IERC20 asset, address from, address to, uint256 amount) private {
        uint256 beforeSender = asset.balanceOf(from); uint256 beforeRecipient = asset.balanceOf(to);
        assertGe(beforeSender, amount, "Existing holder funding required");
        vm.prank(from); assertTrue(asset.transfer(to, amount));
        assertEq(asset.balanceOf(from), beforeSender - amount); assertEq(asset.balanceOf(to), beforeRecipient + amount);
    }
    function _loan(Facility facility, uint256 id) private view returns (Facility.Loan memory) {
        (bool ok, bytes memory data) = address(facility).staticcall(abi.encodeCall(facility.loans, (id)));
        require(ok); return abi.decode(data, (Facility.Loan));
    }

    function _lifecycle(IERC20 collateral, address holder) private {
        address cashHolder = 0x37ED4621D1Eb3aBC9e551a888E6AaF0A41F7be8e;
        _transfer(cash, cashHolder, owner, 1000e6);
        _transfer(cash, cashHolder, borrower, 100e6);
        _transfer(collateral, holder, borrower, 600e18);
        Facility.Limits memory policy = Facility.Limits(500e6, 1e6, 300e6, 1 days, 30 days, 1 hours, 1e30, 100);
        Facility facility = new Facility(cash, collateral, owner, fees, 1000, policy);
        vm.startPrank(owner); cash.approve(address(facility), 500e6); facility.deposit(500e6); vm.stopPrank();
        Facility.Quote memory quote = Facility.Quote(1, 1, borrower, 300e6, 1e6, 600e18, 30e6, 7 days, block.timestamp, block.timestamp + 10 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, facility.quoteHash(quote));
        bytes memory signature = abi.encodePacked(r, s, v);
        vm.startPrank(borrower);
        collateral.approve(address(facility), 600e18);
        uint256 first = facility.draw(quote, signature, 100e6, 200e18, 10e6, 300e6);
        uint256 second = facility.draw(quote, signature, 100e6, 200e18, 10e6, 200e6);
        vm.stopPrank();
        assertEq(cash.balanceOf(borrower), 300e6);
        assertEq(facility.idleCash(), 300e6);
        assertEq(collateral.balanceOf(_loan(facility, first).vault), 200e18);
        assertEq(collateral.balanceOf(_loan(facility, second).vault), 200e18);
        vm.warp(facility.repaymentDeadline(first));
        vm.prank(owner); facility.setNewLoansPaused(true);
        vm.startPrank(borrower); cash.approve(address(facility), 110e6); facility.repay(first); vm.stopPrank();
        assertEq(facility.idleCash(), 300e6);
        assertEq(facility.availableRepayment(first), 109e6);
        assertEq(facility.recycleRepayment(first), 109e6);
        assertEq(facility.idleCash(), 409e6);
        assertEq(facility.collectFee(first), 1e6);
        vm.prank(borrower); facility.withdrawCollateral(first, 200e18, borrower);
        assertEq(collateral.balanceOf(borrower), 400e18);
        vm.warp(block.timestamp + 1); facility.claimDefault(second);
        assertEq(facility.unresolvedDefaultPrincipal(), 100e6);
        vm.prank(owner); facility.withdrawCollateral(second, 200e18, owner);
        vm.prank(owner); facility.acknowledgeDefault(second);
        vm.prank(owner); facility.withdrawIdle(409e6, owner);
        assertEq(facility.activePrincipal(), 0); assertEq(facility.idleCash(), 0);
        assertEq(facility.unresolvedDefaultPrincipal(), 0); assertEq(facility.acknowledgedDefaultPrincipal(), 100e6);
        assertEq(cash.balanceOf(owner), 909e6); assertEq(cash.balanceOf(fees), 1e6);
        assertEq(cash.balanceOf(borrower), 190e6); assertEq(collateral.balanceOf(owner), 200e18);
        assertEq(cash.balanceOf(address(facility)), 0);
        for (uint256 id = 1; id <= 2; ++id) {
            assertEq(cash.balanceOf(_loan(facility, id).vault), 0);
            assertEq(collateral.balanceOf(_loan(facility, id).vault), 0);
        }
    }
}
