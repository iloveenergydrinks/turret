// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {VariableCreditBase} from "../src/VariableCreditBase.sol";
import {TurretVariableCreditEngine} from "../src/TurretVariableCreditEngine.sol";
import {TurretVariableCapitalPool} from "../src/TurretVariableCapitalPool.sol";
import {TurretVariableMarketDeployment} from "../src/TurretVariableMarketDeployment.sol";

contract TestToken is ERC20 {
    uint8 private immutable precision;
    constructor(uint8 p) ERC20("Test", "TEST") { precision=p; }
    function decimals() public view override returns(uint8) {return precision;}
    function mint(address to,uint256 n) external {_mint(to,n);}
}

contract VariableRatesTest is Test {
    TestToken usd; TestToken token;
    TurretVariableCreditEngine engine;
    TurretVariableCapitalPool pool;
    address constant A=address(0xA1);
    address constant B=address(0xB1);
    uint256 constant KEY=12345; // Synthetic test identity, never used on a live chain.
    uint256 constant YEAR=365 days;
    uint256 constant DENOM=10000*YEAR;
    function setUp() public {
        vm.warp(1000000);
        usd=new TestToken(6);token=new TestToken(18);
        TurretVariableMarketDeployment deployment=new TurretVariableMarketDeployment(
            VariableCreditBase.Config(address(usd),address(token),address(this),2000,3500,500,50e6),
            vm.addr(KEY),1000e6,1000,1000,2000,10000,8000);
        engine=deployment.engine();pool=deployment.pool();
        assertTrue(engine.riskPaused());assertEq(engine.owner(),address(this));
        engine.setRiskPaused(false);
        usd.mint(address(this),1000000e6);usd.approve(address(pool),type(uint256).max);
        usd.approve(address(engine),type(uint256).max);
        pool.deposit(1000e6,address(this));
    }
    function signature(bytes32 digest) internal view returns(bytes memory) {
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,digest);return abi.encodePacked(r,s,v);
    }
    function open(address who,uint256 amount) internal {
        uint256 pledge=amount*1e12*10;
        token.mint(who,pledge);
        TurretVariableCreditEngine.Approval memory a=TurretVariableCreditEngine.Approval(who,1,pledge,amount,
            engine.positionDebt(who)+amount,1e18,engine.approvalNonces(who),uint64(block.timestamp),uint64(block.timestamp+30),0);
        bytes memory sig=signature(engine.approvalDigest(a));
        vm.startPrank(who);token.approve(address(engine),type(uint256).max);engine.executeApproved(a,sig);vm.stopPrank();
    }
    function reconcile() internal view {
        uint256 aggregate=pool.outstandingPrincipal()+pool.interestReceivable()+pool.pendingInterest();
        uint256 loans=engine.positionDebt(A)+engine.positionDebt(B);
        assertGe(aggregate,loans,"pool cannot owe less interest than borrowers can repay");
        assertLe(aggregate-loans,3,"only bounded micro-USDG rounding dust");
    }
    function testCurveBoundariesAndBorrowPreview() public {
        assertEq(pool.borrowAprBps(),1000);assertEq(pool.utilizationBps(),0);
        assertEq(pool.rateAtUtilization(4000),1500);assertEq(pool.rateAtUtilization(8000),2000);
        assertEq(pool.rateAtUtilization(9000),6000);assertEq(pool.rateAtUtilization(10000),10000);
        assertEq(pool.previewBorrowAprBps(800e6),2000);
        open(A,800e6);assertEq(pool.borrowAprBps(),2000);
        open(B,200e6);assertEq(pool.borrowAprBps(),10000);assertEq(pool.availableCash(),0);
        assertEq(pool.maxWithdraw(address(this)),0);
    }
    function testExistingLoansFollowNewRateOnlyProspectively() public {
        open(A,400e6); // 15% for the first year.
        vm.warp(block.timestamp+YEAR);
        assertEq(engine.positionDebt(A),460e6);
        open(B,400e6); // Now 80% utilized, 20% for both loans.
        assertEq(engine.positionDebt(A),460e6);assertEq(engine.positionDebt(B),400e6);
        vm.warp(block.timestamp+YEAR);
        assertEq(engine.positionDebt(A),540e6);assertEq(engine.positionDebt(B),480e6);
        pool.deposit(1000e6,address(this)); // Utilization 40%, 15% going forward.
        assertEq(pool.borrowAprBps(),1500);
        vm.warp(block.timestamp+YEAR);
        assertEq(engine.positionDebt(A),600e6);assertEq(engine.positionDebt(B),540e6);
        reconcile();
        engine.repay(A,type(uint256).max);engine.repay(B,type(uint256).max);
        assertEq(pool.outstandingPrincipal(),0);assertEq(pool.interestReceivable(),0);
        assertEq(pool.borrowAprBps(),1000);assertEq(pool.protocolFees(),34e6);
        assertEq(pool.totalAssets(),2306e6);
    }
    function testWithdrawRaisesRateWithoutRepricingElapsedTime() public {
        open(A,400e6);vm.warp(block.timestamp+YEAR);
        pool.withdraw(500e6,address(this),address(this));
        assertEq(pool.borrowAprBps(),2000);assertEq(engine.positionDebt(A),460e6);
        vm.warp(block.timestamp+YEAR);assertEq(engine.positionDebt(A),540e6);reconcile();
    }
    function testRepayAndCloseAvailableWhileRiskPausedAndPriceExpired() public {
        open(A,800e6);vm.warp(block.timestamp+YEAR);engine.setRiskPaused(true);
        engine.repay(A,210e6); // 160 interest + 50 principal.
        assertEq(pool.outstandingPrincipal(),750e6);assertEq(pool.protocolFees(),16e6);
        assertLt(pool.borrowAprBps(),2000);
        usd.mint(A,1000e6);vm.startPrank(A);usd.approve(address(engine),type(uint256).max);
        engine.close(type(uint256).max,A);vm.stopPrank();
        assertEq(engine.positionDebt(A),0);assertEq(token.balanceOf(A),8000e18);
        assertEq(pool.interestReceivable(),0);
        pool.redeem(pool.balanceOf(address(this)),address(this),address(this));
        assertLe(pool.availableCash(),1); // ERC-4626 virtual-share rounding residue.
    }
    function testCheckpointFrequencyDoesNotChangeDebt() public {
        open(A,333333337);open(B,222222229);
        uint256 start=block.timestamp;uint256 beforeId=vm.snapshotState();
        vm.warp(start+100000);uint256 a=engine.positionDebt(A);uint256 b=engine.positionDebt(B);
        uint256 total=pool.totalAssets();
        vm.revertToState(beforeId);
        for(uint256 i=1;i<=100;i++){vm.warp(start+i*1000);pool.accrueInterest();}
        assertEq(engine.positionDebt(A),a);assertEq(engine.positionDebt(B),b);assertEq(pool.totalAssets(),total);reconcile();
    }
    function testSameBlockLiquidityRoundTripCannotEraseInterest() public {
        open(A,800e6);vm.warp(block.timestamp+YEAR);
        uint256 debt=engine.positionDebt(A);uint256 integral=pool.currentRateIntegral();
        uint256 shares=pool.deposit(100000e6,address(this));assertLt(pool.borrowAprBps(),2000);
        pool.redeem(shares,address(this),address(this));
        assertApproxEqAbs(pool.borrowAprBps(),2000,1); // One micro-USDG share rounding can move the rounded quote by 1 bp.
        assertEq(pool.currentRateIntegral(),integral);
        assertEq(engine.positionDebt(A),debt);
    }
    function testDonationOnlyChangesFutureRateOnSync() public {
        open(A,800e6);vm.warp(block.timestamp+YEAR);
        usd.transfer(address(pool),1000e6);
        assertEq(pool.borrowAprBps(),2000);assertEq(engine.positionDebt(A),960e6);
        pool.accrueInterest();assertEq(pool.borrowAprBps(),1500);
        assertEq(engine.positionDebt(A),960e6);
        vm.warp(block.timestamp+YEAR);assertEq(engine.positionDebt(A),1080e6);reconcile();
    }
    function testLossLiquidationSettlesAtHistoricalRates() public {
        open(A,400e6);open(B,400e6);vm.warp(block.timestamp+YEAR);
        // Crash collateral to $0.01: sale cannot cover principal; recognize the shortfall.
        TurretVariableCreditEngine.Price memory p=TurretVariableCreditEngine.Price(1e16,uint64(block.timestamp),uint64(block.timestamp+30),0);
        engine.submitPrice(p,signature(engine.priceDigest(p)));
        engine.liquidate(A,type(uint256).max,1);
        assertEq(engine.positionDebt(A),0);assertGt(pool.cumulativeLoss(),400e6);
        assertEq(engine.positionDebt(B),480e6);reconcile();
        engine.repay(B,type(uint256).max);
        assertEq(pool.outstandingPrincipal(),0);assertEq(pool.interestReceivable(),0);
        assertFalse(pool.liquidationSettlementActive());
    }
    function testFeeClaimDoesNotChangeSpendableCashOrRate() public {
        open(A,800e6);vm.warp(block.timestamp+YEAR);engine.repay(A,160e6);
        uint256 cash=pool.availableCash();uint256 rate=pool.borrowAprBps();pool.claimRevenue();
        assertEq(pool.availableCash(),cash);assertEq(pool.borrowAprBps(),rate);
    }
    function testBoundedCapitalMethodsRefreshRatesAndPreserveSlippage() public {
        open(A,800e6);
        uint256 shares=pool.depositWithMinShares(1000e6,address(this),1,block.timestamp+300);
        assertEq(pool.borrowAprBps(),1500);
        pool.redeemWithMinAssets(shares,address(this),address(this),999e6,block.timestamp+300);
        assertEq(pool.borrowAprBps(),2000);
        vm.expectRevert(TurretVariableCapitalPool.Slippage.selector);
        pool.withdrawWithMaxShares(100e6,address(this),address(this),1,block.timestamp+300);
        assertEq(pool.borrowAprBps(),2000);
        pool.withdrawWithMaxShares(100e6,address(this),address(this),type(uint256).max,block.timestamp+300);
        assertGt(pool.borrowAprBps(),2000);
    }
    function testFuzzCurveMonotoneAndBounded(uint16 x,uint16 y) public view {
        uint256 lo=bound(x,0,10000);uint256 hi=bound(y,lo,10000);
        assertGe(pool.rateAtUtilization(lo),1000);
        assertLe(pool.rateAtUtilization(lo),pool.rateAtUtilization(hi));
        assertLe(pool.rateAtUtilization(hi),10000);
    }
    function testFuzzMultiBorrowerAccounting(uint96 a,uint96 b,uint32 t1,uint32 t2) public {
        uint256 first=bound(a,50e6,450e6);uint256 second=bound(b,50e6,450e6);
        open(A,first);vm.warp(block.timestamp+bound(t1,1,365 days));open(B,second);
        vm.warp(block.timestamp+bound(t2,1,365 days));reconcile();
        pool.deposit(137e6,address(this));reconcile();
        engine.repay(A,type(uint256).max);reconcile();engine.repay(B,type(uint256).max);
        assertEq(pool.outstandingPrincipal(),0);assertEq(pool.interestReceivable(),0);
        assertLe(pool.cumulativeLoss(),3); // Fractional debt rounding, never material losses.
    }
    function testRejectInvalidCurve() public {
        vm.expectRevert(TurretVariableCapitalPool.InvalidConfiguration.selector);
        new TurretVariableCapitalPool(IERC20Metadata(address(usd)),address(token),address(engine),address(this),1000e6,1000,2000,1000,10000,8000);
        vm.expectRevert(TurretVariableCapitalPool.InvalidConfiguration.selector);
        new TurretVariableCapitalPool(IERC20Metadata(address(usd)),address(token),address(engine),address(this),1000e6,1000,1000,2000,10000,10000);
    }
}
