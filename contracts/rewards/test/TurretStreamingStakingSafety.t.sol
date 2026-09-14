// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretStreamingStaking} from "../src/TurretStreamingStaking.sol";

contract StreamingAdversarialStakingToken is ERC20 {
    bool public blocked;
    bool public taxed;
    bool public senderTax;
    address public callback;
    bool public reentryBlocked;
    constructor() ERC20("fixture", "FIX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setSenderTax(bool enabled) external { senderTax = enabled; }
    function configure(bool blockTransfers, bool taxTransfers, address target) external { blocked = blockTransfers; taxed = taxTransfers; callback = target; }
    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blocked, "token transfer blocked");
        if (callback != address(0)) {
            (bool ok, bytes memory result) = callback.call(abi.encodeWithSignature("stake(uint256)", 1));
            reentryBlocked = !ok && keccak256(result) == keccak256(abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call"));
        }
        super._transfer(from, to, amount);
        if (taxed && amount > 0) _burn(to, 1);
        if (senderTax && amount > 0) _burn(from, 1);
    }
}
contract TurretStreamingStakingSafetyTest is Test {
    StreamingAdversarialStakingToken token;
    StreamingAdversarialStakingToken usdg;
    TurretStreamingStaking staking;
    address alice = address(0xA11CE);
    function setUp() public {
        token = new StreamingAdversarialStakingToken(); usdg = new StreamingAdversarialStakingToken();
        staking = new TurretStreamingStaking(token, usdg, address(this));
        token.mint(alice, 100e18); usdg.mint(address(this), 10e6);
        vm.prank(alice); token.approve(address(staking), type(uint256).max);
        usdg.approve(address(staking), type(uint256).max);
    }
    function testBlockedUSDGClaimDoesNotPreventTURRETWithdrawal() public {
        vm.prank(alice); staking.stake(100e18);
        staking.distribute(5e6);
        vm.warp(block.timestamp + 1 days);
        uint256 expected = staking.earned(alice);
        usdg.configure(true, false, address(0));
        vm.prank(alice); vm.expectRevert("token transfer blocked"); staking.claim();
        vm.roll(block.number + 1); vm.prank(alice); staking.unstake(100e18);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(staking.earned(alice), expected);
        usdg.configure(false, false, address(0));
        vm.prank(alice); staking.claim(); assertEq(usdg.balanceOf(alice), expected);
    }
    function testSenderSurchargeCannotDebitMoreTURRETThanReviewed() public {
        token.setSenderTax(true);
        vm.prank(alice); vm.expectRevert(TurretStreamingStaking.UnsupportedTransfer.selector); staking.stake(10e18);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(staking.stakedBalance(alice), 0);
    }

    function testTaxedStakingTransferCannotCreateUnbackedStake() public {
        token.configure(false, true, address(0));
        vm.prank(alice); vm.expectRevert(TurretStreamingStaking.UnsupportedTransfer.selector); staking.stake(100e18);
        assertEq(staking.totalStaked(), 0); assertEq(token.balanceOf(alice), 100e18);
    }
    function testSenderSurchargeCannotConsumeExtraRewardFunding() public {
        vm.prank(alice); staking.stake(100e18);
        usdg.setSenderTax(true);
        vm.expectRevert(TurretStreamingStaking.UnsupportedTransfer.selector); staking.distribute(5e6);
        assertEq(usdg.balanceOf(address(this)), 10e6);
        assertEq(staking.totalFunded(), 0);
        assertEq(staking.earned(alice), 0);
    }

    function testTaxedUSDGFundingCannotCreateUnbackedRewards() public {
        vm.prank(alice); staking.stake(100e18);
        usdg.configure(false, true, address(0));
        vm.expectRevert(TurretStreamingStaking.UnsupportedTransfer.selector); staking.distribute(5e6);
        assertEq(staking.totalFunded(), 0); assertEq(staking.earned(alice), 0);
    }
    function testTaxedOutgoingRewardsPreserveClaimOnRevert() public {
        vm.prank(alice); staking.stake(100e18); staking.distribute(5e6);
        vm.warp(block.timestamp + 1 days); uint256 expected = staking.earned(alice);
        usdg.configure(false, true, address(0));
        vm.prank(alice); vm.expectRevert(TurretStreamingStaking.UnsupportedTransfer.selector); staking.claim();
        assertEq(staking.earned(alice), expected); assertEq(staking.totalClaimed(), 0);
    }
    function testTokenCallbackCannotReenterStake() public {
        token.configure(false, false, address(staking));
        vm.prank(alice); staking.stake(100e18);
        assertTrue(token.reentryBlocked()); assertEq(staking.totalStaked(), 100e18);
    }
}
