// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardIsolatedCreditEngineFixture} from "./DockyardIsolatedCreditEngine.t.sol";
import {DockyardMockERC20, DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";

contract IsolatedLoanHandler is Test {
    DockyardIsolatedCreditEngine public engine;
    DockyardIsolatedCapitalPool public pool;
    DockyardMockERC20 public cash;
    DockyardMockERC20 public collateral;
    DockyardMockOracle public primary;
    DockyardMockOracle public secondary;
    address[3] public actors;
    uint256 public successfulActions;

    constructor(
        DockyardIsolatedCreditEngine e,
        DockyardIsolatedCapitalPool p,
        DockyardMockERC20 c,
        DockyardMockERC20 t,
        DockyardMockOracle a,
        DockyardMockOracle b
    ) {
        engine = e;
        pool = p;
        cash = c;
        collateral = t;
        primary = a;
        secondary = b;
        for (uint256 i; i < 3; i++) {
            address actor = address(uint160(0xCA000 + i));
            actors[i] = actor;
            cash.mint(actor, 10000000e6);
            collateral.mint(actor, 1000000e18);
            vm.startPrank(actor);
            cash.approve(address(engine), type(uint256).max);
            collateral.approve(address(engine), type(uint256).max);
            vm.stopPrank();
        }
    }

    function open(uint256 who, uint256 debt) external {
        address actor = actors[who % 3];
        vm.prank(actor);
        try engine.depositAndBorrow(10e18, bound(debt, 1, 100e6)) {
            successfulActions++;
        } catch {}
    }

    function repay(uint256 who, uint256 amount) external {
        address actor = actors[who % 3];
        vm.prank(actor);
        try engine.repay(actor, bound(amount, 1, 1000e6)) returns (uint256) {
            successfulActions++;
        } catch {}
    }

    function close(uint256 who) external {
        address actor = actors[who % 3];
        vm.prank(actor);
        try engine.close(type(uint256).max, actor) returns (uint256) {
            successfulActions++;
        } catch {}
    }

    function liquidate(uint256 who, uint256 amount) external {
        address target = actors[who % 3];
        address actor = actors[(who % 3 + 1) % 3];
        vm.prank(actor);
        try engine.liquidate(target, bound(amount, 1, 1000e6), 0) returns (uint256, uint256) {
            successfulActions++;
        } catch {}
    }

    function timeAndPrice(uint256 elapsed, uint256 value) external {
        vm.warp(block.timestamp + bound(elapsed, 1, 30 days));
        int256 answer = int256(bound(value, 1, 200e8));
        primary.setAnswer(answer);
        secondary.setAnswer(answer);
        successfulActions++;
    }

    function checkpoint() external {
        pool.accrueInterest();
        successfulActions++;
    }
}

// Share deployment setup, not unit tests whose assertions assume no seed loan.
contract DockyardIsolatedInvariantTest is DockyardIsolatedCreditEngineFixture {
    IsolatedLoanHandler handler;

    function setUp() public override {
        super.setUp();
        handler = new IsolatedLoanHandler(engine, pool, cash, token, primary, secondary);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.open.selector;
        selectors[1] = handler.repay.selector;
        selectors[2] = handler.close.selector;
        selectors[3] = handler.liquidate.selector;
        selectors[4] = handler.timeAndPrice.selector;
        selectors[5] = handler.checkpoint.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        handler.open(0, 100e6);
    }

    function invariantPrincipalCollateralAndActiveCountsReconcile() public view {
        uint256 principalSum;
        uint256 collateralSum;
        uint256 count;
        uint256 borrowerInterest;
        for (uint256 i; i < 3; i++) {
            address actor = handler.actors(i);
            (uint256 coll, uint256 principal,,,) = engine.positions(actor);
            principalSum += principal;
            collateralSum += coll;
            uint256 debt = engine.positionDebt(actor);
            borrowerInterest += debt - principal;
            if (debt != 0) count++;
        }
        assertEq(pool.outstandingPrincipal(), principalSum);
        assertEq(engine.activeDebtPositions(), count);
        for (uint256 i; i < count; i++) {
            address registered = engine.activeBorrowerAt(i);
            assertGt(engine.positionDebt(registered), 0);
            for (uint256 j; j < i; j++) {
                assertTrue(engine.activeBorrowerAt(j) != registered);
            }
        }
        assertEq(token.balanceOf(address(engine)), collateralSum);
        assertGe(pool.interestReceivable() + pool.pendingInterest(), borrowerInterest);
        assertEq(cash.balanceOf(address(engine)), 0);
        assertEq(cash.allowance(address(engine), address(pool)), 0);
        assertLe(pool.maxWithdraw(address(this)), pool.availableCash());
        if (!engine.capitalOperationsAllowed()) {
            assertEq(pool.maxDeposit(address(this)), 0);
            assertEq(pool.maxMint(address(this)), 0);
            assertEq(pool.maxWithdraw(address(this)), 0);
            assertEq(pool.maxRedeem(address(this)), 0);
        }
    }
}
