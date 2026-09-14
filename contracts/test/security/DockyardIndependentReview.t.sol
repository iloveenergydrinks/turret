// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "../research/DockyardStockCreditEngine.t.sol";
import {DockyardStockDirectLiquidator} from "src/research/DockyardStockDirectLiquidator.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {IsolatedMockV3Factory} from "../research/DockyardV3TwapFeed.t.sol";
import {IsolatedExitMockPool} from "../research/DockyardAtomicLiquidator.t.sol";

/// @notice Local review evidence: unresolved limits and fixed regressions.
/// All assets, prices and signatures are mocks; these are not live-exit evidence.
contract DockyardIndependentReviewTest is DockyardStockCreditFixture {
    function testExpiredGuardianProofBlocksLiquidationAndIdleCashExit() public {
        _open();
        vm.warp(block.timestamp + 46);
        stockFeed.setAnswer(30e8);
        assertEq(pool.availableCash(), 980e6);
        assertEq(pool.maxWithdraw(lender), 0);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);
        engine.liquidationQuote(borrower, type(uint256).max);

        // A fresh signature alone restores a quote, without changing either price.
        gate.submitLiveness(_live());
        (uint256 paid,) = engine.liquidationQuote(borrower, type(uint256).max);
        assertGt(paid, 0);
    }

    function testClosedSessionLocksCashEvenForHealthyOutstandingLoan() public {
        _open();
        engine.submitChecks(_health(block.timestamp + 10), _live());
        vm.warp(block.timestamp + 11);
        gate.submitLiveness(_live());
        assertEq(engine.price(), 100e18);
        assertEq(pool.availableCash(), 980e6);
        assertEq(pool.maxWithdraw(lender), 0);
        assertEq(pool.maxRedeem(lender), 0);

        // Repayment remains an independent recovery path.
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        assertGt(pool.maxWithdraw(lender), 999e6);
    }

    function testOneMicroUsdgRemainderIsPreventedAndPositiveProfitExitCanFinish() public {
        _open();
        stockFeed.setAnswer(21e8);
        engine.submitChecks(_health(block.timestamp + 3600), _live());
        cash.mint(address(this), 21e6);
        cash.approve(address(engine), 21e6);
        engine.liquidate(borrower, 20e6 - 1, 0);
        assertEq(engine.positionDebt(borrower), 1e6);
        assertEq(engine.borrowingPrice(), 21e18);
        assertEq(pool.availableCash(), 999e6);
        assertEq(pool.maxWithdraw(lender), 0);

        IsolatedMockV3Factory factory = new IsolatedMockV3Factory();
        // Ideal oracle-price sale with no modeled fees or price impact. Real
        // execution can be worse; this is not evidence about actual pool depth.
        IsolatedExitMockPool venue = new IsolatedExitMockPool(address(stock), address(cash), address(factory), 21e6);
        factory.register(address(stock), address(cash), address(venue));
        cash.mint(address(venue), 2e6);
        DockyardStockDirectLiquidator executor =
            new DockyardStockDirectLiquidator(address(engine), address(venue), address(factory));
        cash.approve(address(executor), 1e6);
        executor.liquidateAndSell(borrower, 1e6, 1, 1, block.timestamp + 60);
        assertEq(engine.positionDebt(borrower), 0);
        assertGt(pool.maxWithdraw(lender), 999e6);
    }
}
