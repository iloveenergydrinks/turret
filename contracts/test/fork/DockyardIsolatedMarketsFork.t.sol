// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {DockyardIsolatedCapitalPool} from "src/research/DockyardIsolatedCapitalPool.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardAtomicLiquidator} from "src/research/DockyardAtomicLiquidator.sol";

interface IForkV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IForkWrappedEther {
    function deposit() external payable;
}

/// @notice Real token and DEX bytecode, local new credit contracts, mock oracle
/// answers derived from pool spot prices. NOT a production oracle validation.
/// Native ETH is funded only on the fork. Crash tests give a simulated whale
/// token inventory with deal(); all price movement then uses actual pool swaps.
/// No private key, user wallet impersonation, or transaction broadcast is used.
abstract contract DockyardIsolatedMarketsForkFixture is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant CASHCAT = 0x020bfC650A365f8BB26819deAAbF3E21291018b4;
    address constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address constant CASHCAT_POOL = 0xA70fc67C9F69da90B63a0e4C05D229954574E313;
    address constant PONS_POOL = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA;
    address constant USDG_POOL = 0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address borrower = makeAddr("isolated-fork-borrower");
    address private callbackPool;
    address private callbackToken;
    uint256 private callbackBudget;
    DockyardIsolatedCreditEngine engine;
    DockyardIsolatedCapitalPool capital;
    DockyardMockOracle primary;
    DockyardMockOracle secondary;

    struct ExitResult {
        uint256 paid;
        uint256 seized;
        uint256 usdgOut;
        uint256 gasUsed;
    }

    function setUp() public {
        string memory rpc = vm.envOr("ISOLATED_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true, "Explicit RPC and pinned block required");
        uint256 pinned = vm.envOr("ISOLATED_FORK_BLOCK", uint256(0));
        require(pinned != 0, "Pinned fork block required");
        vm.createSelectFork(rpc, pinned);
        assertEq(block.chainid, 4663);
        assertEq(CASHCAT.codehash, bytes32(0x725781ccca82a0bf9b1f8920b2fe58ea1e4facf46d0db9f50226d6409de890fe));
        assertEq(PONS.codehash, bytes32(0x16c3d3ede897688ddff79262606f13bead398332e65001f192460fbac4e1fb85));
        for (uint256 i; i < 3; i++) {
            address venue = i == 0 ? CASHCAT_POOL : i == 1 ? PONS_POOL : USDG_POOL;
            assertEq(IForkV3Pool(venue).factory(), FACTORY);
        }
        vm.deal(address(this), 20 ether);
        IForkWrappedEther(WETH).deposit{value: 10 ether}();
    }

    function _deployFeeds(address, address, uint256 initialPrice) internal virtual returns (address, address) {
        primary = new DockyardMockOracle(18, int256(initialPrice));
        secondary = new DockyardMockOracle(18, int256(initialPrice));
        return (address(primary), address(secondary));
    }

    function _open(address token, address venue)
        internal
        returns (uint256 collateral, uint256 loan, uint256 initialPrice)
    {
        return _openSized(token, venue, 1 ether, 0.1 ether);
    }

    function _poolDebtLimit() internal pure virtual returns (uint256) {
        return 100000e6;
    }

    function _openSized(address token, address venue, uint256 lenderWeth, uint256 collateralWeth)
        internal
        returns (uint256 collateral, uint256 loan, uint256 initialPrice)
    {
        uint256 lenderCash = _swap(WETH, USDG_POOL, lenderWeth);
        collateral = _swap(WETH, venue, collateralWeth);
        initialPrice = _tokenPrice(venue, token);
        (address firstFeed, address secondFeed) = _deployFeeds(token, venue, initialPrice);
        engine = new DockyardIsolatedCreditEngine(
            DockyardIsolatedCreditEngine.Config({
                usdg: USDG,
                collateral: token,
                primary: firstFeed,
                secondary: secondFeed,
                guardian: address(this),
                staleness: 1 hours,
                maxLtvBps: 5000,
                liquidationLtvBps: 6500,
                bonusBps: 500,
                deviationBps: 500,
                minimumDebt: 1e6
            })
        );
        capital = new DockyardIsolatedCapitalPool(
            IERC20Metadata(USDG), token, address(engine), makeAddr("fork-treasury"), _poolDebtLimit(), 1000, 1000
        );
        engine.bindPool(capital);
        engine.setRiskPaused(false);
        uint256 supplied = lenderCash * 8 / 10;
        IERC20(USDG).approve(address(capital), supplied);
        capital.deposit(supplied, address(this));
        IERC20(token).transfer(borrower, collateral);
        loan = Math.mulDiv(Math.mulDiv(collateral, initialPrice, 1e18), 4000, 10000) / 1e12;
        assertGt(loan, 1e6);
        vm.startPrank(borrower);
        IERC20(token).approve(address(engine), collateral);
        engine.depositAndBorrow(collateral, loan);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(address(engine)), collateral);
        assertEq(IERC20(USDG).balanceOf(borrower), loan);
    }

    function _lifecycle(address token, address venue) internal {
        (uint256 collateral, uint256 loan,) = _open(token, venue);
        uint256 lent = capital.totalAssets();
        vm.warp(block.timestamp + 2 days);
        engine.setRiskPaused(true);
        primary.setShouldRevert(true);
        secondary.setShouldRevert(true);
        uint256 due = engine.positionDebt(borrower);
        IERC20(USDG).transfer(borrower, due - loan);
        vm.startPrank(borrower);
        IERC20(USDG).approve(address(engine), due);
        engine.close(due, borrower);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(borrower), collateral);
        assertEq(IERC20(token).balanceOf(address(engine)), 0);
        assertEq(capital.outstandingPrincipal(), 0);
        assertEq(capital.interestReceivable(), 0);
        assertEq(IERC20(USDG).allowance(borrower, address(engine)), 0);
        assertEq(IERC20(USDG).allowance(address(engine), address(capital)), 0);
        uint256 recovered = capital.redeem(capital.balanceOf(address(this)), address(this), address(this));
        assertGe(recovered, lent);
        emit log_named_address("Lifecycle token", token);
        emit log_named_uint("USDG borrowed (6 decimals)", loan);
        emit log_named_uint("USDG repaid (6 decimals)", due);
        emit log_named_uint("Lender USDG recovered (6 decimals)", recovered);
    }

    function _crash(address token, address venue, uint256 targetBps) internal {
        (uint256 collateral, uint256 loan, uint256 initialPrice) = _open(token, venue);
        uint256 chunk = IERC20(token).balanceOf(venue) / 20;
        assertGt(chunk, 0);
        uint256 target = initialPrice * targetBps / 10000;
        for (uint256 i; i < 40 && _tokenPrice(venue, token) > target; i++) {
            // Synthetic external whale inventory, not a purchase or lender asset.
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + chunk);
            _swap(token, venue, chunk);
        }
        uint256 shockedPrice = _tokenPrice(venue, token);
        assertLe(shockedPrice, target, "Crash target was not reached");
        primary.setAnswer(int256(shockedPrice));
        secondary.setAnswer(int256(shockedPrice));
        assertFalse(capital.capitalOperationsAllowed());
        ExitResult memory result = _liquidateAndExit(token, venue);
        assertLe(result.seized, collateral);
        assertGt(result.usdgOut, 0);
        assertEq(engine.positionDebt(borrower), 0);
        assertEq(capital.outstandingPrincipal(), 0);
        assertEq(capital.interestReceivable(), 0);
        assertTrue(capital.capitalOperationsAllowed());
        if (targetBps == 2500) assertGt(capital.cumulativeLoss(), 0);
        else assertEq(capital.cumulativeLoss(), 0, "Solvent scenario must repay all lender principal");
        emit log_named_address("Liquidated token", token);
        emit log_named_uint("Actual price fraction after crash (bps)", shockedPrice * 10000 / initialPrice);
        emit log_named_uint("Loan USDG (6 decimals)", loan);
        emit log_named_uint("Liquidator USDG paid (6 decimals)", result.paid);
        emit log_named_uint("Real two-hop USDG sale proceeds (6 decimals)", result.usdgOut);
        emit log_named_int(
            "Liquidator gross USDG margin before gas (6 decimals)", int256(result.usdgOut) - int256(result.paid)
        );
        emit log_named_uint("Pool recognized USDG loss (6 decimals)", capital.cumulativeLoss());
        emit log_named_uint("Liquidation plus exit harness gas (not full L2 fee estimate)", result.gasUsed);
    }

    function _liquidateAndExit(address token, address venue) internal returns (ExitResult memory result) {
        (uint256 expectedPaid, uint256 expectedSeized) = engine.liquidationQuote(borrower, type(uint256).max);
        DockyardAtomicLiquidator executor =
            new DockyardAtomicLiquidator(address(engine), WETH, venue, USDG_POOL, FACTORY);
        IERC20(USDG).approve(address(executor), expectedPaid);
        uint256 cashBefore = IERC20(USDG).balanceOf(address(this));
        uint256 debtBefore = engine.positionDebt(borrower);
        uint256 collateralBefore = IERC20(token).balanceOf(address(engine));
        // A sale that misses its return floor must roll back even an insolvent
        // liquidation, its loss recognition, and both real pool swaps.
        vm.expectRevert(DockyardAtomicLiquidator.InsufficientReturn.selector);
        executor.liquidateAndSell(borrower, expectedPaid, expectedSeized, 1000000e6, block.timestamp + 60);
        assertEq(IERC20(USDG).balanceOf(address(this)), cashBefore);
        assertEq(engine.positionDebt(borrower), debtBefore);
        assertEq(IERC20(token).balanceOf(address(engine)), collateralBefore);
        assertEq(capital.cumulativeLoss(), 0);
        uint256 gasBefore = gasleft();
        (result.paid, result.seized, result.usdgOut) =
            executor.liquidateAndSell(borrower, expectedPaid, expectedSeized, 1, block.timestamp + 60);
        assertEq(result.paid, expectedPaid);
        assertEq(result.seized, expectedSeized);
        assertEq(IERC20(USDG).balanceOf(address(this)), cashBefore + result.usdgOut - result.paid);
        assertEq(IERC20(USDG).allowance(address(executor), address(engine)), 0);
        assertEq(IERC20(USDG).balanceOf(address(executor)), 0);
        assertEq(IERC20(token).balanceOf(address(executor)), 0);
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0);
        result.gasUsed = gasBefore - gasleft();
    }

    function _tokenPrice(address venue, address token) internal view returns (uint256) {
        uint256 wethPerToken = _spotQuote(venue, token, 1e18);
        return _spotQuote(USDG_POOL, WETH, wethPerToken) * 1e12;
    }

    function _spotQuote(address venue, address input, uint256 amount) private view returns (uint256) {
        (uint160 sqrtPrice,,,,,,) = IForkV3Pool(venue).slot0();
        uint256 ratioX64 = Math.mulDiv(sqrtPrice, sqrtPrice, 1 << 128); // Q64 ratio, avoids squaring overflow
        if (IForkV3Pool(venue).token0() == input) return Math.mulDiv(amount, ratioX64, 1 << 64);
        require(IForkV3Pool(venue).token1() == input, "Wrong quote input");
        return Math.mulDiv(amount, 1 << 64, ratioX64);
    }

    function _swap(address input, address venue, uint256 amount) internal returns (uint256 output) {
        require(callbackPool == address(0), "Nested swap");
        IForkV3Pool p = IForkV3Pool(venue);
        bool zeroForOne = p.token0() == input;
        require(zeroForOne || p.token1() == input, "Wrong swap input");
        address outToken = zeroForOne ? p.token1() : p.token0();
        uint256 beforeBalance = IERC20(outToken).balanceOf(address(this));
        callbackPool = venue;
        callbackToken = input;
        callbackBudget = amount;
        p.swap(
            address(this),
            zeroForOne,
            int256(amount),
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
            ""
        );
        require(callbackBudget == 0, "Swap did not consume the full intended input");
        callbackPool = address(0);
        callbackToken = address(0);
        callbackBudget = 0;
        output = IERC20(outToken).balanceOf(address(this)) - beforeBalance;
        require(output != 0, "No swap output");
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        require(msg.sender == callbackPool && callbackPool != address(0), "Unexpected callback");
        bool paysZero = amount0Delta > 0;
        require(paysZero ? amount1Delta <= 0 : amount1Delta > 0, "Invalid deltas");
        address input = paysZero ? IForkV3Pool(msg.sender).token0() : IForkV3Pool(msg.sender).token1();
        uint256 owed = uint256(paysZero ? amount0Delta : amount1Delta);
        require(input == callbackToken && owed <= callbackBudget, "Unexpected payment");
        callbackBudget -= owed;
        require(IERC20(input).transfer(msg.sender, owed), "Callback payment failed");
    }
}

contract DockyardIsolatedMarketsForkTest is DockyardIsolatedMarketsForkFixture {
    function testCashcatRealAcquisitionBorrowRepayAndWithdrawal() public {
        _lifecycle(CASHCAT, CASHCAT_POOL);
    }

    function testPonsRealAcquisitionBorrowRepayAndWithdrawal() public {
        _lifecycle(PONS, PONS_POOL);
    }

    function testCashcatSolventLiquidationAndRealUsdgExit() public {
        _crash(CASHCAT, CASHCAT_POOL, 5500);
    }

    function testPonsSolventLiquidationAndRealUsdgExit() public {
        _crash(PONS, PONS_POOL, 5500);
    }

    function testCashcatInsolventLiquidationAndRealUsdgExit() public {
        _crash(CASHCAT, CASHCAT_POOL, 2500);
    }

    function testPonsInsolventLiquidationAndRealUsdgExit() public {
        _crash(PONS, PONS_POOL, 2500);
    }
}
