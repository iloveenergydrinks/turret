// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "../research/DockyardStockCreditEngine.t.sol";
import {DockyardStockCreditEngine} from "src/research/DockyardStockCreditEngine.sol";
import {DockyardApi3ManagedUsdgFeed} from "src/research/DockyardApi3ManagedUsdgFeed.sol";

/// Real Robinhood USDG sources; stock/cash/borrowers are local fixtures. No
/// transaction broadcast, wallet key, Data Streams subscription or real funds.
contract DockyardChainlinkApi3PairForkTest is DockyardStockCreditFixture {
    DockyardApi3ManagedUsdgFeed api3Feed;
    uint256 forkTimestamp;

    function setUp() public override {
        assertEq(block.chainid, 4663);
        assertEq(block.number, 53176414);
        forkTimestamp = block.timestamp;
        api3Feed = new DockyardApi3ManagedUsdgFeed(
            0xEa5f320Ee0ef7E81AFAf2a9b4FBc1a7d093287fe,
            0x27204d8c31a1fcbdf7747d795776d8a60c6d10bf2bf7c94739cd9190a5e16238,
            25 hours
        );
        super.setUp();
    }

    function _beforeActivate() internal override {
        vm.warp(forkTimestamp);
        stockFeed.setAnswer(100e8);
    }

    function _usdgConfig() internal view override returns (DockyardStockCreditEngine.UsdgPricing memory) {
        return DockyardStockCreditEngine.UsdgPricing(
            0x61B7e5650328764B076A108EFF5fa7282a1B9aD2, address(api3Feed), 25 hours, 25 hours, 200, 25 hours
        );
    }

    function testRealOraclePairSupportsBorrowRepayAndLenderRedemption() public {
        (, int256 api3Price,,,) = api3Feed.latestRoundData();
        assertEq(engine.price(), uint256(100e18) * 1e18 / uint256(api3Price));
        _open();
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        assertEq(stock.balanceOf(borrower), 10e18);
        uint256 shares = pool.balanceOf(lender);
        vm.prank(lender);
        assertEq(pool.redeem(shares, lender, lender), 1000e6);
    }

    function testRealOraclePairSupportsLocalLiquidation() public {
        _open();
        stockFeed.setAnswer(40e8);
        cash.mint(address(this), 100e6);
        cash.approve(address(engine), 100e6);
        (uint256 paid, uint256 seized) = engine.liquidateChecked(borrower, 100e6, 1, _live());
        assertEq(paid, 20e6);
        assertGt(seized, 0);
        assertEq(engine.positionDebt(borrower), 0);
    }

    function testRealChainlinkExpiryBlocksPricesNotClosure() public {
        _open();
        (,,, uint256 updated,) = engine.usdgPrimary().latestRoundData();
        vm.warp(updated + 25 hours);
        stockFeed.setAnswer(100e8);
        gate.submitLiveness(_live());
        vm.expectRevert(DockyardStockCreditEngine.InvalidUsdgPrice.selector);
        engine.price();
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(stock.balanceOf(borrower), 10e18);
    }
}
