// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardUSDGCreditVaultPilot} from "src/DockyardUSDGCreditVaultPilot.sol";
import {DockyardUSDGCreditVaultV2} from "src/DockyardUSDGCreditVaultV2.sol";
import {DockyardHeartbeatGuard} from "src/Oracles/DockyardHeartbeatGuard.sol";

interface StressFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

/// Fork only. The deployed vault bytecode is unchanged. Guardian PUSH32 constants
/// are replaced by a test signer; balances and oracle answers are local fixtures.
/// This tests contract behavior, not real market-data quality or sequencer ordering.
contract DockyardPilotStressTest is Test {
    uint256 constant TEST_KEY = 9834567;
    uint256 constant DEBT_PER_MARKET = 25e6;
    uint256 constant PRINCIPAL = 24_875_621;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    DockyardUSDGCreditVaultPilot vault;
    address owner;
    address liquidator;
    address[] tokens;
    address[] feeds;
    DockyardHeartbeatGuard[] guards;
    uint256[] initialPrices;
    uint256[] deposited;
    uint256 initialTime;
    bytes32 vaultHash;

    function setUp() public {
        vm.createSelectFork(vm.envString("FORK_RPC_URL"), vm.envOr("FORK_BLOCK", uint256(52914330)));
        assertEq(block.chainid, 4663);
        string memory manifest = vm.readFile("utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json");
        vault = DockyardUSDGCreditVaultPilot(vm.parseJsonAddress(manifest, ".vault"));
        vaultHash = vm.parseJsonBytes32(manifest, ".vaultCodeHash");
        assertEq(address(vault).codehash, vaultHash);
        assertEq(vault.totalDebt(), 0);
        assertEq(vault.availableLiquidity(), 250e6);
        assertTrue(vault.paused());
        owner = vault.owner();
        liquidator = makeAddr("local stress liquidator");
        initialTime = block.timestamp;
        assertEq(vault.collateralCount(), 10);
        for (uint256 i; i < 10; i++) {
            string memory key = string.concat(".markets[", vm.toString(i), "]");
            address token = vm.parseJsonAddress(manifest, string.concat(key, ".collateral"));
            address feed = vm.parseJsonAddress(manifest, string.concat(key, ".primaryOracle"));
            DockyardHeartbeatGuard guard = DockyardHeartbeatGuard(vm.parseJsonAddress(manifest, string.concat(key, ".adapter")));
            assertEq(address(guard).codehash, vm.parseJsonBytes32(manifest, string.concat(key, ".adapterCodeHash")));
            _testGuardian(guard);
            assertEq(guard.MAX_PRICE_AGE(), 86400);
            assertEq(StressFeed(feed).decimals(), 8);
            (, int256 rawPrice,,,) = StressFeed(feed).latestRoundData();
            assertGt(rawPrice, 0);
            tokens.push(token); feeds.push(feed); guards.push(guard); initialPrices.push(uint256(rawPrice));
            _price(i, uint256(rawPrice), initialTime);
            guard.submitHealth(_proof(i));
            vm.prank(owner); vault.setMarketEnabled(token, true);
        }
        vm.prank(owner); vault.unpause();
        for (uint256 i; i < 10; i++) {
            uint256 value = Math.mulDiv(DEBT_PER_MARKET * 1e12, 10000, 3000, Math.Rounding.Up);
            uint256 amount = Math.mulDiv(value, 1e18, initialPrices[i] * 1e10, Math.Rounding.Up) + 1;
            deposited.push(amount);
            deal(tokens[i], owner, amount * 2);
            vm.prank(owner); IERC20(tokens[i]).approve(address(vault), type(uint256).max);
            bytes memory proof = _proof(i);
            vm.prank(owner); vault.depositAndBorrowChecked(tokens[i], amount, PRINCIPAL, proof);
            (,uint128 debt) = vault.positions(tokens[i], owner);
            assertEq(debt, DEBT_PER_MARKET);
        }
        assertEq(vault.totalDebt(), 250e6);
        deal(USDG, liquidator, 295_734_670);
        vm.prank(liquidator); IERC20(USDG).approve(address(vault), type(uint256).max);
        deal(USDG, owner, 250e6); // Local repayment fixture, not real treasury funding.
        vm.prank(owner); IERC20(USDG).approve(address(vault), type(uint256).max);
    }

    function _testGuardian(DockyardHeartbeatGuard guard) internal {
        bytes memory code = address(guard).code;
        bytes32 oldWord = bytes32(uint256(uint160(guard.guardian())));
        bytes32 testWord = bytes32(uint256(uint160(vm.addr(TEST_KEY))));
        uint256 replacements;
        for (uint256 i = 1; i + 32 <= code.length; i++) {
            bytes32 word;
            assembly { word := mload(add(add(code, 32), i)) }
            if (code[i - 1] == 0x7f && word == oldWord) {
                assembly { mstore(add(add(code, 32), i), testWord) }
                replacements++;
            }
        }
        assertGt(replacements, 0);
        vm.etch(address(guard), code);
        assertEq(guard.guardian(), vm.addr(TEST_KEY));
    }

    function _price(uint256 i, uint256 rawPrice, uint256 timestamp) internal {
        vm.mockCall(feeds[i], abi.encodeWithSelector(StressFeed.latestRoundData.selector),
            abi.encode(uint80(1), int256(rawPrice), timestamp, timestamp, uint80(1)));
    }
    function _proof(uint256 i) internal view returns (bytes memory) {
        (uint256 value,uint256 timestamp,uint80 round) = guards[i].currentData();
        DockyardHeartbeatGuard.Health memory h = DockyardHeartbeatGuard.Health(round, uint64(block.timestamp),
            uint64(block.timestamp + 45), uint64(block.timestamp - 300), uint64(block.timestamp + 3600),
            keccak256(abi.encode(round,value,timestamp)), guards[i].epoch());
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DockyardChainlinkGuard"),keccak256("1"),block.chainid,address(guards[i])));
        bytes32 hash = keccak256(abi.encode(guards[i].HEALTH_TYPEHASH(),h.roundId,h.observedAt,h.validUntil,h.sessionOpen,h.sessionClose,h.roundHash,h.epoch));
        (uint8 v,bytes32 r,bytes32 s) = vm.sign(TEST_KEY,ECDSA.toTypedDataHash(domain,hash));
        return abi.encode(h,abi.encodePacked(r,s,v));
    }
    function _closeBorrowing() internal {
        vm.prank(owner); vault.pause();
        for (uint256 i; i < 10; i++) { vm.prank(owner); vault.setMarketEnabled(tokens[i],false); }
    }
    function _gap(uint256 dropBps) internal returns (uint256 repaid, uint256 residual) {
        _closeBorrowing();
        vm.warp(initialTime + 3 days); // All old approvals have expired.
        for (uint256 i; i < 10; i++) {
            _price(i, initialPrices[i] * (10000-dropBps) / 10000, block.timestamp);
            vm.prank(liquidator);
            (uint256 paid,) = vault.liquidate(tokens[i],owner,50e6,liquidator);
            repaid += paid;
        }
        residual = vault.totalDebt();
        assertEq(repaid + residual, 250e6);
        assertEq(IERC20(USDG).balanceOf(liquidator),295_734_670-repaid);
        assertEq(address(vault).codehash,vaultHash);
        emit log_named_uint("drop_bps",dropBps);
        emit log_named_uint("repaid_raw_usdg",repaid);
        emit log_named_uint("residual_bad_debt_raw_usdg",residual);
    }
    function testGap26Percent_FullRecovery() public { (,uint256 bad)=_gap(2600); assertEq(bad,0); }
    function testGap50Percent_FullRecovery() public { (,uint256 bad)=_gap(5000); assertEq(bad,0); }
    function testGap68Percent_FullRecovery() public { (,uint256 bad)=_gap(6800); assertEq(bad,0); }
    function testGap70Percent_ResidualBadDebt() public { (,uint256 bad)=_gap(7000); assertGt(bad,11e6); assertLt(bad,13e6); }
    function testGap80Percent_ResidualBadDebt() public { (,uint256 bad)=_gap(8000); assertGt(bad,90e6); assertLt(bad,92e6); }
    function testGap95Percent_ResidualBadDebt() public { (,uint256 bad)=_gap(9500); assertGt(bad,210e6); assertLt(bad,211e6); }

    function testGlobalCapIncludesFeesAndBlocksAdditionalDebt() public {
        bytes memory proof=_proof(0);
        vm.prank(owner); vm.expectRevert(DockyardUSDGCreditVaultV2.DebtCeilingExceeded.selector);
        vault.borrowChecked(tokens[0],1,proof);
        assertEq(vault.totalDebt(),250e6);
    }
    function testBelowLiquidationThresholdCannotBeSeized() public {
        _price(0,initialPrices[0]*76/100,block.timestamp);
        vm.prank(liquidator); vm.expectRevert(DockyardUSDGCreditVaultV2.PositionIsHealthy.selector);
        vault.liquidate(tokens[0],owner,50e6,liquidator);
    }
    function testWeekendStalePriceBlocksLiquidationButRepaymentExitsAllMarkets() public {
        _closeBorrowing(); vm.warp(initialTime+3 days);
        for(uint256 i;i<10;i++) {
            vm.prank(liquidator); vm.expectRevert(DockyardHeartbeatGuard.StalePrice.selector);
            vault.liquidate(tokens[i],owner,50e6,liquidator);
            vm.prank(owner); vault.repayAllAndWithdrawCollateral(tokens[i],owner);
        }
        assertEq(vault.totalDebt(),0);
    }
    function testMonitorOfflineStillLiquidatesWithFreshPrimary() public {
        vm.warp(initialTime+3600);
        vm.expectRevert(DockyardHeartbeatGuard.HealthExpired.selector); guards[0].validatedPrice(true);
        _price(0,initialPrices[0]/2,block.timestamp);
        vm.prank(liquidator); (uint256 repaid,)=vault.liquidate(tokens[0],owner,50e6,liquidator);
        assertEq(repaid,DEBT_PER_MARKET);
    }
    function testSequencerRecoveryHasNoEnforcedGrace_RecordsKnownRisk() public {
        // Model a halt with no intervening blocks, then a new price in the first resumed block.
        vm.warp(initialTime+2 hours); vm.roll(block.number+1);
        _price(0,initialPrices[0]/2,block.timestamp);
        address thirdParty=makeAddr("third party liquidator"); deal(USDG,thirdParty,DEBT_PER_MARKET);
        vm.startPrank(thirdParty); IERC20(USDG).approve(address(vault),DEBT_PER_MARKET);
        (uint256 repaid,)=vault.liquidate(tokens[0],owner,DEBT_PER_MARKET,thirdParty); vm.stopPrank();
        assertEq(repaid,DEBT_PER_MARKET,"No grace is enforced; a keeper delay cannot protect borrowers from other callers");
    }
    function testGuardianQuarantineBlocksLiquidationUntilExplicitRecovery() public {
        _price(0,initialPrices[0]/2,block.timestamp);
        vm.prank(vm.addr(TEST_KEY)); guards[0].trip(true);
        vm.prank(liquidator); vm.expectRevert(DockyardHeartbeatGuard.PriceQuarantined.selector);
        vault.liquidate(tokens[0],owner,50e6,liquidator);
        vm.warp(block.timestamp+121); guards[0].submitHealth(_proof(0));
        vm.prank(liquidator); (uint256 repaid,)=vault.liquidate(tokens[0],owner,50e6,liquidator);
        assertEq(repaid,DEBT_PER_MARKET);
    }
    function testTransferRestrictionRevertsWithoutTakingKeeperFunds() public {
        _price(0,initialPrices[0]/2,block.timestamp);
        vm.mockCallRevert(tokens[0],abi.encodeWithSelector(IERC20.transfer.selector),abi.encodeWithSignature("Error(string)","Simulated issuer transfer restriction"));
        uint256 balance=IERC20(USDG).balanceOf(liquidator);
        vm.prank(liquidator); vm.expectRevert(); vault.liquidate(tokens[0],owner,50e6,liquidator);
        assertEq(IERC20(USDG).balanceOf(liquidator),balance); assertEq(vault.totalDebt(),250e6);
        vm.prank(owner); vm.expectRevert(); vault.repayAllAndWithdrawCollateral(tokens[0],owner);
        vm.prank(owner); vault.repay(tokens[0],owner,DEBT_PER_MARKET);
        (uint128 locked,uint128 debt)=vault.positions(tokens[0],owner);
        assertGt(locked,0); assertEq(debt,0,"Repayment works, but issuer restrictions still prevent token withdrawal");
    }
    function testZeroPriceCannotBeLiquidatedAndLeavesExposure() public {
        for(uint256 i;i<10;i++) {
            _price(i,0,block.timestamp);
            vm.prank(liquidator); vm.expectRevert(DockyardHeartbeatGuard.InvalidPrice.selector);
            vault.liquidate(tokens[i],owner,50e6,liquidator);
        }
        assertEq(vault.totalDebt(),250e6);
    }
}
