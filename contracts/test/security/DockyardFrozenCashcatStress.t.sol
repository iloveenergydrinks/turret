// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardMockERC20} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCreditEngine as Engine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool as Pool} from "src/research/DockyardIsolatedCapitalPool.sol";

/// @dev Test-controlled external operator boundary. Authentication is NOT tested here.
contract FrozenCashcatOperatorBoundary {
    address public asset;
    address public quote;
    uint8 public constant decimals = 18;
    uint256 public constant threshold = 1;
    uint256 public constant reporterCount = 1;
    uint256 public constant maxAge = 10;
    string public constant oracleTrustModel = "dockyard-operated";
    uint256 public value = 100e18;
    uint256 public updated;

    constructor(address a, address q) {
        asset = a;
        quote = q;
        updated = block.timestamp;
    }

    function set(uint256 v) external {
        value = v;
        updated = block.timestamp;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(block.timestamp - updated < 10, "expired operator report");
        return (uint80(updated), int256(value), updated, updated, uint80(updated));
    }
}

/// @dev Injects market state at the reader boundary; real V3 liquidity is not modeled.
contract FrozenCashcatDexBoundary {
    address public collateral;
    address public usdg;
    uint8 public constant decimals = 18;
    uint256 public average = 100e18;
    uint256 public spot = 100e18;
    uint256 public lastWrite;
    bool public normal = true;

    constructor(address a, address q) {
        collateral = a;
        usdg = q;
        lastWrite = block.timestamp;
    }

    function set(uint256 a, uint256 s, bool n) external {
        average = a;
        spot = s;
        normal = n;
    }

    function guardedQuotes() external view returns (uint256, uint256, uint256, bool) {
        return (average, spot, lastWrite, normal);
    }
}

/// @notice Deploys the frozen CASHCAT release creation bytecode, not sibling
/// source that has since changed. New local addresses/immutables and mock inputs.
contract DockyardFrozenCashcatStressTest is Test {
    DockyardMockERC20 cash;
    DockyardMockERC20 token;
    FrozenCashcatOperatorBoundary operator;
    FrozenCashcatDexBoundary dex;
    Engine engine;
    Pool pool;
    address borrower = makeAddr("frozen borrower");
    address keeper = makeAddr("frozen keeper");

    function _deploy(string memory name, bytes memory args) internal returns (address deployed) {
        bytes memory code =
            abi.encodePacked(vm.getCode(string.concat("../output/cashcat-quiet-pool/artifacts/", name, ".json")), args);
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "frozen deployment failed");
    }

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1_000_000);
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        token = new DockyardMockERC20("CASHCAT", "CASHCAT", 18);
        operator = new FrozenCashcatOperatorBoundary(address(token), address(cash));
        dex = new FrozenCashcatDexBoundary(address(token), address(cash));
        address primary =
            _deploy("DockyardCashcatReferenceFeed", abi.encode(address(dex), address(operator), uint16(500)));
        engine = Engine(
            _deploy(
                "DockyardCashcatCreditEngine",
                abi.encode(
                    Engine.Config(
                        address(cash),
                        address(token),
                        primary,
                        address(operator),
                        address(this),
                        300,
                        3000,
                        5000,
                        500,
                        500,
                        10e6
                    )
                )
            )
        );
        pool = Pool(
            _deploy(
                "DockyardCashcatCapitalPool",
                abi.encode(
                    address(cash), address(token), address(engine), address(this), 200e6, uint16(1000), uint16(1000)
                )
            )
        );
        engine.bindPool(pool);
        engine.setRiskPaused(false);
        cash.mint(address(this), 200e6);
        cash.approve(address(pool), type(uint256).max);
        pool.deposit(200e6, address(this));
        token.mint(borrower, 1e18);
        cash.mint(borrower, 100e6);
        cash.mint(keeper, 1000e6);
        vm.startPrank(borrower);
        token.approve(address(engine), type(uint256).max);
        cash.approve(address(engine), type(uint256).max);
        engine.depositAndBorrow(1e18, 30e6);
        vm.stopPrank();
        vm.prank(keeper);
        cash.approve(address(engine), type(uint256).max);
    }

    function _shock(uint256 value) internal {
        dex.set(100e18, value, false);
        operator.set(value);
    }

    function testFrozenCorroboratedGapLiquidatesWithoutWaitingForTwap() public {
        vm.warp(block.timestamp + 7 days);
        _shock(20e18);
        uint256 debt = engine.positionDebt(borrower);
        uint256 interest = debt - 30e6;
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(borrower, 30e6, 1);
        assertEq(seized, 1e18);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(pool.cumulativeLoss(), debt - paid);
        assertEq(pool.totalAssets(), 170e6 + paid - interest / 10);
        emit log_named_uint("recovered micro-USDG", paid);
        emit log_named_uint("recognized gross loss micro-USDG", pool.cumulativeLoss());
    }

    function testFuzzFrozenCrashConservesCashAndRecognizesShortfall(uint96 price) public {
        _shock(bound(price, 1, 59e18));
        (uint256 q, uint256 c) = engine.liquidationQuote(borrower, type(uint256).max);
        vm.prank(keeper);
        (uint256 paid, uint256 seized) = engine.liquidate(borrower, q, c);
        assertEq(paid, q);
        assertEq(seized, c);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(pool.outstandingPrincipal(), 0);
        assertEq(pool.cumulativeLoss() + paid, 30e6);
        assertEq(pool.totalAssets(), 170e6 + paid);
        assertEq(cash.balanceOf(keeper), 1000e6 - paid);
        assertEq(cash.balanceOf(address(engine)), 0);
    }

    function testFuzzFrozenPriceExpiryCannotBeRenewedByQuietPool(uint32 age) public {
        _shock(20e18);
        vm.warp(block.timestamp + bound(age, 10, 30 days));
        vm.prank(keeper);
        vm.expectRevert();
        engine.liquidate(borrower, 30e6, 1);
        assertEq(cash.balanceOf(keeper), 1000e6);
        assertEq(pool.outstandingPrincipal(), 30e6);
        assertEq(pool.maxWithdraw(address(this)), 0);
        vm.prank(borrower);
        engine.close(type(uint256).max, borrower);
        pool.redeem(pool.balanceOf(address(this)), address(this), address(this));
        assertEq(pool.totalSupply(), 0);
    }

    function testFrozenExactlyNineSecondsWorksAndTenSecondsFails() public {
        _shock(20e18);
        vm.warp(block.timestamp + 9);
        assertEq(engine.price(), 20e18);
        vm.warp(block.timestamp + 1);
        vm.expectRevert();
        engine.price();
    }

    function testFrozenDexOnlyShockBlocksLiquidationAndLeavesBalancesUntouched() public {
        dex.set(100e18, 20e18, false);
        vm.prank(keeper);
        vm.expectRevert();
        engine.liquidate(borrower, 30e6, 1);
        assertEq(engine.positionDebt(borrower), 30e6);
        assertEq(pool.cumulativeLoss(), 0);
        assertEq(cash.balanceOf(keeper), 1000e6);
    }

    function testFrozenSmallPartialFillCannotLeaveUnserviceableCollateral() public {
        _shock(20e18);
        (uint256 full,) = engine.liquidationQuote(borrower, type(uint256).max);
        (uint256 q, uint256 c) = engine.liquidationQuote(borrower, full - 1);
        vm.prank(keeper);
        engine.liquidate(borrower, q, c);
        (uint256 recovery,) = engine.liquidationQuote(borrower, type(uint256).max);
        assertGe(recovery, engine.minimumDebt());
        vm.prank(keeper);
        engine.liquidate(borrower, recovery, 1);
        assertEq(engine.activeDebtPositions(), 0);
        assertEq(pool.outstandingPrincipal(), 0);
    }
}
