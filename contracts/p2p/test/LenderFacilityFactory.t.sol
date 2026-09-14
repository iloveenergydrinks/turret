// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TurretLenderFacility as Facility} from "../src/TurretLenderFacility.sol";
import {TurretLenderFacilityFactory as Factory} from "../src/TurretLenderFacilityFactory.sol";
import {V3TestToken} from "./V3TestSupport.sol";

contract LenderFacilityFactoryTest is Test {
    Factory factory;
    V3TestToken cash;
    V3TestToken collateral;
    address lender;
    uint256 constant KEY = 0xA11CE;
    function setUp() public {
        vm.warp(1_800_000_000); vm.roll(100);
        lender = vm.addr(KEY);
        cash = new V3TestToken("USDG", 6); collateral = new V3TestToken("PONS", 18);
        address[] memory tokens = new address[](1); tokens[0] = address(collateral);
        factory = new Factory(cash, tokens);
    }
    function limits() internal pure returns (Facility.Limits memory) {
        return Facility.Limits(500e6,10e6,100e6,14 days,14 days,1 days,4e30,600);
    }
    function create(address owner) internal returns (Facility f) {
        vm.prank(owner); f = Facility(factory.createFacility(address(collateral), limits()));
    }
    function testFactoryBindsCallerAndNoProtocolFee() public {
        Facility f = create(lender);
        assertEq(f.lender(),lender); assertEq(f.feeRecipient(),lender); assertEq(f.feeBps(),0);
        assertEq(address(f.loanToken()),address(cash)); assertEq(address(f.collateralToken()),address(collateral));
        assertEq(factory.getFacility(lender,address(collateral)),address(f));
        assertEq(factory.createdAtBlock(address(f)),100); assertEq(factory.facilityCount(),1);
        assertEq(factory.facilities(0),address(f));
        assertEq(cash.balanceOf(address(factory)),0); assertEq(f.idleCash(),0);
        vm.prank(address(123)); vm.expectRevert(Facility.Unauthorized.selector); f.setNewLoansPaused(true);
    }
    function testDuplicateCannotReplaceOriginalOrAffectOtherLender() public {
        Facility first=create(lender);
        vm.prank(lender); vm.expectRevert(Factory.AlreadyCreated.selector); factory.createFacility(address(collateral),limits());
        Facility second=create(address(123)); assertTrue(address(first)!=address(second));
        assertEq(factory.getFacility(lender,address(collateral)),address(first)); assertEq(factory.facilityCount(),2);
    }
    function testUnknownCollateralAndInvalidLimitsDoNotRegister() public {
        vm.expectRevert(Factory.InvalidCollateral.selector); factory.createFacility(address(cash),limits());
        Facility.Limits memory bad=limits(); bad.maxExposure=0;
        vm.prank(lender); vm.expectRevert(Facility.InvalidConfiguration.selector); factory.createFacility(address(collateral),bad);
        assertEq(factory.getFacility(lender,address(collateral)),address(0)); assertEq(factory.facilityCount(),0);
        create(lender);
    }
    function testTwoBorrowersConsumeOneBudgetAndLenderCanWithdrawOnlyIdle() public {
        Facility f=create(lender); cash.mint(lender,100e6);
        vm.startPrank(lender); cash.approve(address(f),100e6); f.deposit(100e6); vm.stopPrank();
        Facility.Quote memory q=Facility.Quote(1,1,address(0),100e6,10e6,400e18,6e6,14 days,block.timestamp,block.timestamp+1 hours);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,f.quoteHash(q)); bytes memory sig=abi.encodePacked(r,s,v);
        for(uint256 i=1;i<=2;++i){address borrower=address(uint160(i));collateral.mint(borrower,200e18);vm.startPrank(borrower);collateral.approve(address(f),200e18);f.draw(q,sig,50e6,200e18,3e6,50e6);vm.stopPrank();assertEq(cash.balanceOf(borrower),50e6);}
        assertEq(f.idleCash(),0); assertEq(f.activePrincipal(),100e6);
        vm.prank(lender); vm.expectRevert(Facility.InvalidWithdrawal.selector); f.withdrawIdle(1,lender);
        cash.mint(address(1),3e6);vm.startPrank(address(1));cash.approve(address(f),53e6);f.repay(1);vm.stopPrank();
        assertEq(f.idleCash(),0);f.recycleRepayment(1);assertEq(f.idleCash(),53e6);
        vm.prank(lender);f.withdrawIdle(53e6,lender);assertEq(cash.balanceOf(lender),53e6);
        (,uint256 filled,)=f.quoteUses(1,1);assertEq(filled,100e6);
        vm.prank(address(1));vm.expectRevert(Facility.QuoteUnavailable.selector);f.draw(q,sig,10e6,40e18,600000,10e6);
    }
}
