// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

import {DockyardUSDGCreditVault} from "src/DockyardUSDGCreditVault.sol";

contract DockyardMockERC20 is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract DockyardMockStockToken is DockyardMockERC20 {
    bool public oraclePaused;

    constructor() DockyardMockERC20("Apple Stock Token", "AAPL", 18) {}

    function setOraclePaused(bool value) external {
        oraclePaused = value;
    }
}

contract DockyardMockOracle {
    uint8 public immutable decimals;
    int256 public answer;
    uint80 public roundId = 1;
    uint256 public updatedAt;
    bool public shouldRevert;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        roundId++;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "oracle unavailable");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract DockyardUSDGCreditVaultTest is Test {
    uint256 internal constant USDG_UNIT = 1e6;
    uint256 internal constant STOCK_UNIT = 1e18;

    DockyardMockERC20 internal usdg;
    DockyardMockStockToken internal aapl;
    DockyardMockOracle internal primary;
    DockyardMockOracle internal secondary;
    DockyardUSDGCreditVault internal vault;

    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    function setUp() public {
        vm.warp(1_000_000);
        usdg = new DockyardMockERC20("Global Dollar", "USDG", 6);
        aapl = new DockyardMockStockToken();
        primary = new DockyardMockOracle(8, 100e8);
        secondary = new DockyardMockOracle(8, 100e8);
        vault = new DockyardUSDGCreditVault(address(usdg), address(this), 50, 1 days);
        vault.addMarket(
            address(aapl), address(primary), address(secondary), uint128(1_000_000 * USDG_UNIT), 5_000, 6_000, 500, 500
        );

        usdg.mint(address(this), 1_000_000 * USDG_UNIT);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(1_000_000 * USDG_UNIT);

        aapl.mint(borrower, 100 * STOCK_UNIT);
        vm.prank(borrower);
        aapl.approve(address(vault), type(uint256).max);

        usdg.mint(liquidator, 1_000_000 * USDG_UNIT);
        vm.prank(liquidator);
        usdg.approve(address(vault), type(uint256).max);
    }

    function testOwnerFundsBorrowerBorrowsAndRepaysUSDG() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 400 * USDG_UNIT);
        vm.stopPrank();

        (uint128 collateral, uint128 debt) = vault.positions(address(aapl), borrower);
        assertEq(collateral, 10 * STOCK_UNIT);
        assertEq(debt, 402 * USDG_UNIT);
        assertEq(usdg.balanceOf(borrower), 400 * USDG_UNIT);
        assertEq(vault.positionLtvBps(address(aapl), borrower), 4_020);

        usdg.mint(borrower, 2 * USDG_UNIT);
        vm.startPrank(borrower);
        usdg.approve(address(vault), type(uint256).max);
        vault.repay(address(aapl), borrower, type(uint256).max);
        vault.withdrawCollateral(address(aapl), 10 * STOCK_UNIT, borrower);
        vm.stopPrank();

        (collateral, debt) = vault.positions(address(aapl), borrower);
        assertEq(collateral, 0);
        assertEq(debt, 0);
        assertEq(aapl.balanceOf(borrower), 100 * STOCK_UNIT);
    }

    function testBorrowCannotExceedMaximumLtv() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vm.expectRevert(DockyardUSDGCreditVault.PositionWouldBeUnsafe.selector);
        vault.borrow(address(aapl), 500 * USDG_UNIT);
        vm.stopPrank();
    }

    function testLiquidatorRepaysUSDGAndReceivesDiscountedCollateral() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 450 * USDG_UNIT);
        vm.stopPrank();

        primary.setAnswer(70e8);
        secondary.setAnswer(70e8);

        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = vault.liquidate(address(aapl), borrower, type(uint256).max, liquidator);

        assertEq(repaid, 452_250_000);
        assertApproxEqAbs(seized, 6_783_750_000_000_000_000, 1);
        assertEq(aapl.balanceOf(liquidator), seized);
        (, uint128 remainingDebt) = vault.positions(address(aapl), borrower);
        assertEq(remainingDebt, 0);
    }

    function testHealthyPositionCannotBeLiquidated() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 400 * USDG_UNIT);
        vm.stopPrank();

        vm.prank(liquidator);
        vm.expectRevert(DockyardUSDGCreditVault.PositionIsHealthy.selector);
        vault.liquidate(address(aapl), borrower, type(uint256).max, liquidator);
    }

    function testSecondaryOracleKeepsMarketAvailable() public {
        primary.setShouldRevert(true);

        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 400 * USDG_UNIT);
        vm.stopPrank();

        assertEq(usdg.balanceOf(borrower), 400 * USDG_UNIT);
    }

    function testOracleMismatchFailsClosed() public {
        primary.setAnswer(100e8);
        secondary.setAnswer(90e8);

        vm.prank(borrower);
        vm.expectRevert(
            abi.encodeWithSelector(DockyardUSDGCreditVault.OracleMismatch.selector, uint256(100e18), uint256(90e18))
        );
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
    }

    function testStaleOraclesFailClosed() public {
        vm.warp(block.timestamp + 1 days);

        vm.prank(borrower);
        vm.expectRevert(DockyardUSDGCreditVault.OracleUnavailable.selector);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
    }

    function testRobinhoodCorporateActionPauseFailsClosed() public {
        aapl.setOraclePaused(true);

        vm.prank(borrower);
        vm.expectRevert(DockyardUSDGCreditVault.StockTokenPaused.selector);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
    }

    function testOnlyOwnerCanWithdrawAvailableUSDG() public {
        vm.prank(borrower);
        vm.expectRevert("Ownable: caller is not the owner");
        vault.withdrawLiquidity(borrower, USDG_UNIT);

        uint256 balanceBefore = usdg.balanceOf(address(this));
        vault.withdrawLiquidity(address(this), 10 * USDG_UNIT);
        assertEq(usdg.balanceOf(address(this)), balanceBefore + 10 * USDG_UNIT);
    }

    function testPauseStopsNewRiskButRepaymentRemainsAvailable() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 400 * USDG_UNIT);
        vm.stopPrank();
        vault.pause();

        vm.prank(borrower);
        vm.expectRevert("Pausable: paused");
        vault.borrow(address(aapl), USDG_UNIT);

        usdg.mint(borrower, 2 * USDG_UNIT);
        vm.startPrank(borrower);
        usdg.approve(address(vault), type(uint256).max);
        vault.repay(address(aapl), borrower, type(uint256).max);
        vault.withdrawCollateral(address(aapl), 10 * STOCK_UNIT, borrower);
        vm.stopPrank();

        assertEq(aapl.balanceOf(borrower), 100 * STOCK_UNIT);
    }

    function testPausedMarketStillAllowsLiquidation() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 450 * USDG_UNIT);
        vm.stopPrank();
        primary.setAnswer(70e8);
        secondary.setAnswer(70e8);
        vault.pause();

        vm.prank(liquidator);
        (uint256 repaid,) = vault.liquidate(address(aapl), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 452_250_000);
    }

    function testInsolventPositionCanBeExhaustedAndWrittenOff() public {
        vm.startPrank(borrower);
        vault.depositCollateral(address(aapl), 10 * STOCK_UNIT);
        vault.borrow(address(aapl), 450 * USDG_UNIT);
        vm.stopPrank();
        primary.setAnswer(10e8);
        secondary.setAnswer(10e8);

        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = vault.liquidate(address(aapl), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 95_238_095);
        assertEq(seized, 10 * STOCK_UNIT);

        (, uint128 remainingDebt) = vault.positions(address(aapl), borrower);
        assertGt(remainingDebt, 0);
        vault.writeOffBadDebt(address(aapl), borrower);
        (, remainingDebt) = vault.positions(address(aapl), borrower);
        assertEq(remainingDebt, 0);
    }
}
