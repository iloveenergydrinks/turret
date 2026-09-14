// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {DockyardIsolatedMarketsForkFixture} from "./DockyardIsolatedMarketsFork.t.sol";

interface ILaunchControls {
    function restrictionEndBlock() external view returns (uint256);
    function maxWalletLimit() external view returns (uint256);
    function launchFactory() external view returns (address);
    function setInitialBuyRecipient(address recipient) external;
}

/// @notice Pinned deployed runtime behavior, not a complete token audit.
/// Synthetic balances and factory impersonation exist only on the local fork.
contract DockyardCollateralControlsForkTest is DockyardIsolatedMarketsForkFixture {
    function testCashcatAllowanceAndTransfers() public {
        _allowances(CASHCAT);
    }

    function testPonsAllowanceAndTransfers() public {
        _allowances(PONS);
    }

    function testCashcatExpiredWalletLimit() public {
        _expiredLimit(CASHCAT);
    }

    function testPonsExpiredWalletLimit() public {
        _expiredLimit(PONS);
    }

    function testCashcatFactoryOutageDoesNotBlockExit() public {
        _factoryOutage(CASHCAT, CASHCAT_POOL);
    }

    function testPonsFactoryControlCannotReactivateLaunchLimits() public {
        ILaunchControls controls = ILaunchControls(PONS);
        address factory = controls.launchFactory();
        uint256 end = controls.restrictionEndBlock();
        vm.expectRevert(bytes4(keccak256("NotLaunchFactory()")));
        controls.setInitialBuyRecipient(address(this));
        vm.prank(factory);
        controls.setInitialBuyRecipient(address(0));
        assertEq(controls.restrictionEndBlock(), end);
        _factoryOutage(PONS, PONS_POOL);
        _expiredLimit(PONS);
    }

    function _allowances(address token) internal {
        IERC20 asset = IERC20(token);
        address spender = makeAddr("controls-spender");
        address recipient = makeAddr("controls-recipient");
        uint256 supply = asset.totalSupply();
        deal(token, address(this), 100 ether);
        assertTrue(asset.approve(spender, 3 ether));
        vm.prank(spender);
        assertTrue(asset.transferFrom(address(this), recipient, 2 ether));
        assertEq(asset.balanceOf(recipient), 2 ether);
        assertEq(asset.balanceOf(address(this)), 98 ether);
        assertEq(asset.allowance(address(this), spender), 1 ether);
        vm.expectRevert();
        vm.prank(spender);
        asset.transferFrom(address(this), recipient, 2 ether);
        assertEq(asset.balanceOf(recipient), 2 ether);
        assertTrue(asset.approve(spender, 0));
        vm.expectRevert();
        vm.prank(spender);
        asset.transferFrom(address(this), recipient, 1);
        assertTrue(asset.approve(spender, type(uint256).max));
        vm.prank(spender);
        assertTrue(asset.transferFrom(address(this), recipient, 1 ether));
        assertEq(asset.allowance(address(this), spender), type(uint256).max);
        vm.expectRevert();
        asset.transfer(address(0), 1);
        assertEq(asset.totalSupply(), supply);
    }

    function _expiredLimit(address token) internal {
        ILaunchControls controls = ILaunchControls(token);
        assertGt(block.number, controls.restrictionEndBlock());
        uint256 amount = controls.maxWalletLimit() + 1 ether;
        assertGt(amount, 1 ether);
        IERC20 asset = IERC20(token);
        uint256 supply = asset.totalSupply();
        deal(token, address(this), amount);
        address recipient = makeAddr("above-historical-wallet-limit");
        assertTrue(asset.transfer(recipient, amount));
        assertEq(asset.balanceOf(recipient), amount);
        vm.prank(recipient);
        assertTrue(asset.transfer(address(this), amount));
        assertEq(asset.balanceOf(address(this)), amount);
        assertEq(asset.totalSupply(), supply);
    }

    function _factoryOutage(address token, address venue) internal {
        ILaunchControls controls = ILaunchControls(token);
        assertGt(block.number, controls.restrictionEndBlock());
        address launchFactory = controls.launchFactory();
        uint256 bought = _swap(WETH, venue, 0.1 ether);
        // A reverting launch factory must not strand existing token inventory.
        vm.mockCallRevert(launchFactory, bytes(""), bytes("factory unavailable"));
        uint256 supplied = IERC20(token).totalSupply();
        assertTrue(IERC20(token).transfer(borrower, bought));
        vm.prank(borrower);
        assertTrue(IERC20(token).transfer(address(this), bought));
        uint256 received = _swap(token, venue, bought);
        assertGt(received, 0);
        assertEq(IERC20(token).balanceOf(address(this)), 0);
        assertEq(IERC20(token).totalSupply(), supplied);
        vm.clearMockedCalls();
    }
}
