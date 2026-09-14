// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {VariableCreditBase} from "../src/VariableCreditBase.sol";
import {TurretVariableCreditEngine} from "../src/TurretVariableCreditEngine.sol";
import {TurretVariableCapitalPool} from "../src/TurretVariableCapitalPool.sol";
import {TurretVariableLiquidator} from "../src/TurretVariableLiquidator.sol";
import {PonsLpPositions} from "./PonsLpPositions.sol";

interface V3 {
 function token0() external view returns(address);
 function token1() external view returns(address);
 function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool);
 function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
 function liquidity() external view returns(uint128);
 function positions(bytes32) external view returns(uint128,uint256,uint256,uint128,uint128);
 function burn(int24,int24,uint128) external returns(uint256,uint256);
 function collect(address,int24,int24,uint128,uint128) external returns(uint128,uint128);
}
interface Wrapped {function deposit() external payable;}

/// Local contracts and synthetic test signer on pinned real Robinhood state.
/// Real token transfers and V3 swaps execute in the fork; nothing is broadcast.
contract PonsVariableForkTest is Test {
 address constant PONS=0x39dBED3a2bd333467115dE45665cC57F813C4571;
 address constant USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
 address constant WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
 address constant FIRST=0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA;
 address constant SECOND=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca;
 address constant DIRECT=0x7A192E71564ec66eE0763e328a3Ac274942dE4e1;
 address constant FACTORY=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
 address constant ROUTER=0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
 address constant TARGET=0x8F10B468b06c6FD214B65F87778827F7D113f996;
 address constant BORROWER=address(0xB0B);
 uint256 constant KEY=12345; // Public test-only signer. Never a funded account.
 TurretVariableCreditEngine engine;
 TurretVariableCapitalPool capital;
 TurretVariableLiquidator exit;
 address callbackPool;address callbackToken;uint256 callbackBudget;
 uint256 initialPrice;
 struct Before {uint256 debt;uint256 loss;uint256 held;uint256 cash;uint256 keeperCash;uint256 startGas;}

 function setUp() public {
  uint256 pinned=vm.envOr("PONS_FORK_BLOCK",uint256(0));
  if(pinned==0){vm.skip(true);return;}
  vm.createSelectFork(vm.envString("PONS_FORK_RPC"),pinned);
  assertEq(block.chainid,4663);
  assertEq(PONS.codehash,bytes32(0x16c3d3ede897688ddff79262606f13bead398332e65001f192460fbac4e1fb85));
  vm.deal(address(this),1000 ether);Wrapped(WETH).deposit{value:1000 ether}();
  _swap(WETH,SECOND,100 ether,0);
  _configureRisk(3000,5000,100000e6);
 }
 function _configureRisk(uint16 maxLtv,uint16 liquidationLtv,uint256 cap) internal {
  _configureRiskWithMinimum(maxLtv,liquidationLtv,cap,10e6);
 }
 function _configurePilot(uint256 cap) internal {
  _configureRiskWithMinimum(2000,3500,cap,50e6);
 }
 function _configureRiskWithMinimum(uint16 maxLtv,uint16 liquidationLtv,uint256 cap,uint256 minimum) internal {
  if(address(capital)!=address(0))capital.redeem(capital.balanceOf(address(this)),address(this),address(this));
  engine=new TurretVariableCreditEngine(VariableCreditBase.Config(USDG,PONS,address(this),maxLtv,liquidationLtv,500,minimum),vm.addr(KEY));
  capital=new TurretVariableCapitalPool(IERC20Metadata(USDG),PONS,address(engine),address(this),cap,1000,1000,2000,10000,8000);
  engine.bindPool(capital);engine.setRiskPaused(false);
  IERC20Metadata(USDG).approve(address(capital),type(uint256).max);capital.deposit(cap,address(this));
  exit=_executor(false);assertTrue(exit.routeHealthy());
 }
 function _executor(bool direct) internal returns(TurretVariableLiquidator){
  return new TurretVariableLiquidator(address(engine),direct?address(0):WETH,direct?DIRECT:FIRST,
   direct?address(0):SECOND,FACTORY,ROUTER,ROUTER.codehash,TARGET,TARGET.codehash);
 }
 function _sign(bytes32 h) internal view returns(bytes memory){(uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,h);return abi.encodePacked(r,s,v);}
 function _quote(address pool,address token,uint256 amount) internal view returns(uint256){
  (uint160 sqrt,,,,,,)=V3(pool).slot0();uint256 ratio=Math.mulDiv(sqrt,sqrt,1<<128);
  return V3(pool).token0()==token?Math.mulDiv(amount,ratio,1<<64):Math.mulDiv(amount,1<<64,ratio);
 }
 function _price() internal view returns(uint256){return _quote(SECOND,WETH,_quote(FIRST,PONS,1e18))*1e12;}
 function _open(address borrower,uint256 loan,uint256 ltv) internal returns(uint256 pledge){
  uint256 wanted=Math.mulDiv(loan*1e12,1e18*10000,_price()*ltv)+1e18;
  // Acquire collateral from the actual DEX, rather than minting borrower tokens.
  uint256 wethNeeded=_quote(FIRST,PONS,wanted)*105/100+1;
  uint256 acquired=_swap(WETH,FIRST,wethNeeded,0);initialPrice=_price();
  pledge=Math.mulDiv(loan*1e12,1e18*10000,initialPrice*ltv)+1e18; // One token rounding buffer below maximum LTV.
  assertGe(acquired,pledge);IERC20Metadata(PONS).transfer(borrower,pledge);
  TurretVariableCreditEngine.Approval memory a=TurretVariableCreditEngine.Approval(borrower,1,pledge,loan,loan,initialPrice,
    engine.approvalNonces(borrower),uint64(block.timestamp),uint64(block.timestamp+30),engine.signerEpoch());
  bytes memory sig=_sign(engine.approvalDigest(a));vm.startPrank(borrower);
  IERC20Metadata(PONS).approve(address(engine),pledge);engine.executeApproved(a,sig);vm.stopPrank();
  assertEq(engine.positionDebt(borrower),loan);assertEq(IERC20Metadata(USDG).balanceOf(borrower),loan);
 }
 function _shock(uint256 remainingBps) internal {
  (uint160 sqrt,,,,,,)=V3(FIRST).slot0();
  uint160 limit=uint160(Math.mulDiv(sqrt,Math.sqrt(10000*1e18/remainingBps),1e9));
  // Synthetic external whale inventory; the price change itself is a real swap.
  uint256 amount=IERC20Metadata(PONS).balanceOf(FIRST)*100;
  deal(PONS,address(this),IERC20Metadata(PONS).balanceOf(address(this))+amount);
  _swap(PONS,FIRST,amount,limit);
 }
 function _certificate() internal view returns(TurretVariableCreditEngine.Price memory p,bytes memory sig){
  p=TurretVariableCreditEngine.Price(_price(),uint64(block.timestamp),uint64(block.timestamp+30),engine.signerEpoch());
  sig=_sign(engine.priceDigest(p));
 }
 function _attempt(address borrower,uint256 maximum,bool mustExecute) internal returns(bool){
  (TurretVariableCreditEngine.Price memory p,bytes memory sig)=_certificate();
  Before memory b=Before(engine.positionDebt(borrower),capital.cumulativeLoss(),
    IERC20Metadata(PONS).balanceOf(address(engine)),IERC20Metadata(USDG).balanceOf(address(capital)),
    IERC20Metadata(USDG).balanceOf(address(this)),gasleft());
  uint256 profit=Math.max(10000,maximum/100);
  try exit.liquidateAndSellApproved(borrower,maximum,1,profit,block.timestamp+30,p,sig)
    returns(uint256 paid,uint256 seized,uint256 output){
   assertGt(seized,0);assertGe(output,paid+profit);assertEq(IERC20Metadata(USDG).balanceOf(address(this)),b.keeperCash+output-paid);
   assertEq(IERC20Metadata(PONS).balanceOf(address(exit)),0);assertEq(IERC20Metadata(WETH).balanceOf(address(exit)),0);
   assertEq(IERC20Metadata(USDG).balanceOf(address(exit)),0);assertEq(IERC20Metadata(USDG).allowance(address(exit),address(engine)),0);
   assertEq(IERC20Metadata(USDG).balanceOf(address(capital)),b.cash+paid);
   emit log_named_uint("paid_USDG_6",paid);emit log_named_uint("output_USDG_6",output);
   emit log_named_uint("gross_profit_USDG_6",output-paid);emit log_named_uint("gas_used",b.startGas-gasleft());
   emit log_named_uint("recognized_loss_USDG_6",capital.cumulativeLoss()-b.loss);
   return true;
  }catch(bytes memory reason){
   assertEq(bytes4(reason),bytes4(keccak256("InsufficientReturn()")),"Unexpected liquidation failure");
   assertEq(engine.positionDebt(borrower),b.debt);assertEq(capital.cumulativeLoss(),b.loss);
   assertEq(IERC20Metadata(PONS).balanceOf(address(engine)),b.held);assertEq(IERC20Metadata(USDG).balanceOf(address(capital)),b.cash);
   assertEq(IERC20Metadata(USDG).balanceOf(address(this)),b.keeperCash);
   assertFalse(mustExecute,"Required liquidation blocked");emit log_named_uint("blocked_debt_USDG_6",b.debt);return false;
  }
 }
 function _scenario(uint256 loan,uint256 remainingBps) internal {
  _open(BORROWER,loan,3000);_shock(remainingBps);
  emit log_named_uint("loan_USDG_6",loan);emit log_named_uint("price_remaining_bps",_price()*10000/initialPrice);
  _attempt(BORROWER,loan,true);
  assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.outstandingPrincipal(),0);
 }
 function testVariableLoanInterestWithRealTokens() public {
  _configurePilot(1000e6);_open(BORROWER,800e6,2000);
  assertEq(capital.borrowAprBps(),2000);
  vm.warp(block.timestamp+365 days);assertEq(engine.positionDebt(BORROWER),960e6);
  capital.deposit(1000e6,address(this));assertEq(capital.borrowAprBps(),1500);
  vm.warp(block.timestamp+365 days);assertEq(engine.positionDebt(BORROWER),1080e6);
  IERC20Metadata(USDG).approve(address(engine),type(uint256).max);
  engine.repay(BORROWER,type(uint256).max);
  assertEq(capital.outstandingPrincipal(),0);assertEq(capital.interestReceivable(),0);
  assertEq(capital.borrowAprBps(),1000);assertEq(capital.protocolFees(),28e6);
  capital.redeem(capital.balanceOf(address(this)),address(this),address(this));
  assertLe(capital.availableCash(),1);
 }
 function testLoan1000PriceMinus45Percent() public {_scenario(1000e6,5500);assertEq(capital.cumulativeLoss(),0);}
 function testLoan5000PriceMinus45Percent() public {_scenario(5000e6,5500);assertEq(capital.cumulativeLoss(),0);}
 function testLoan25000PriceMinus45Percent() public {_scenario(25000e6,5500);assertEq(capital.cumulativeLoss(),0);}
 function testLoan5000PriceMinus70Percent() public {_scenario(5000e6,3000);}
 function testLoan5000PriceMinus85Percent() public {_scenario(5000e6,1500);assertGt(capital.cumulativeLoss(),0);}
 function testConservative20PercentLtvPriceMinus70Percent() public {
  _configureRisk(2000,3500,5000e6);
  _open(BORROWER,5000e6,2000);_shock(3000);_attempt(BORROWER,5000e6,true);
  assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testConservative20PercentLtvPriceMinus75Percent() public {
  _configureRisk(2000,3500,5000e6);
  _open(BORROWER,5000e6,2000);_shock(2500);_attempt(BORROWER,5000e6,true);
  assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testDirectRouteLiquidatesAfterMatchingMarketDrop() public {
  _configureRisk(2000,3500,5000e6);
  _open(BORROWER,5000e6,2000);_shock(3000);
  uint256 targetPrice=_price();uint256 directPrice=_quote(DIRECT,PONS,1e18)*1e12;
  (uint160 sqrt,,,,,,)=V3(DIRECT).slot0();
  uint160 limit=uint160(Math.mulDiv(sqrt,Math.sqrt(targetPrice*1e18/directPrice),1e9));
  uint256 amount=IERC20Metadata(PONS).balanceOf(DIRECT)*100;
  deal(PONS,address(this),IERC20Metadata(PONS).balanceOf(address(this))+amount);
  _swap(PONS,DIRECT,amount,limit);
  exit=_executor(true);assertTrue(exit.routeHealthy());_attempt(BORROWER,5000e6,true);
  assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testAdverseMoveAfterCertificateRevertsAtomically() public {
  uint256 pledge=_open(BORROWER,5000e6,3000);_shock(5500);
  (TurretVariableCreditEngine.Price memory p,bytes memory sig)=_certificate();
  _shock(8000); // Another trader sells after the keeper's price observation.
  uint256 cash=IERC20Metadata(USDG).balanceOf(address(capital));
  vm.expectRevert(bytes4(keccak256("InsufficientReturn()")));
  exit.liquidateAndSellApproved(BORROWER,5000e6,1,50000000,block.timestamp+30,p,sig);
  assertEq(engine.positionDebt(BORROWER),5000e6);assertEq(capital.cumulativeLoss(),0);
  assertEq(IERC20Metadata(PONS).balanceOf(address(engine)),pledge);
  assertEq(IERC20Metadata(USDG).balanceOf(address(capital)),cash);
  assertEq(IERC20Metadata(PONS).balanceOf(address(exit)),0);
 }
 function _removeIdentifiedLiquidity(uint256 fractionBps) internal returns(uint256 removedBps){
  V3 pool=V3(FIRST);uint256 before=pool.liquidity();
  PonsLpPositions.Position[] memory rows=PonsLpPositions.list();
  for(uint256 i=0;i<rows.length;i++){
   PonsLpPositions.Position memory r=rows[i];
   (uint128 amount,,,,)=pool.positions(keccak256(abi.encodePacked(r.owner,r.lower,r.upper)));
   amount=uint128(uint256(amount)*fractionBps/10000);if(amount==0)continue;
   // Only on the fork: represent LP owners withdrawing through their position
   // manager. This tests pool-level exits, not NFT permissions or lock status.
   vm.startPrank(r.owner);pool.burn(r.lower,r.upper,amount);
   pool.collect(r.owner,r.lower,r.upper,type(uint128).max,type(uint128).max);vm.stopPrank();
  }
  removedBps=(before-pool.liquidity())*10000/before;emit log_named_uint("active_liquidity_removed_bps",removedBps);
 }
 function testLoan5000WithOver80PercentLiquidityRemovedAnd45PercentDrop() public {
  _configureRisk(2000,3500,5000e6);
  _open(BORROWER,5000e6,2000);assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(5500);
  _attempt(BORROWER,5000e6,true);
  assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testLoan1000WithOver80PercentLiquidityRemovedAnd70PercentDrop() public {
  _configureRisk(2000,3500,5000e6);
  _open(BORROWER,1000e6,2000);assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(3000);
  _attempt(BORROWER,1000e6,true);assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testLateCrashClassifiesFullExitAndReferenceBoundedChunks() public {
  _configureRisk(2000,3500,5000e6);_open(BORROWER,5000e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(3000);
  uint256 anchor=_price();uint256 snapshot=vm.snapshotState();
  bool full=_attempt(BORROWER,5000e6,false);
  emit log_named_uint("late_crash_full_exit_executed",full?1:0);assertTrue(vm.revertToState(snapshot));
  uint256 count;
  while(engine.positionDebt(BORROWER)>0&&count<20){
   uint256 spot=_price();uint256 low=Math.min(spot,anchor);uint256 diff=spot>anchor?spot-anchor:anchor-spot;
   // No assumption that exchanges follow our own liquidation's DEX impact.
   if(diff*10000>low*500){emit log_named_uint("reference_disagreement_bps",diff*10000/low);break;}
   vm.warp(block.timestamp+1);
   if(!_attempt(BORROWER,Math.min(500e6,engine.positionDebt(BORROWER)),false))break;
   count++;
  }
  emit log_named_uint("late_crash_chunks_executed",count);
  emit log_named_uint("late_crash_remaining_debt_USDG_6",engine.positionDebt(BORROWER));
  emit log_named_uint("late_crash_total_recognized_loss_USDG_6",capital.cumulativeLoss());
  // Classification is not a production pass. The final report must inspect
  // remaining debt and any reference disagreement, even if this test passes.
 }
 function testEightConservativeBorrowersAfterLiquidityWithdrawal() public {
  _configureRisk(2000,3500,5000e6);
  for(uint256 i=0;i<8;i++)_open(address(uint160(0xB100+i)),625e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(5500);uint256 anchor=_price();
  for(uint256 i=0;i<8;i++){
   uint256 spot=_price();assertLe((anchor>spot?anchor-spot:spot-anchor)*10000,Math.min(anchor,spot)*500,"Reference divergence");
   vm.warp(block.timestamp+1);address borrower=address(uint160(0xB100+i));
   _attempt(borrower,engine.positionDebt(borrower),true);
  }
  assertEq(capital.outstandingPrincipal(),0);assertEq(capital.interestReceivable(),0);
  assertGe(IERC20Metadata(USDG).balanceOf(address(capital)),5000e6);assertLe(capital.cumulativeLoss(),8);
 }
 function testPilot1000After75PercentCrashAndLiquidityWithdrawal() public {
  _configurePilot(1000e6);_open(BORROWER,1000e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(2500);
  _attempt(BORROWER,1000e6,true);assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
  assertEq(capital.outstandingPrincipal(),0);assertGe(IERC20Metadata(USDG).balanceOf(address(capital)),1000e6);
 }
 function testPilot2500ClassifiesFullExitAfter75PercentCrashAndLiquidityWithdrawal() public {
  _configurePilot(2500e6);_open(BORROWER,2500e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(2500);
  bool executed=_attempt(BORROWER,2500e6,false);
  emit log_named_uint("pilot2500_full_exit_executed",executed?1:0);
  emit log_named_uint("pilot2500_remaining_debt_USDG_6",engine.positionDebt(BORROWER));
 }
 function testPilot1000EightBorrowersAfter75PercentCrashAndLiquidityWithdrawal() public {
  _configurePilot(1000e6);
  for(uint256 i=0;i<8;i++)_open(address(uint160(0xB100+i)),125e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(2500);uint256 anchor=_price();
  for(uint256 i=0;i<8;i++){
   uint256 spot=_price();assertLe((anchor>spot?anchor-spot:spot-anchor)*10000,Math.min(anchor,spot)*500,"Reference divergence");
   vm.warp(block.timestamp+1);address borrower=address(uint160(0xB100+i));
   _attempt(borrower,engine.positionDebt(borrower),true);
  }
  assertEq(capital.outstandingPrincipal(),0);assertEq(capital.interestReceivable(),0);
  assertGe(IERC20Metadata(USDG).balanceOf(address(capital)),1000e6);assertLe(capital.cumulativeLoss(),8);
 }
 function testPilotMinimumLoanAfter75PercentCrashAndLiquidityWithdrawal() public {
  _configurePilot(1000e6);_open(BORROWER,50e6,2000);
  assertGe(_removeIdentifiedLiquidity(9500),8000);_shock(2500);
  _attempt(BORROWER,50e6,true);assertEq(engine.positionDebt(BORROWER),0);assertEq(capital.cumulativeLoss(),0);
 }
 function testBorrowRepayDuringSignerOutage() public {
  uint256 pledge=_open(BORROWER,5000e6,3000);vm.warp(block.timestamp+30 days);engine.setRiskPaused(true);engine.setRiskSigner(address(123));
  uint256 due=engine.positionDebt(BORROWER);IERC20Metadata(USDG).transfer(BORROWER,due-5000e6);
  vm.startPrank(BORROWER);IERC20Metadata(USDG).approve(address(engine),due);engine.close(due,BORROWER);vm.stopPrank();
  assertEq(engine.positionDebt(BORROWER),0);assertEq(IERC20Metadata(PONS).balanceOf(BORROWER),pledge);
  assertEq(capital.outstandingPrincipal(),0);assertEq(capital.cumulativeLoss(),0);
  assertGe(capital.redeem(capital.balanceOf(address(this)),address(this),address(this)),100000e6);
 }
 function testEightBorrowersShareExit() public {
  for(uint256 i=0;i<8;i++)_open(address(uint160(0xB100+i)),625e6,3000);
  _shock(5500);
  for(uint256 i=0;i<8;i++){
   // A fresh market-bound test certificate follows each executed sale.
   vm.warp(block.timestamp+1);_attempt(address(uint160(0xB100+i)),engine.positionDebt(address(uint160(0xB100+i))),true);
  }
  assertEq(capital.outstandingPrincipal(),0);assertEq(capital.interestReceivable(),0);
  assertGe(IERC20Metadata(USDG).balanceOf(address(capital)),100000e6);
  // Aggregate-vs-individual interest floors clear at most one micro-USDG per
  // borrower here. This is receivable rounding, not lost principal.
  assertLe(capital.cumulativeLoss(),8);
 }
 function testStaleLiquidationPriceRollsBack() public {
  _open(BORROWER,1000e6,3000);_shock(5500);(TurretVariableCreditEngine.Price memory p,bytes memory sig)=_certificate();
  vm.warp(block.timestamp+30);uint256 due=engine.positionDebt(BORROWER);vm.expectRevert(TurretVariableCreditEngine.InvalidApproval.selector);
  exit.liquidateAndSellApproved(BORROWER,1000e6,1,10000,block.timestamp+30,p,sig);
  assertEq(engine.positionDebt(BORROWER),due);assertEq(capital.cumulativeLoss(),0);
 }
 function _swap(address input,address venue,uint256 amount,uint160 limit) internal returns(uint256 output){
  require(callbackPool==address(0));V3 p=V3(venue);bool zero=p.token0()==input;require(zero||p.token1()==input);
  address out=zero?p.token1():p.token0();uint256 before=IERC20Metadata(out).balanceOf(address(this));
  callbackPool=venue;callbackToken=input;callbackBudget=amount;
  p.swap(address(this),zero,int256(amount),limit!=0?limit:zero?uint160(4295128740):uint160(1461446703485210103287273052203988822378723970341),"");
  if(limit==0)require(callbackBudget==0,"Partial input fill");
  callbackPool=address(0);callbackToken=address(0);callbackBudget=0;output=IERC20Metadata(out).balanceOf(address(this))-before;
  require(output>0);
 }
 function uniswapV3SwapCallback(int256 d0,int256 d1,bytes calldata) external {
  require(msg.sender==callbackPool&&callbackPool!=address(0));bool zero=d0>0;require(zero?d1<=0:d1>0);
  address input=zero?V3(msg.sender).token0():V3(msg.sender).token1();uint256 owed=uint256(zero?d0:d1);
  require(input==callbackToken&&owed<=callbackBudget);callbackBudget-=owed;require(IERC20Metadata(input).transfer(msg.sender,owed));
 }
}
