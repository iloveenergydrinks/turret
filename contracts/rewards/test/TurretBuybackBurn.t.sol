// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretBuybackBurn,IBurnableTurret,IBuybackKyber} from "../src/TurretBuybackBurn.sol";
contract BuybackToken is ERC20 {
 bool public failBurn; bool public fakeBurn;
 constructor(string memory n) ERC20(n,n) {}
 function mint(address who,uint256 value) external {_mint(who,value);}
 function burn(uint256 value) external {require(!failBurn);if(!fakeBurn)_burn(msg.sender,value);}
 function setBurn(bool fail,bool fake) external {failBurn=fail;fakeBurn=fake;}
}
contract BuybackSwap is IBuybackKyber {
 BuybackToken public stable; BuybackToken public token; uint256 public output=3000e18; bool public fail;
 constructor(BuybackToken a,BuybackToken b){stable=a;token=b;}
 function setOutput(uint256 x) external {output=x;}
 function swap(Execution calldata e) external payable returns(uint256,uint256){require(!fail);stable.transferFrom(msg.sender,address(this),e.desc.amount);token.transfer(e.desc.dstReceiver,output);return(output,0);}
}
contract BuybackTarget {}
contract TurretBuybackBurnTest is Test {
 BuybackToken stable;BuybackToken token;BuybackSwap router;BuybackTarget target;TurretBuybackBurn module;
 address wallet=address(0xD3);address keeper=address(0xB0);
 function setUp() public {vm.chainId(4663);vm.warp(10000);stable=new BuybackToken('USDG');token=new BuybackToken('TURRET');router=new BuybackSwap(stable,token);target=new BuybackTarget();module=new TurretBuybackBurn(stable,IBurnableTurret(address(token)),wallet,address(router),address(target));stable.mint(wallet,1100e6);token.mint(address(router),1e30);vm.startPrank(wallet);stable.approve(address(module),type(uint256).max);module.configure(keeper,100e18);module.setPaused(false);vm.stopPrank();vm.warp(block.timestamp+1 hours);}
 function execution(uint256 amount) internal view returns(IBuybackKyber.Execution memory e){e.callTarget=address(target);e.targetData=hex'12345678';e.desc.srcToken=address(stable);e.desc.dstToken=address(token);e.desc.dstReceiver=address(module);e.desc.amount=amount;e.desc.minReturnAmount=(amount*100e18+1e6-1)/1e6;e.desc.flags=512;e.desc.srcReceivers=new address[](1);e.desc.srcReceivers[0]=address(target);e.desc.srcAmounts=new uint256[](1);e.desc.srcAmounts[0]=amount;}
 function run(uint256 amount) internal {vm.prank(keeper);module.execute(execution(amount),block.timestamp+60);}
 function testAtomicPurchaseAndActualSupplyBurn() public {uint256 supply=token.totalSupply();run(1e6);assertEq(stable.balanceOf(wallet),1099e6);assertEq(token.totalSupply(),supply-3000e18);assertEq(token.balanceOf(address(module)),0);assertEq(stable.allowance(address(module),address(router)),0);assertEq(module.totalSpent(),1e6);assertEq(module.totalBurned(),3000e18);}
 function testBurnFailureRollsBackEntireSwap() public {token.setBurn(true,false);vm.expectRevert();run(1e6);assertEq(stable.balanceOf(wallet),1100e6);assertEq(module.totalSpent(),0);assertEq(stable.balanceOf(address(router)),0);}
 function testFakeBurnIsRejectedAndRolledBack() public {token.setBurn(false,true);vm.expectRevert(TurretBuybackBurn.InvalidSettlement.selector);run(1e6);assertEq(stable.balanceOf(wallet),1100e6);}
 function testOnePurchasePerHourAndNoCatchup() public {run(1e6);assertEq(module.availableBudget(),0);vm.warp(block.timestamp+30 days);assertEq(module.availableBudget(),uint256(999e6)*67000000000000000/1e18);}
 function testPausedOrRevokedCannotSpend() public {vm.prank(wallet);module.setPaused(true);assertEq(module.availableBudget(),0);vm.prank(wallet);module.setPaused(false);vm.prank(wallet);stable.approve(address(module),0);assertEq(module.availableBudget(),0);}
 function testCannotExceedHourlyBudget() public {uint256 amount=module.availableBudget()+1;vm.expectRevert(TurretBuybackBurn.Unavailable.selector);run(amount);}
 function testWrongCallerAndDestinationRejected() public {IBuybackKyber.Execution memory e=execution(1e6);vm.expectRevert(TurretBuybackBurn.Unauthorized.selector);module.execute(e,block.timestamp+60);e.desc.dstReceiver=keeper;vm.prank(keeper);vm.expectRevert(TurretBuybackBurn.InvalidSwap.selector);module.execute(e,block.timestamp+60);}
 function testQuoteBelowOwnerPriceFloorRejected() public {IBuybackKyber.Execution memory e=execution(1e6);e.desc.minReturnAmount=1;vm.prank(keeper);vm.expectRevert(TurretBuybackBurn.InvalidSwap.selector);module.execute(e,block.timestamp+60);}
 function testPoorSettlementRollsBack() public {router.setOutput(1);vm.expectRevert(TurretBuybackBurn.InvalidSettlement.selector);run(1e6);assertEq(stable.balanceOf(wallet),1100e6);}
 function testStaleOrOverlongDeadlineRejected() public {IBuybackKyber.Execution memory e=execution(1e6);vm.prank(keeper);vm.expectRevert(TurretBuybackBurn.Unavailable.selector);module.execute(e,block.timestamp-1);vm.prank(keeper);vm.expectRevert(TurretBuybackBurn.Unavailable.selector);module.execute(e,block.timestamp+121);}
 function testRuntimeChangeBlocksExecution() public {vm.etch(address(target),hex'00');vm.expectRevert(TurretBuybackBurn.Unavailable.selector);run(1e6);}
 function testReconfigurePausesWithoutResettingHourlyWindow() public {run(1e6);vm.prank(wallet);module.configure(keeper,50e18);assertTrue(module.paused());vm.prank(wallet);module.setPaused(false);assertEq(module.availableBudget(),0);}
 function testFuzzReserveAndRate(uint256 balance) public {balance=bound(balance,0,1e15);uint256 old=stable.balanceOf(wallet);vm.prank(wallet);stable.transfer(address(this),old);stable.mint(wallet,balance);uint256 expected=balance>100e6?(balance-100e6)*67000000000000000/1e18:0;assertEq(module.availableBudget(),expected);if(expected>0){router.setOutput(expected*100e18/1e6+1);run(expected);assertGe(stable.balanceOf(wallet),100e6);}}
 function testExactSixPointSevenPercentEachHour() public {assertEq(module.availableBudget(),67e6);router.setOutput(6700e18);run(67e6);assertEq(stable.balanceOf(wallet),1033e6);vm.warp(block.timestamp+1 hours);assertEq(module.availableBudget(),62511e3);}
 function testTwentyFourHourlyPurchases() public {for(uint256 i;i<24;++i){uint256 amount=module.availableBudget();router.setOutput(amount*100e18/1e6+1);run(amount);vm.warp(block.timestamp+1 hours);}assertApproxEqAbs(stable.balanceOf(wallet),289303851,24);}
}
