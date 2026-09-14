// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardStockCapitalPool} from "src/research/DockyardStockCapitalPool.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";

contract DockyardStockProofIsolationTest is DockyardStockCreditFixture {
    function _second() private returns (DockyardStockCreditEngine other, DockyardStockCapitalPool otherPool) {
        other = new DockyardStockCreditEngine(_config(), address(gate), _usdgConfig());
        otherPool = new DockyardStockCapitalPool(cash, address(stock), address(other), address(this), 100e6, 1000, 1000);
        other.bindPool(otherPool);
        cash.mint(address(this), 100e6);
        cash.approve(address(otherPool), 100e6);
        otherPool.deposit(100e6, address(this));
        other.setRiskPaused(false);
    }

    function testPriceGuardPublicationAloneCannotAuthorizePoolOrInheritedBorrow() public {
        bytes memory scoped = _health(block.timestamp + 3600);
        (DockyardHeartbeatGuard.Health memory h, bytes memory priceSignature,) =
            abi.decode(scoped, (DockyardHeartbeatGuard.Health, bytes, bytes));
        bytes memory pilotProof = abi.encode(h, priceSignature);
        guard.submitHealth(pilotProof);
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        engine.borrowingPrice();
        vm.prank(borrower);
        engine.depositCollateral(borrower, 1e18);
        vm.prank(borrower);
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        engine.borrow(20e6);
        bytes memory l = _live();
        vm.expectRevert();
        engine.submitChecks(pilotProof, l);
        assertEq(engine.approvedMarketHealth(), bytes32(0));
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testEngineSignatureCannotBeReplayedAtAnotherEngineSharingGuardAndGate() public {
        (DockyardStockCreditEngine other, DockyardStockCapitalPool otherPool) = _second();
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        engine.submitChecks(h, l);
        assertEq(engine.borrowingPrice(), 100e18);
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        other.submitChecks(h, l);
        vm.prank(borrower);
        stock.approve(address(other), 1e18);
        uint256 before = stock.balanceOf(borrower);
        vm.prank(borrower);
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        other.depositAndBorrowChecked(1e18, 20e6, h, l);
        assertEq(stock.balanceOf(borrower), before);
        assertEq(otherPool.availableCash(), 100e6);
        assertEq(other.approvedMarketHealth(), bytes32(0));
        // Admission is not required to value liquidation risk.
        assertEq(other.price(), 100e18);
    }

    function testAnotherPoolsRefreshCannotExtendThisPoolsBorrowingAuthorization() public {
        (DockyardStockCreditEngine other,) = _second();
        _open();
        bytes32 original = engine.approvedMarketHealth();
        vm.warp(block.timestamp + 46);
        other.submitChecks(_healthFor(address(other), block.timestamp + 3600), _live());
        assertEq(other.borrowingPrice(), 100e18);
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        engine.borrowingPrice();
        assertEq(engine.approvedMarketHealth(), original);
        assertEq(pool.maxWithdraw(lender), 0);
        assertEq(pool.maxDeposit(lender), 0);
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        assertGt(pool.maxWithdraw(lender), 0);
    }

    function testMarketSignatureChainDomainCannotBeReused() public {
        bytes memory h = _health(block.timestamp + 3600);
        (DockyardHeartbeatGuard.Health memory health, bytes memory priceSig,) =
            abi.decode(h, (DockyardHeartbeatGuard.Health, bytes, bytes));
        vm.chainId(1);
        bytes memory wrong = _health(block.timestamp + 3600);
        (,, bytes memory wrongMarket) = abi.decode(wrong, (DockyardHeartbeatGuard.Health, bytes, bytes));
        vm.chainId(4663);
        bytes memory l = _live();
        vm.expectRevert(DockyardStockCreditEngine.MarketHealthUnauthorized.selector);
        engine.submitChecks(abi.encode(health, priceSig, wrongMarket), l);
    }

    function testFinancialFailureRollsBackMarketAuthorizationCache() public {
        _open();
        bytes32 before = engine.approvedMarketHealth();
        vm.warp(block.timestamp + 1);
        bytes memory h = _health(block.timestamp + 3600);
        bytes memory l = _live();
        vm.prank(borrower);
        vm.expectRevert();
        engine.borrowChecked(1000e6, h, l);
        assertEq(engine.approvedMarketHealth(), before);
        assertEq(engine.borrowingPrice(), 100e18);
    }
}
