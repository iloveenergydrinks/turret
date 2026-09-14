// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {DockyardStockAtomicLiquidator} from "src/research/DockyardStockAtomicLiquidator.sol";
import {DockyardMockERC20} from "test/DockyardUSDGCreditVault.t.sol";
import {IsolatedMockV3Factory} from "./DockyardV3TwapFeed.t.sol";
import {IsolatedExitMockPool} from "./DockyardAtomicLiquidator.t.sol";

contract DockyardStockAtomicLiquidatorTest is DockyardStockCreditFixture {
    DockyardStockAtomicLiquidator executor;
    address keeper = makeAddr("stock sale keeper");

    function setUp() public override {
        super.setUp();
        _open();
        DockyardMockERC20 middle = new DockyardMockERC20("WETH", "WETH", 18);
        IsolatedMockV3Factory factory = new IsolatedMockV3Factory();
        IsolatedExitMockPool first = new IsolatedExitMockPool(address(stock), address(middle), address(factory), 1e18);
        IsolatedExitMockPool second = new IsolatedExitMockPool(address(middle), address(cash), address(factory), 60e6);
        factory.register(address(stock), address(middle), address(first));
        factory.register(address(middle), address(cash), address(second));
        middle.mint(address(first), 100e18);
        cash.mint(address(second), 1000e6);
        executor = new DockyardStockAtomicLiquidator(
            address(engine), address(middle), address(first), address(second), address(factory)
        );
        cash.mint(keeper, 100e6);
        vm.prank(keeper);
        cash.approve(address(executor), 100e6);
        stockFeed.setAnswer(30e8);
        vm.warp(block.timestamp + 46);
    }

    function testCheckedSaleRefreshesExpiredLivenessAndReturnsProfit() public {
        bytes memory proof = _live();
        vm.prank(keeper);
        (uint256 paid, uint256 seized, uint256 returned) =
            executor.liquidateAndSellChecked(borrower, 30e6, 1, 1e6, block.timestamp + 60, proof);
        assertGt(paid, 20e6);
        assertGt(seized, 0);
        assertGe(returned, paid + 1e6);
        assertEq(cash.balanceOf(keeper), 100e6 + returned - paid);
        assertEq(cash.balanceOf(address(executor)), 0);
        assertEq(stock.balanceOf(address(executor)), 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(executor.executionGate(), address(gate));
    }

    function testInheritedSaleCannotBypassExpiredGate() public {
        uint256 debt = engine.positionDebt(borrower);
        vm.prank(keeper);
        vm.expectRevert();
        executor.liquidateAndSell(borrower, 30e6, 1, 1e6, block.timestamp + 60);
        assertEq(engine.positionDebt(borrower), debt);
        assertEq(cash.balanceOf(keeper), 100e6);
    }

    function testBadProofCannotMoveKeeperFunds() public {
        uint256 debt = engine.positionDebt(borrower);
        vm.prank(keeper);
        vm.expectRevert();
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 1e6, block.timestamp + 60, hex"1234");
        assertEq(cash.balanceOf(keeper), 100e6);
        assertEq(engine.positionDebt(borrower), debt);
    }

    function testProfitBoundFailureRollsBackLoanAndProofPublication() public {
        uint256 debt = engine.positionDebt(borrower);
        (uint64 observed,,,) = gate.liveness();
        bytes memory proof = _live();
        vm.prank(keeper);
        vm.expectRevert();
        executor.liquidateAndSellChecked(borrower, 30e6, 1, 100e6, block.timestamp + 60, proof);
        (uint64 afterObserved,,,) = gate.liveness();
        assertEq(observed, afterObserved);
        assertEq(cash.balanceOf(keeper), 100e6);
        assertEq(engine.positionDebt(borrower), debt);
    }

    function testKeeperQuoteRefreshNeedsNoBorrowingSessionAndMovesNothing() public {
        bytes memory proof = _live();
        uint256 debt = engine.positionDebt(borrower);
        assertEq(engine.priceWithLiveness(proof), 30e18);
        (uint256 paid, uint256 seized) = engine.liquidationQuoteWithLiveness(borrower, 30e6, proof);
        assertGt(paid, 0);
        assertGt(seized, 0);
        assertEq(engine.positionDebt(borrower), debt);
        assertEq(cash.balanceOf(keeper), 100e6);
        assertLe(address(executor).code.length, 24576);
    }
}
