// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {DockyardStockDirectLiquidator as Direct} from "src/research/DockyardStockDirectLiquidator.sol";
import {IsolatedMockV3Factory} from "./DockyardV3TwapFeed.t.sol";
import {IsolatedExitMockPool} from "./DockyardAtomicLiquidator.t.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

contract DirectReentrantPool {
    address public immutable token0;
    address public immutable token1;
    address public immutable factory;
    uint24 public constant fee = 10000;
    address public immutable input;
    address public immutable output;
    bool public attempted;

    constructor(address a, address b, address f) {
        input = a;
        output = b;
        factory = f;
        token0 = a < b ? a : b;
        token1 = a < b ? b : a;
    }

    function swap(address recipient, bool zero, int256 amount, uint160, bytes calldata)
        external
        returns (int256, int256)
    {
        attempted = true;
        (bool success,) =
            msg.sender.call(abi.encodeCall(Direct.liquidateAndSell, (address(1), 1, 1, 1, block.timestamp)));
        require(!success, "Reentrant entry succeeded");
        (success,) = msg.sender
            .call(abi.encodeCall(Direct.liquidateAndSellChecked, (address(1), 1, 1, 1, block.timestamp, bytes(""))));
        require(!success, "Reentrant checked entry succeeded");
        uint256 received = uint256(amount) * 30e6 / 1e18;
        IERC20(output).transfer(recipient, received);
        Direct(msg.sender)
            .uniswapV3SwapCallback(zero ? amount : -int256(received), zero ? -int256(received) : amount, "");
        return (zero ? amount : -int256(received), zero ? -int256(received) : amount);
    }
}

contract DockyardStockDirectLiquidatorTest is DockyardStockCreditFixture {
    Direct executor;
    IsolatedMockV3Factory factory;
    IsolatedExitMockPool venue;
    address keeper = makeAddr("direct stock keeper");
    bytes freshLiveness;

    function setUp() public override {
        super.setUp();
        _open();
        factory = new IsolatedMockV3Factory();
        venue = new IsolatedExitMockPool(address(stock), address(cash), address(factory), 30e6);
        factory.register(address(stock), address(cash), address(venue));
        cash.mint(address(venue), 1000e6);
        executor = new Direct(address(engine), address(venue), address(factory));
        cash.mint(keeper, 100e6);
        vm.prank(keeper);
        cash.approve(address(executor), 100e6);
        stockFeed.setAnswer(30e8);
        vm.warp(block.timestamp + 46);
        freshLiveness = _live();
    }

    function _execute(uint256 profit) private returns (uint256, uint256, uint256) {
        bytes memory proof = freshLiveness;
        vm.prank(keeper);
        return executor.liquidateAndSellChecked(borrower, 30e6, 1, profit, block.timestamp + 60, proof);
    }

    function _unchanged(uint256 debt, uint64 observed) private view {
        assertEq(engine.positionDebt(borrower), debt);
        assertEq(cash.balanceOf(keeper), 100e6);
        assertEq(cash.balanceOf(address(executor)), 0);
        assertEq(stock.balanceOf(address(executor)), 0);
        assertEq(cash.allowance(address(executor), address(engine)), 0);
        (uint64 afterObserved,,,) = gate.liveness();
        assertEq(afterObserved, observed);
    }

    function testDirectSaleReturnsProceedsAndUnusedRepaymentToKeeper() public {
        (uint256 paid, uint256 seized, uint256 out) = _execute(100000);
        assertGt(paid, 20e6);
        assertGt(seized, 0);
        assertGe(out, paid + 100000);
        assertEq(cash.balanceOf(keeper), 100e6 + out - paid);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(cash.balanceOf(address(executor)), 0);
        assertEq(stock.balanceOf(address(executor)), 0);
        assertEq(cash.allowance(address(executor), address(engine)), 0);
        assertEq(executor.executionGate(), address(gate));
        assertEq(address(executor.salePool()), address(venue));
        assertTrue(executor.routeHealthy());
        assertLe(address(executor).code.length, 24576);
    }

    function testUnrefreshedEntrypointCannotBypassExpiredLiveness() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        vm.prank(keeper);
        vm.expectRevert();
        executor.liquidateAndSell(borrower, 30e6, 1, 1, block.timestamp + 60);
        _unchanged(debt, observed);
    }

    function testUnrefreshedEntryWorksOnlyWithCurrentCachedLiveness() public {
        gate.submitLiveness(_live());
        vm.prank(keeper);
        executor.liquidateAndSell(borrower, 30e6, 1, 100000, block.timestamp + 60);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testInvalidProofCannotSpendFunds() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        vm.prank(keeper);
        vm.expectRevert();
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 1, block.timestamp + 60, hex"1234");
        _unchanged(debt, observed);
    }

    function testProfitFloorRevertsLiquidationSwapAndProof() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        uint256 venueCash = cash.balanceOf(address(venue));
        vm.expectRevert(Direct.InsufficientReturn.selector);
        _execute(10e6);
        _unchanged(debt, observed);
        assertEq(cash.balanceOf(address(venue)), venueCash);
    }

    function testPartialFillAndZeroOutputRevertWholeOperation() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        venue.setMode(2);
        vm.expectRevert(Direct.IncompleteSwap.selector);
        _execute(1);
        _unchanged(debt, observed);
        venue.setMode(0);
        venue.setRate(0);
        vm.expectRevert(Direct.InsufficientReturn.selector);
        _execute(1);
        _unchanged(debt, observed);
    }

    function testForgedAndOverBudgetCallbacksFail() public {
        vm.expectRevert(Direct.UnexpectedCallback.selector);
        executor.uniswapV3SwapCallback(1, -1, "");
        vm.prank(address(venue));
        vm.expectRevert(Direct.UnexpectedCallback.selector);
        executor.uniswapV3SwapCallback(1, -1, "");
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        venue.setMode(3);
        vm.expectRevert(Direct.UnexpectedCallback.selector);
        _execute(1);
        _unchanged(debt, observed);
    }

    function testRouteUnavailableLeavesDebtAndBalancesUnchanged() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        venue.setMode(1);
        vm.expectRevert(bytes("route unavailable"));
        _execute(1);
        _unchanged(debt, observed);
    }

    function testDonationsCannotFundProfitFloorOrBeSwept() public {
        cash.mint(address(executor), 100e6);
        stock.mint(address(executor), 10e18);
        vm.expectRevert(Direct.InsufficientReturn.selector);
        _execute(50e6);
        (uint256 paid,, uint256 out) = _execute(100000);
        assertEq(cash.balanceOf(keeper), 100e6 + out - paid);
        assertEq(cash.balanceOf(address(executor)), 100e6);
        assertEq(stock.balanceOf(address(executor)), 10e18);
    }

    function testRegistryRebindingBlocksRouteEvenWithUnchangedRuntime() public {
        factory.register(address(stock), address(cash), address(1));
        assertFalse(executor.routeHealthy());
        vm.expectRevert(Direct.RouteChanged.selector);
        _execute(1);
    }

    function testRuntimeDriftAtEveryDependencyBlocksRoute() public {
        address[6] memory targets =
            [address(engine), address(venue), address(factory), address(cash), address(stock), address(gate)];
        for (uint256 i; i < targets.length; ++i) {
            uint256 snap = vm.snapshot();
            vm.etch(targets[i], hex"00");
            assertFalse(executor.routeHealthy());
            // Build before the etch-free copy is restored; the gate itself need
            // not be callable because runtime validation occurs before proofs.
            vm.prank(keeper);
            vm.expectRevert(Direct.RouteChanged.selector);
            executor.liquidateAndSellChecked(borrower, 30e6, 1, 1, block.timestamp + 60, "");
            assertTrue(vm.revertTo(snap));
        }
    }

    function testInvalidPairOrFactoryCannotBeUsedAtConstruction() public {
        IsolatedMockV3Factory other = new IsolatedMockV3Factory();
        vm.expectRevert(Direct.InvalidConfiguration.selector);
        new Direct(address(engine), address(venue), address(other));
        IsolatedExitMockPool wrong = new IsolatedExitMockPool(address(stock), address(guard), address(factory), 30e6);
        factory.register(address(stock), address(cash), address(wrong));
        vm.expectRevert(Direct.InvalidConfiguration.selector);
        new Direct(address(engine), address(wrong), address(factory));
    }

    function testDeadlineAndZeroBoundsCannotAuthorizeTransfer() public {
        bytes memory proof = _live();
        vm.startPrank(keeper);
        vm.expectRevert(Direct.Expired.selector);
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 1, block.timestamp - 1, proof);
        vm.expectRevert(Direct.Expired.selector);
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 1, block.timestamp + 301, proof);
        vm.expectRevert(Direct.InvalidAmount.selector);
        executor.liquidateAndSellChecked(borrower, 0, 1, 1, block.timestamp, proof);
        vm.expectRevert(Direct.InvalidAmount.selector);
        executor.liquidateAndSellChecked(borrower, 30e6, 0, 1, block.timestamp, proof);
        vm.expectRevert(Direct.InvalidAmount.selector);
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 0, block.timestamp, proof);
        vm.stopPrank();
        assertEq(cash.balanceOf(keeper), 100e6);
    }

    function testPausedBorrowingStillPermitsRequiredLiquidations() public {
        engine.setRiskPaused(true);
        _execute(100000);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testPoolCannotReenterEitherExecutionEntrypoint() public {
        DirectReentrantPool reentrant = new DirectReentrantPool(address(stock), address(cash), address(factory));
        factory.register(address(stock), address(cash), address(reentrant));
        cash.mint(address(reentrant), 1000e6);
        executor = new Direct(address(engine), address(reentrant), address(factory));
        vm.prank(keeper);
        cash.approve(address(executor), 100e6);
        _execute(100000);
        assertTrue(reentrant.attempted());
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testFuzzProfitRequirementControlsAtomicity(uint32 minimum) public {
        uint256 floor = bound(minimum, 1, 2e6);
        gate.submitLiveness(_live());
        (uint256 paid, uint256 seized) = engine.liquidationQuote(borrower, 30e6);
        uint256 expected = seized * 30e6 / 1e18;
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        if (expected - paid < floor) {
            vm.expectRevert(Direct.InsufficientReturn.selector);
            _execute(floor);
            _unchanged(debt, observed);
        } else {
            _execute(floor);
            assertEq(cash.balanceOf(keeper), 100e6 + expected - paid);
        }
    }
}
