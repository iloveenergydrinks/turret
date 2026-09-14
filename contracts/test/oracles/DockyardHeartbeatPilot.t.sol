// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardMockERC20, DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";
import {ScaledStockFixture} from "test/oracles/DockyardOracleV2.t.sol";
import {DockyardUSDGCreditVaultV2} from "src/DockyardUSDGCreditVaultV2.sol";
import {DockyardUSDGCreditVaultPilot} from "src/DockyardUSDGCreditVaultPilot.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";

contract DockyardHeartbeatPilotTest is Test {
    uint256 constant KEY = 78123;
    DockyardMockERC20 usdg;
    ScaledStockFixture stock;
    DockyardMockOracle primary;
    DockyardHeartbeatGuard guard;
    DockyardUSDGCreditVaultPilot vault;
    address borrower = makeAddr("pilot borrower");
    address liquidator = makeAddr("pilot keeper");

    function setUp() public {
        vm.chainId(4663);
        vm.warp(1_000_000);
        usdg = new DockyardMockERC20("USDG", "USDG", 6);
        stock = new ScaledStockFixture();
        primary = new DockyardMockOracle(8, 100e8);
        guard = new DockyardHeartbeatGuard(address(stock), address(primary), vm.addr(KEY), 86400);
        vault = new DockyardUSDGCreditVaultPilot(address(usdg), address(this));
        vault.addMarket(address(stock), address(primary), address(guard), 50e6, 3000, 4000, 500, 200);
        vault.setBorrowerAllowed(borrower, true);
        vm.warp(block.timestamp + 120);
        primary.setAnswer(100e8);
        guard.submitHealth(_proof());
        vault.setMarketEnabled(address(stock), true);
        vault.unpause();
        usdg.mint(address(this), 1000e6);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(1000e6);
        stock.mint(borrower, 100e18);
        vm.prank(borrower);stock.approve(address(vault), type(uint256).max);
        usdg.mint(liquidator, 100e6);
        vm.prank(liquidator);usdg.approve(address(vault), type(uint256).max);
    }
    function _health() internal view returns (DockyardHeartbeatGuard.Health memory) {
        return DockyardHeartbeatGuard.Health(primary.roundId(), uint64(block.timestamp), uint64(block.timestamp+45), uint64(block.timestamp-300), uint64(block.timestamp+3600), keccak256(abi.encode(primary.roundId(), uint256(primary.answer())*1e10, primary.updatedAt())), guard.epoch());
    }
    function _sign(DockyardHeartbeatGuard.Health memory h, address adapter, uint256 chain, uint256 key) internal pure returns(bytes memory) {
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256("DockyardChainlinkGuard"),keccak256("1"),chain,adapter));
        bytes32 hash=keccak256(abi.encode(keccak256("Health(uint80 roundId,uint64 observedAt,uint64 validUntil,uint64 sessionOpen,uint64 sessionClose,bytes32 roundHash,uint64 epoch)"),h.roundId,h.observedAt,h.validUntil,h.sessionOpen,h.sessionClose,h.roundHash,h.epoch));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,ECDSA.toTypedDataHash(domain,hash));
        return abi.encode(h,abi.encodePacked(r,s,v));
    }
    function _proof() internal view returns(bytes memory){return _sign(_health(),address(guard),block.chainid,KEY);}
    function _open() internal {bytes memory proof=_proof();vm.prank(borrower);vault.depositAndBorrowChecked(address(stock),1e18,20e6,proof);}

    function testAtomicBorrowUsesFreshCheckAndFeeIncluded() public {
        _open();(uint128 collateral,uint128 debt)=vault.positions(address(stock),borrower);
        assertEq(collateral,1e18);assertEq(debt,20_100_000);assertEq(vault.totalDebt(),debt);
    }
    function testUnapprovedBorrowerCannotBypassThroughLegacyBorrowFunction() public {
        vault.setBorrowerAllowed(borrower,false);
        vm.prank(borrower);vm.expectRevert(DockyardUSDGCreditVaultPilot.BorrowerNotAllowed.selector);
        vault.depositAndBorrow(address(stock),1e18,20e6);
    }
    function testMonitorDeathExpiresBorrowingButRepaymentAndTopupsWork() public {
        _open();vm.warp(block.timestamp+45);
        vm.prank(borrower);vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector);vault.borrow(address(stock),1e6);
        vault.pause();vault.setMarketEnabled(address(stock),false);primary.setShouldRevert(true);
        vm.prank(borrower);vault.depositCollateral(address(stock),1e18);
        vm.prank(borrower);usdg.approve(address(vault),type(uint256).max);
        vm.prank(borrower);vault.repay(address(stock),borrower,1e6);
        (uint128 collateral,uint128 debt)=vault.positions(address(stock),borrower);
        assertEq(collateral,2e18);assertEq(debt,19_100_000);
    }
    function testExpiredApprovalDoesNotBlockFreshChainlinkLiquidation() public {
        _open();vm.warp(block.timestamp+46);primary.setAnswer(40e8);
        vm.prank(liquidator);(uint256 repaid,)=vault.liquidate(address(stock),borrower,100e6,liquidator);
        assertEq(repaid,20_100_000);
    }
    function testDebtWithdrawalNeedsFreshApprovalWhileDebtFreeExitDoesNot() public {
        _open();vm.warp(block.timestamp+45);
        vm.prank(borrower);vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector);
        vault.withdrawCollateral(address(stock),0.1e18,borrower);
        bytes memory proof=_proof();vm.prank(borrower);
        vault.withdrawCollateralChecked(address(stock),0.1e18,borrower,proof);
        usdg.mint(borrower,1e6);vm.prank(borrower);usdg.approve(address(vault),type(uint256).max);
        vault.pause();primary.setShouldRevert(true);
        vm.prank(borrower);vault.repayAllAndWithdrawCollateral(address(stock),borrower);
        (uint128 collateral,uint128 debt)=vault.positions(address(stock),borrower);
        assertEq(collateral,0);assertEq(debt,0);
    }
    function testConfirmedDisagreementQuarantinesLiquidationsAndRecovers() public {
        _open();primary.setAnswer(40e8);
        vm.prank(vm.addr(KEY));guard.trip(true);
        vm.prank(liquidator);vm.expectRevert(DockyardHeartbeatGuard.PriceQuarantined.selector);vault.liquidate(address(stock),borrower,100e6,liquidator);
        vm.warp(block.timestamp+120);primary.setAnswer(40e8);guard.submitHealth(_proof());
        vm.prank(liquidator);vault.liquidate(address(stock),borrower,100e6,liquidator);
    }
    function testHealthCannotBeReplayedAfterIncident() public {
        bytes memory proof=_proof();vm.prank(vm.addr(KEY));guard.trip(false);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
    }
    function testRecoveryDelayCannotBeSkippedWithNewEpoch() public {
        vm.prank(vm.addr(KEY));guard.trip(false);bytes memory proof=_proof();
        vm.expectRevert(DockyardHeartbeatGuard.RecoveryPending.selector);guard.submitHealth(proof);
    }
    function testNewRoundInvalidatesPreviouslyApprovedBorrowingPrice() public {
        primary.setAnswer(110e8);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.validatedPrice(true);
    }
    function testSameRoundPriceMutationCannotReuseHealthyApproval() public {
        vm.store(address(primary),bytes32(uint256(0)),bytes32(uint256(200e8)));
        assertEq(primary.answer(),200e8);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.validatedPrice(true);
    }
    function testInvalidSignerRejected() public {
        bytes memory proof=_sign(_health(),address(guard),4663,KEY+1);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
    }
    function testCrossAdapterAndChainReplayRejected() public {
        bytes memory proof=_sign(_health(),address(0x123),4663,KEY);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
        proof=_sign(_health(),address(guard),1,KEY);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
    }
    function testFutureAndExcessiveLifetimeRejected() public {
        DockyardHeartbeatGuard.Health memory h=_health();h.observedAt++;bytes memory proof=_sign(h,address(guard),4663,KEY);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
        h=_health();h.validUntil=h.observedAt+61;proof=_sign(h,address(guard),4663,KEY);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidHealth.selector);guard.submitHealth(proof);
    }
    function testSessionCloseExpiresApproval() public {
        DockyardHeartbeatGuard.Health memory h=_health();h.sessionClose=uint64(block.timestamp+10);h.validUntil=h.sessionClose;
        guard.submitHealth(_sign(h,address(guard),4663,KEY));vm.warp(block.timestamp+10);
        vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector);guard.validatedPrice(true);
    }
    function testStalePrimaryNeverFallsBackToMonitor() public {
        primary.setUpdatedAt(block.timestamp-86400);bytes memory proof=_proof();
        vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);guard.submitHealth(proof);
        vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);guard.validatedPrice(false);
    }
    function testCorporateActionRequiresNewPrimaryRound() public {
        stock.setMultiplier(2e18,block.timestamp);primary.setUpdatedAt(block.timestamp-1);
        vm.expectRevert(DockyardHeartbeatGuard.CorporateActionPending.selector);guard.validatedPrice(false);
    }
    function testDoesNotDoubleScaleCanonicalChainlinkPrice() public {
        stock.setMultiplier(2e18,block.timestamp);primary.setAnswer(200e8);
        (uint256 value,)=guard.validatedPrice(false);assertEq(value,200e18);
    }
    function testOnlyGuardianCanQuarantine() public {
        vm.expectRevert(DockyardHeartbeatGuard.UnauthorizedGuardian.selector);guard.trip(true);
    }
    function testMarketLimitIncludesOriginationFeeAndCannotIncrease() public {
        bytes memory proof=_proof();vm.prank(borrower);vm.expectRevert(DockyardUSDGCreditVaultV2.DebtCeilingExceeded.selector);
        vault.depositAndBorrowChecked(address(stock),10e18,50e6,proof);
        vm.expectRevert(DockyardUSDGCreditVaultV2.InvalidRiskParameters.selector);vault.setDebtCeiling(address(stock),50e6+1);
    }
    function testGlobalCapAcrossMarkets() public {
        for(uint256 i;i<6;i++){
            ScaledStockFixture s=new ScaledStockFixture();
            DockyardHeartbeatGuard g=new DockyardHeartbeatGuard(address(s),address(primary),vm.addr(KEY),86400);
            vault.addMarket(address(s),address(primary),address(g),50e6,3000,4000,500,200);
            vm.warp(block.timestamp+120);primary.setAnswer(100e8);
            DockyardHeartbeatGuard.Health memory h=_health();h.epoch=0;
            bytes memory proof=_sign(h,address(g),4663,KEY);g.submitHealth(proof);
            vault.setMarketEnabled(address(s),true);s.mint(borrower,10e18);
            vm.prank(borrower);s.approve(address(vault),type(uint256).max);
            vm.prank(borrower);
            if(i==5)vm.expectRevert(DockyardUSDGCreditVaultV2.DebtCeilingExceeded.selector);
            vault.depositAndBorrowChecked(address(s),10e18,49e6,proof);
        }
        assertEq(vault.totalDebt(),246_225_000);
    }
    function testFuzzExpiryCannotBeExtendedByReplaying(uint64 delay) public {
        delay=uint64(bound(delay,45,290));bytes memory proof=_proof();vm.warp(block.timestamp+delay);
        vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector);guard.submitHealth(proof);
    }
    function testHealthyUnchangedPriceDoesNotExpireAfterFiveMinutes() public {
        _open();vm.warp(block.timestamp+3600);
        guard.submitHealth(_proof());
        vm.prank(borrower);vault.borrow(address(stock),1e6);
        assertEq(vault.totalDebt(),21_105_000);
    }
    function testWithinHeartbeatLiquidationDoesNotNeedBorrowApproval() public {
        _open();primary.setAnswer(40e8);vm.warp(block.timestamp+3600);
        vm.prank(liquidator);(uint256 repaid,)=vault.liquidate(address(stock),borrower,100e6,liquidator);
        assertEq(repaid,20_100_000);
    }
    function testHeartbeatBoundaryAndFutureRoundRejected() public {
        primary.setUpdatedAt(block.timestamp-86399);guard.validatedPrice(false);
        vm.warp(block.timestamp+1);vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);guard.validatedPrice(false);
        primary.setUpdatedAt(block.timestamp+1);vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);guard.validatedPrice(false);
    }
    function testUnsupportedHeartbeatCannotDeploy() public {
        vm.expectRevert(DockyardHeartbeatGuard.InvalidConfiguration.selector);
        new DockyardHeartbeatGuard(address(stock),address(primary),vm.addr(KEY),86401);
        vm.expectRevert(DockyardHeartbeatGuard.InvalidConfiguration.selector);
        new DockyardHeartbeatGuard(address(stock),address(primary),vm.addr(KEY),0);
    }
}
