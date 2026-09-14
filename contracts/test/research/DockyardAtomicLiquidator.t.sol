// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardIsolatedCreditEngineFixture} from "./DockyardIsolatedCreditEngine.t.sol";
import {DockyardMockERC20} from "../DockyardUSDGCreditVault.t.sol";
import {IsolatedMockV3Factory} from "./DockyardV3TwapFeed.t.sol";
import {DockyardAtomicLiquidator} from "src/research/DockyardAtomicLiquidator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IExitCallback {
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
}

contract IsolatedExitMockPool {
    address public immutable token0;
    address public immutable token1;
    address public immutable factory;
    uint24 public constant fee = 10000;
    address public immutable input;
    address public immutable output;
    uint256 public rate;
    uint8 public mode;
    uint256 public impactThreshold;

    constructor(address a, address b, address f, uint256 rate_) {
        input = a;
        output = b;
        token0 = a < b ? a : b;
        token1 = a < b ? b : a;
        factory = f;
        rate = rate_;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    /// @dev Test-only discontinuous price impact. Not a V3 pricing model.
    function setImpactThreshold(uint256 amount) external {
        impactThreshold = amount;
    }

    function swap(address recipient, bool zero, int256 amount, uint160, bytes calldata)
        external
        returns (int256, int256)
    {
        require(mode != 1, "route unavailable");
        require(zero == (input == token0) && amount > 0, "wrong direction");
        uint256 consumed = mode == 2 ? uint256(amount) / 2 : uint256(amount);
        uint256 received = consumed * rate / 1e18;
        if (impactThreshold != 0 && consumed > impactThreshold) received /= 2;
        require(IERC20(output).transfer(recipient, received));
        int256 due = int256(mode == 3 ? consumed + 1 : consumed);
        IExitCallback(msg.sender)
            .uniswapV3SwapCallback(zero ? due : -int256(received), zero ? -int256(received) : due, "");
        return (zero ? due : -int256(received), zero ? -int256(received) : due);
    }
}

contract DockyardAtomicLiquidatorTest is DockyardIsolatedCreditEngineFixture {
    DockyardMockERC20 middle;
    IsolatedMockV3Factory factory;
    IsolatedExitMockPool first;
    IsolatedExitMockPool second;
    DockyardAtomicLiquidator executor;

    function setUp() public override {
        super.setUp();
        middle = new DockyardMockERC20("WETH", "WETH", 18);
        factory = new IsolatedMockV3Factory();
        first = new IsolatedExitMockPool(address(token), address(middle), address(factory), 1e16);
        second = new IsolatedExitMockPool(address(middle), address(cash), address(factory), 6000e6);
        factory.register(address(token), address(middle), address(first));
        factory.register(address(middle), address(cash), address(second));
        middle.mint(address(first), 1000e18);
        cash.mint(address(second), 10000000e6);
        executor = new DockyardAtomicLiquidator(
            address(engine), address(middle), address(first), address(second), address(factory)
        );
        cash.mint(address(this), 1000e6);
        cash.approve(address(executor), 1000e6);
        open(alice, 10e18, 400e6);
        updatePrice(60e8);
    }

    function execute(uint256 profit) private returns (uint256, uint256, uint256) {
        return executor.liquidateAndSell(alice, 500e6, 1, profit, block.timestamp + 60);
    }

    function assertUnchanged(uint256 beforeCash) private view {
        assertEq(engine.positionDebt(alice), 400e6);
        assertEq(cash.balanceOf(address(this)), beforeCash);
        assertEq(token.balanceOf(address(engine)), 10e18);
        assertEq(cash.allowance(address(executor), address(engine)), 0);
        assertEq(cash.balanceOf(address(executor)), 0);
    }

    function testAtomicLiquidationRecyclesUsdgAndRefundsUnusedMaximum() public {
        uint256 before = cash.balanceOf(address(this));
        (uint256 paid, uint256 seized, uint256 out) = execute(19e6);
        assertEq(paid, 400e6);
        assertEq(seized, 7e18);
        assertEq(out, 420e6);
        assertEq(cash.balanceOf(address(this)), before + 20e6);
        assertEq(engine.positionDebt(alice), 0);
        assertEq(cash.allowance(address(executor), address(engine)), 0);
        assertEq(cash.balanceOf(address(executor)), 0);
        assertEq(token.balanceOf(address(executor)), 0);
        assertEq(middle.balanceOf(address(executor)), 0);
    }

    function testSecondHopFailureRevertsDebtAndFirstSwap() public {
        uint256 before = cash.balanceOf(address(this));
        uint256 middleBefore = middle.balanceOf(address(first));
        second.setMode(1);
        vm.expectRevert(bytes("route unavailable"));
        execute(1);
        assertUnchanged(before);
        assertEq(middle.balanceOf(address(first)), middleBefore);
    }

    function testInsufficientProfitRevertsAllMoneyMovement() public {
        uint256 before = cash.balanceOf(address(this));
        vm.expectRevert(DockyardAtomicLiquidator.InsufficientReturn.selector);
        execute(21e6);
        assertUnchanged(before);
    }

    function testSizeDependentReturnFailureRollsBackThenSmallerExitWorks() public {
        first.setImpactThreshold(4e18);
        uint256 beforeCash = cash.balanceOf(address(this));
        vm.expectRevert(DockyardAtomicLiquidator.InsufficientReturn.selector);
        execute(1e6);
        assertUnchanged(beforeCash);
        (uint256 paid, uint256 seized, uint256 out) =
            executor.liquidateAndSell(alice, 200e6, 1, 1e6, block.timestamp + 60);
        assertEq(paid, 200e6);
        assertEq(seized, 3.5e18);
        assertEq(out, 210e6);
        assertEq(engine.positionDebt(alice), 200e6);
    }

    function testPartialFillAndZeroOutputCannotLeaveInventory() public {
        uint256 before = cash.balanceOf(address(this));
        first.setMode(2);
        vm.expectRevert(DockyardAtomicLiquidator.IncompleteSwap.selector);
        execute(1);
        assertUnchanged(before);
        first.setMode(0);
        second.setRate(0);
        vm.expectRevert(DockyardAtomicLiquidator.IncompleteSwap.selector);
        execute(1);
        assertUnchanged(before);
    }

    function testForgedCallbackAndOverpaymentRejected() public {
        vm.expectRevert(DockyardAtomicLiquidator.UnexpectedCallback.selector);
        executor.uniswapV3SwapCallback(1, 0, "");
        first.setMode(3);
        vm.expectRevert(DockyardAtomicLiquidator.UnexpectedCallback.selector);
        execute(1);
        assertEq(engine.positionDebt(alice), 400e6);
    }

    function testExpiredOrLongLivedIntentRejectedBeforeFunding() public {
        vm.expectRevert(DockyardAtomicLiquidator.Expired.selector);
        executor.liquidateAndSell(alice, 500e6, 1, 1, block.timestamp - 1);
        vm.expectRevert(DockyardAtomicLiquidator.Expired.selector);
        executor.liquidateAndSell(alice, 500e6, 1, 1, block.timestamp + 301);
    }

    function testZeroProfitAndCollateralMinimumRejected() public {
        vm.expectRevert(DockyardAtomicLiquidator.InvalidAmount.selector);
        execute(0);
        vm.expectRevert(DockyardAtomicLiquidator.InvalidAmount.selector);
        executor.liquidateAndSell(alice, 500e6, 0, 1, block.timestamp);
    }

    function testDonationsCannotBeSweptByAnotherCaller() public {
        cash.mint(address(executor), 123e6);
        token.mint(address(executor), 13e18);
        middle.mint(address(executor), 7e18);
        uint256 before = cash.balanceOf(address(this));
        execute(1);
        assertEq(cash.balanceOf(address(this)), before + 20e6);
        assertEq(cash.balanceOf(address(executor)), 123e6);
        assertEq(token.balanceOf(address(executor)), 13e18);
        assertEq(middle.balanceOf(address(executor)), 7e18);
    }

    function testPausedRiskStillAllowsAtomicExit() public {
        engine.setRiskPaused(true);
        execute(1);
        assertEq(engine.positionDebt(alice), 0);
    }

    function testRouteRuntimeChangeBlocksExecution() public {
        vm.etch(address(second), hex"00");
        assertFalse(executor.routeHealthy());
        vm.expectRevert(DockyardAtomicLiquidator.RouteChanged.selector);
        execute(1);
    }

    function testFuzzProfitFloorControlsAtomicExecution(uint32 floor) public {
        uint256 before = cash.balanceOf(address(this));
        uint256 minimum = bound(floor, 1, 40e6);
        if (minimum > 20e6) {
            vm.expectRevert(DockyardAtomicLiquidator.InsufficientReturn.selector);
            execute(minimum);
            assertUnchanged(before);
        } else {
            execute(minimum);
            assertEq(cash.balanceOf(address(this)), before + 20e6);
        }
    }
}
