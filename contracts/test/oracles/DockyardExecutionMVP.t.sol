// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardExecutionGate} from "src/Oracles/DockyardExecutionGate.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";
import {DockyardUSDGCreditVaultMVP} from "src/DockyardUSDGCreditVaultMVP.sol";
import {DockyardMockERC20,DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";
import {ScaledStockFixture} from "test/oracles/DockyardOracleV2.t.sol";

contract DockyardExecutionMVPTest is Test {
    uint256 constant KEY=1234567;
    DockyardExecutionGate gate;
    DockyardHeartbeatGuard guard;
    DockyardUSDGCreditVaultMVP vault;
    DockyardMockERC20 usdg;
    DockyardMockOracle primary;
    ScaledStockFixture stock;
    address borrower=makeAddr("borrower");
    address liquidator=makeAddr("unrelated liquidator");
    uint256 healthySince;
    function setUp() public {
        vm.chainId(4663);vm.warp(1_000_000);healthySince=block.timestamp;
        usdg=new DockyardMockERC20("USDG","USDG",6);stock=new ScaledStockFixture();primary=new DockyardMockOracle(8,100e8);
        gate=new DockyardExecutionGate(vm.addr(KEY));guard=new DockyardHeartbeatGuard(address(stock),address(primary),vm.addr(KEY),86400);
        vault=new DockyardUSDGCreditVaultMVP(address(usdg),address(this),address(gate));
        vault.addMarket(address(stock),address(primary),address(guard),50e6,3000,4000,500,200);
        vault.setBorrowerAllowed(borrower,true);vm.warp(block.timestamp+120);primary.setAnswer(100e8);
        guard.submitHealth(_health());vault.setMarketEnabled(address(stock),true);vault.unpause();
        usdg.mint(address(this),250e6);usdg.approve(address(vault),250e6);vault.fund(250e6);
        stock.mint(borrower,100e18);vm.prank(borrower);stock.approve(address(vault),type(uint256).max);
        usdg.mint(liquidator,250e6);vm.prank(liquidator);usdg.approve(address(vault),type(uint256).max);
    }
    function _sign(bytes32 hash,string memory name,address target,uint256 chain,uint256 key) internal pure returns(bytes memory){
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256(bytes(name)),keccak256("1"),chain,target));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,ECDSA.toTypedDataHash(domain,hash));return abi.encodePacked(r,s,v);
    }
    function _health() internal view returns(bytes memory){
        (uint256 value,uint256 time,uint80 round)=guard.currentData();
        DockyardHeartbeatGuard.Health memory h=DockyardHeartbeatGuard.Health(round,uint64(block.timestamp),uint64(block.timestamp+45),uint64(block.timestamp-300),uint64(block.timestamp+3600),keccak256(abi.encode(round,value,time)),guard.epoch());
        bytes32 hash=keccak256(abi.encode(guard.HEALTH_TYPEHASH(),h.roundId,h.observedAt,h.validUntil,h.sessionOpen,h.sessionClose,h.roundHash,h.epoch));
        return abi.encode(h,_sign(hash,"DockyardChainlinkGuard",address(guard),4663,KEY));
    }
    function _permit(DockyardExecutionGate.Liveness memory p,address target,uint256 chain,uint256 key) internal view returns(bytes memory){
        bytes32 hash=keccak256(abi.encode(gate.LIVENESS_TYPEHASH(),p.observedAt,p.healthySince,p.validUntil,p.epoch));
        return abi.encode(p,_sign(hash,"DockyardExecutionGate",target,chain,key));
    }
    function _live() internal view returns(bytes memory){
        return _permit(DockyardExecutionGate.Liveness(uint64(block.timestamp),uint64(healthySince),uint64(block.timestamp+45),gate.epoch()),address(gate),4663,KEY);
    }
    function _open() internal {bytes memory p=abi.encode(_health(),_live());vm.prank(borrower);vault.depositAndBorrowChecked(address(stock),1e18,20e6,p);}
    function testAtomicBorrowPublishesBothChecks() public {_open();assertEq(vault.totalDebt(),20_100_000);gate.requireLive();}
    function testLegacyBorrowCannotBypassLiveness() public {
        vm.prank(borrower);vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);vault.depositAndBorrow(address(stock),1e18,20e6);
        assertEq(vault.totalDebt(),0);assertEq(stock.balanceOf(borrower),100e18);
    }
    function testFirstResumedBlockCannotLiquidateWithoutRecovery() public {
        _open();vm.warp(block.timestamp+2 hours);vm.roll(block.number+1);primary.setAnswer(40e8);healthySince=block.timestamp;
        vm.prank(liquidator);vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);vault.liquidate(address(stock),borrower,50e6,liquidator);
        bytes memory p=_live();vm.prank(liquidator);vm.expectRevert(DockyardExecutionGate.RecoveryPending.selector);vault.liquidateChecked(address(stock),borrower,50e6,liquidator,p);
        vm.warp(block.timestamp+120);p=_live();vault.pause();vault.setMarketEnabled(address(stock),false);
        vm.prank(liquidator);(uint256 repaid,)=vault.liquidateChecked(address(stock),borrower,50e6,liquidator,p);
        assertEq(repaid,20_100_000);assertEq(vault.totalDebt(),0);
    }
    function testMonitorOutageBlocksLiquidationEvenWithFreshPrice() public {
        _open();vm.warp(block.timestamp+45);primary.setAnswer(40e8);
        vm.prank(liquidator);vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);vault.liquidate(address(stock),borrower,50e6,liquidator);
    }
    function testRepaymentAndTopupRemainAvailableDuringOutage() public {
        _open();vm.warp(block.timestamp+3600);vault.pause();primary.setShouldRevert(true);
        vm.prank(borrower);vault.depositCollateral(address(stock),1e18);
        usdg.mint(borrower,1e6);vm.prank(borrower);usdg.approve(address(vault),type(uint256).max);
        vm.prank(borrower);vault.repayAllAndWithdrawCollateral(address(stock),borrower);
        assertEq(vault.totalDebt(),0);(uint128 collateral,)=vault.positions(address(stock),borrower);assertEq(collateral,0);
    }
    function testDebtBearingWithdrawalCannotBypassLiveness() public {
        _open();vm.warp(block.timestamp+45);guard.submitHealth(_health());
        vm.prank(borrower);vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);vault.withdrawCollateral(address(stock),1,borrower);
    }
    function testTripRevokesCachedAndSignedPermits() public {
        bytes memory old=_live();gate.submitLiveness(old);vm.prank(vm.addr(KEY));gate.trip();
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);gate.requireLive();
        vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(old);
        bytes memory early=_live();vm.expectRevert(DockyardExecutionGate.RecoveryPending.selector);gate.submitLiveness(early);
        healthySince=block.timestamp;vm.warp(block.timestamp+120);gate.submitLiveness(_live());gate.requireLive();
    }
    function testUnauthorizedTripAndSignaturesCannotGrantAccess() public {
        vm.expectRevert(DockyardExecutionGate.UnauthorizedGuardian.selector);gate.trip();
        DockyardExecutionGate.Liveness memory p=DockyardExecutionGate.Liveness(uint64(block.timestamp),uint64(healthySince),uint64(block.timestamp+45),0);
        bytes memory wrong=_permit(p,address(gate),1,KEY);vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(wrong);
        wrong=_permit(p,address(0x123),4663,KEY);vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(wrong);
        wrong=_permit(p,address(gate),4663,KEY+1);vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(wrong);
    }
    function testReplayCannotExtendExpiry() public {
        bytes memory p=_live();gate.submitLiveness(p);vm.warp(block.timestamp+44);gate.submitLiveness(p);vm.warp(block.timestamp+1);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);gate.requireLive();
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);gate.submitLiveness(p);
    }
    function testUnapprovedBorrowerAndCapChangesRejected() public {
        vault.setBorrowerAllowed(borrower,false);bytes memory p=abi.encode(_health(),_live());
        vm.prank(borrower);vm.expectRevert(DockyardUSDGCreditVaultMVP.BorrowerNotAllowed.selector);vault.depositAndBorrowChecked(address(stock),1e18,20e6,p);
        vm.expectRevert(DockyardUSDGCreditVaultMVP.InvalidMarket.selector);vault.setDebtCeiling(address(stock),50e6+1);
    }
    function testMalformedTimeWindowsRejected() public {
        DockyardExecutionGate.Liveness memory p=DockyardExecutionGate.Liveness(uint64(block.timestamp),uint64(healthySince),uint64(block.timestamp+46),0);
        bytes memory b=_permit(p,address(gate),4663,KEY);vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(b);
        p.observedAt=uint64(block.timestamp+1);p.validUntil=p.observedAt+45;b=_permit(p,address(gate),4663,KEY);
        vm.expectRevert(DockyardExecutionGate.InvalidLiveness.selector);gate.submitLiveness(b);
        p.observedAt=uint64(block.timestamp);p.healthySince=p.observedAt-119;p.validUntil=p.observedAt+45;b=_permit(p,address(gate),4663,KEY);
        vm.expectRevert(DockyardExecutionGate.RecoveryPending.selector);gate.submitLiveness(b);
    }
    function testFuzz_PermitCannotSurviveExpiry(uint16 elapsed) public {
        elapsed=uint16(bound(elapsed,45,60000));bytes memory p=_live();gate.submitLiveness(p);vm.warp(block.timestamp+elapsed);
        vm.expectRevert(DockyardExecutionGate.LivenessExpired.selector);gate.requireLive();
    }
}
