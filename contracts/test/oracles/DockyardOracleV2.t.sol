// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {DockyardMockERC20, DockyardMockStockToken, DockyardMockOracle} from "test/DockyardUSDGCreditVault.t.sol";
import {DockyardUSDGCreditVaultV2} from "src/DockyardUSDGCreditVaultV2.sol";
import {DockyardPythVerifier} from "src/Oracles/DockyardPythVerifier.sol";
import {DockyardOracleRelay} from "src/Oracles/DockyardOracleRelay.sol";
import {DockyardDualOracle} from "src/Oracles/DockyardDualOracle.sol";

// Local signature-verifying fixture uses the production EVM envelope format.
contract SignedPythFixture {
    address public immutable signer;
    uint256 public constant verification_fee = 1;

    constructor(address signer_) {
        signer = signer_;
    }

    function verifyUpdate(bytes calldata update) external payable returns (bytes memory payload, address) {
        require(msg.value == 1 && update.length >= 71 && uint32(bytes4(update[:4])) == 706910618, "envelope");
        uint256 length = uint16(bytes2(update[69:71]));
        require(update.length == 71 + length, "length");
        payload = update[71:];
        require(
            ECDSA.recover(keccak256(payload), uint8(update[68]) + 27, bytes32(update[4:36]), bytes32(update[36:68]))
                == signer,
            "signature"
        );
        return (payload, signer);
    }
}

contract ScaledStockFixture is DockyardMockStockToken {
    uint256 public uiMultiplier = 1e18;
    uint256 public effectiveAt;

    function setMultiplier(uint256 value, uint256 effective) external {
        uiMultiplier = value;
        effectiveAt = effective;
    }
}

contract GasBurningObservationFixture {
    address public pyth;

    constructor(address hub_) {
        pyth = hub_;
    }

    function observe() external pure returns (bool) {
        assembly { for {} 1 {} {} }
    }
}

contract DockyardOracleV2Test is Test {
    uint256 constant SIGNER_KEY = 78901;
    uint32 constant FEED = 1;
    DockyardMockERC20 usdg;
    ScaledStockFixture stock;
    DockyardMockOracle primary;
    SignedPythFixture verifier;
    DockyardPythVerifier hub;
    DockyardDualOracle oracle;
    DockyardUSDGCreditVaultV2 vault;
    address borrower = makeAddr("borrower-v2");
    address liquidator = makeAddr("liquidator-v2");

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(address(this), 1 ether);
        usdg = new DockyardMockERC20("USDG", "USDG", 6);
        stock = new ScaledStockFixture();
        primary = new DockyardMockOracle(8, 100e8);
        verifier = new SignedPythFixture(vm.addr(SIGNER_KEY));
        hub = new DockyardPythVerifier(address(verifier));
        oracle = new DockyardDualOracle(address(stock), address(primary), address(hub), FEED, _policy());
        vault = new DockyardUSDGCreditVaultV2(address(usdg), address(this), 50, 1000e6);
        vault.addMarket(address(stock), address(primary), address(oracle), 2000e6, 4500, 5500, 500, 200);
        _recover(100e8, 0);
        vault.setMarketEnabled(address(stock), true);
        vault.unpause();
        usdg.mint(address(this), 1_000_000e6);
        usdg.approve(address(vault), type(uint256).max);
        vault.fund(1_000_000e6);
        stock.mint(borrower, 100e18);
        vm.prank(borrower);
        stock.approve(address(vault), type(uint256).max);
        usdg.mint(liquidator, 1_000_000e6);
        vm.prank(liquidator);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _policy() internal pure returns (DockyardDualOracle.Policy memory) {
        return DockyardDualOracle.Policy(300, 60, 60, 30, 200, 100, 3, 1, 15);
    }

    function _payload(int64 price, uint64 sourceUs, uint16 session, uint64 confidence)
        internal
        view
        returns (bytes memory)
    {
        bytes memory header =
            abi.encodePacked(uint32(2479346549), uint64(block.timestamp * 1e6), uint8(4), uint8(1), FEED, uint8(6));
        bytes memory values = abi.encodePacked(uint8(0), price, uint8(3), uint16(3), uint8(4), int16(-8));
        return bytes.concat(
            header, values, abi.encodePacked(uint8(5), confidence, uint8(9), session, uint8(12), uint8(1), sourceUs)
        );
    }

    function _signed(bytes memory payload, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(payload));
        return abi.encodePacked(uint32(706910618), r, s, uint8(v - 27), uint16(payload.length), payload);
    }

    function _post(int64 price, uint64 sourceUs, uint16 session) internal {
        hub.update{value: 1}(_signed(_payload(price, sourceUs, session, 1e6), SIGNER_KEY));
    }

    function _tick(int64 price, uint16 session) internal {
        vm.warp(block.timestamp + 10);
        primary.setAnswer(price);
        _post(price, uint64(block.timestamp * 1e6), session);
        oracle.observe();
    }

    function _recover(int64 price, uint16 session) internal {
        for (uint256 i; i < 7; ++i) {
            _tick(price, session);
        }
    }

    function _borrow() internal {
        vm.prank(borrower);
        vault.depositAndBorrow(address(stock), 10e18, 400e6);
    }

    function testBothSourcesRequiredEvenIfChainlinkLooksHealthy() public {
        _borrow();
        vm.warp(block.timestamp + 60);
        primary.setAnswer(100e8);
        vm.expectRevert(DockyardDualOracle.StalePrice.selector);
        vault.price(address(stock));
        vm.prank(borrower);
        vm.expectRevert(DockyardDualOracle.StalePrice.selector);
        vault.borrow(address(stock), 1e6);
    }

    function testBadPrimaryCannotBeHiddenByPyth() public {
        primary.setShouldRevert(true);
        vm.expectRevert();
        vault.price(address(stock));
    }

    function testInflatedSharedPrimaryDoesNotEnableUnderbackedLoan() public {
        primary.setAnswer(50_000e8);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(DockyardDualOracle.PriceDisagreement.selector, 50_000e18, 100e18));
        vault.depositAndBorrow(address(stock), 1e14, 1e6);
        assertEq(vault.totalDebt(), 0);
    }

    function testFreshEnvelopeDoesNotRefreshCarriedForwardPrice() public {
        vm.warp(block.timestamp + 1);
        _post(100e8, uint64((block.timestamp - 23 hours) * 1e6), 0);
        vm.expectRevert(DockyardDualOracle.StalePrice.selector);
        vault.price(address(stock));
    }

    function testClosedSessionBlocksRiskButPreservesRepaymentTopUpAndExit() public {
        _borrow();
        _tick(100e8, 4);
        vm.expectRevert(DockyardDualOracle.MarketClosed.selector);
        vault.price(address(stock));
        vm.startPrank(borrower);
        vm.expectRevert(DockyardDualOracle.MarketClosed.selector);
        vault.borrow(address(stock), 1e6);
        vm.expectRevert(DockyardDualOracle.MarketClosed.selector);
        vault.withdrawCollateral(address(stock), 1, borrower);
        vault.depositCollateral(address(stock), 1e18);
        usdg.mint(borrower, 2e6);
        usdg.approve(address(vault), type(uint256).max);
        vault.repayAllAndWithdrawCollateral(address(stock), borrower);
        vm.stopPrank();
        assertEq(vault.totalDebt(), 0);
        assertEq(stock.balanceOf(borrower), 100e18);
    }

    function testTopUpWorksWhileVaultMarketAndTokenOraclePaused() public {
        _borrow();
        vault.pause();
        vault.setMarketEnabled(address(stock), false);
        stock.setOraclePaused(true);
        vm.prank(borrower);
        vault.depositCollateral(address(stock), 1e18);
        (uint128 col, uint128 debt) = vault.positions(address(stock), borrower);
        assertEq(col, 11e18);
        assertEq(debt, 402e6);
    }

    function testDebtFreeWithdrawalIgnoresOracleAndPause() public {
        vm.prank(borrower);
        vault.depositCollateral(address(stock), 1e18);
        vault.pause();
        primary.setShouldRevert(true);
        vm.prank(borrower);
        vault.withdrawCollateral(address(stock), 1e18, borrower);
    }

    function testOvernightAllowsLiquidationButBlocksNewRisk() public {
        _borrow();
        _tick(60e8, 3);
        vm.prank(borrower);
        vm.expectRevert(DockyardDualOracle.MarketClosed.selector);
        vault.borrow(address(stock), 1e6);
        vm.prank(liquidator);
        (uint256 repaid,) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        assertEq(repaid, 402e6);
    }

    function testRecoveryCannotBeSkippedAfterUnobservedGap() public {
        vm.warp(block.timestamp + 1 days);
        _tick(100e8, 0);
        vm.expectRevert(DockyardDualOracle.RecoveryPending.selector);
        vault.price(address(stock));
        _recover(100e8, 0);
        assertEq(vault.price(address(stock)), 100e18);
    }

    function testClosedThenOpenRequiresRecovery() public {
        _tick(100e8, 4);
        _tick(100e8, 0);
        vm.expectRevert(DockyardDualOracle.RecoveryPending.selector);
        vault.price(address(stock));
        _recover(100e8, 0);
        assertEq(vault.price(address(stock)), 100e18);
    }

    function testDisagreementResetsRecovery() public {
        primary.setAnswer(200e8);
        assertFalse(oracle.observe());
        _tick(100e8, 0);
        vm.expectRevert(DockyardDualOracle.RecoveryPending.selector);
        vault.price(address(stock));
    }

    function testConfidenceRejectsUncertainPrice() public {
        vm.warp(block.timestamp + 1);
        hub.update{value: 1}(_signed(_payload(100e8, uint64(block.timestamp * 1e6), 0, 10e8), SIGNER_KEY));
        vm.expectRevert(DockyardDualOracle.InvalidPrice.selector);
        vault.price(address(stock));
    }

    function testPrimaryHeartbeatIsEnforcedSeparately() public {
        primary.setUpdatedAt(block.timestamp - 300);
        vm.expectRevert(DockyardDualOracle.StalePrice.selector);
        vault.price(address(stock));
    }

    function testMultiplierAppliedOnlyToIndependentStockQuote() public {
        stock.setMultiplier(2e18, 0);
        primary.setAnswer(200e8);
        assertEq(vault.price(address(stock)), 200e18);
    }

    function testCorporateActionRejectsOlderReports() public {
        vm.warp(block.timestamp + 1);
        stock.setMultiplier(2e18, block.timestamp);
        primary.setAnswer(200e8);
        vm.expectRevert(DockyardDualOracle.CorporateActionPending.selector);
        vault.price(address(stock));
    }

    function testGlobalCapIncludesOriginationFee() public {
        vm.prank(borrower);
        vm.expectRevert(DockyardUSDGCreditVaultV2.DebtCeilingExceeded.selector);
        vault.depositAndBorrow(address(stock), 100e18, 1000e6);
        assertEq(stock.balanceOf(borrower), 100e18);
    }

    function testCannotConfigureOldAliasedOraclePair() public {
        DockyardUSDGCreditVaultV2 other = new DockyardUSDGCreditVaultV2(address(usdg), address(this), 50, 1000e6);
        vm.expectRevert();
        other.addMarket(address(stock), address(primary), address(primary), 1000e6, 4500, 5500, 500, 200);
    }

    function testInvalidSignatureRejected() public {
        vm.expectRevert();
        hub.update{value: 1}(_signed(_payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6), SIGNER_KEY + 1));
    }

    function testNewClosedReportCannotBeReplayedBackToOpen() public {
        bytes memory old = _signed(_payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6), SIGNER_KEY);
        _tick(100e8, 4);
        hub.update{value: 1}(old);
        vm.expectRevert(DockyardDualOracle.MarketClosed.selector);
        vault.price(address(stock));
    }

    function testTruncatedAndTrailingPayloadRejected() public {
        bytes memory p = _payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6);
        vm.expectRevert(DockyardPythVerifier.InvalidPayload.selector);
        hub.update{value: 1}(_signed(abi.encodePacked(p, bytes1(0)), SIGNER_KEY));
        assembly { mstore(p, sub(mload(p), 1)) }
        vm.expectRevert(DockyardPythVerifier.InvalidPayload.selector);
        hub.update{value: 1}(_signed(p, SIGNER_KEY));
    }

    function testFutureSourceAndEnvelopeRejected() public {
        vm.expectRevert(DockyardPythVerifier.InvalidPayload.selector);
        hub.update{value: 1}(_signed(_payload(100e8, uint64(block.timestamp * 1e6 + 1), 0, 1e6), SIGNER_KEY));
        bytes memory p = _payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6);
        uint256 now_ = block.timestamp;
        vm.warp(now_ - 1);
        vm.expectRevert(DockyardPythVerifier.StaleReport.selector);
        hub.update{value: 1}(_signed(p, SIGNER_KEY));
    }

    function testBatchRelayPublishesClosedReportAndResetsObservation() public {
        address[] memory adapters = new address[](1);
        adapters[0] = address(oracle);
        DockyardOracleRelay relay = new DockyardOracleRelay(address(hub), adapters);
        vm.warp(block.timestamp + 1);
        relay.update{value: 1}(_signed(_payload(100e8, uint64(block.timestamp * 1e6), 4, 1e6), SIGNER_KEY));
        assertEq(oracle.validSince(), 0);
        assertEq(hub.report(FEED).session, 4);
    }

    function testGasBurningAdapterCannotBlockOtherMarketObservations() public {
        address[] memory adapters = new address[](2);
        adapters[0] = address(new GasBurningObservationFixture(address(hub)));
        adapters[1] = address(oracle);
        DockyardOracleRelay relay = new DockyardOracleRelay(address(hub), adapters);
        vm.warp(block.timestamp + 1);
        relay.update{value: 1}(_signed(_payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6), SIGNER_KEY));
        assertEq(oracle.lastObservation(), block.timestamp);
        assertEq(vault.price(address(stock)), 100e18);
    }

    function testMissingSourceTimestampDoesNotUseEnvelopeTime() public {
        bytes memory p = _payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6);
        vm.warp(block.timestamp + 1);
        p = _payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6);
        p[p.length - 9] = 0;
        assembly { mstore(p, sub(mload(p), 8)) }
        hub.update{value: 1}(_signed(p, SIGNER_KEY));
        assertEq(hub.report(FEED).feedUpdateTimestampUs, 0);
        vm.expectRevert(DockyardDualOracle.StalePrice.selector);
        vault.price(address(stock));
    }

    function testDuplicateFeedIdsAreRejectedAtomically() public {
        bytes memory p = _payload(100e8, uint64(block.timestamp * 1e6), 0, 1e6);
        bytes memory duplicate = new bytes(p.length - 14);
        for (uint256 i = 14; i < p.length; ++i) {
            duplicate[i - 14] = p[i];
        }
        p[13] = bytes1(uint8(2));
        vm.expectRevert(DockyardPythVerifier.InvalidPayload.selector);
        hub.update{value: 1}(_signed(bytes.concat(p, duplicate), SIGNER_KEY));
    }

    function testInvalidSignedPriceSupersedesPreviouslyGoodValue() public {
        vm.warp(block.timestamp + 1);
        _post(-100e8, uint64(block.timestamp * 1e6), 0);
        vm.expectRevert(DockyardDualOracle.InvalidPrice.selector);
        vault.price(address(stock));
    }

    function testFuzzLiquidationPreservesAccounting(uint96 amount) public {
        amount = uint96(bound(amount, 6e6, 400e6));
        vm.prank(borrower);
        vault.depositAndBorrow(address(stock), 10e18, amount);
        (, uint128 beforeDebt) = vault.positions(address(stock), borrower);
        _tick(1e8, 0);
        uint256 beforeLiquidity = usdg.balanceOf(address(vault));
        vm.prank(liquidator);
        (uint256 repaid, uint256 seized) = vault.liquidate(address(stock), borrower, type(uint256).max, liquidator);
        (uint128 col, uint128 debt) = vault.positions(address(stock), borrower);
        assertEq(debt, uint256(beforeDebt) - repaid);
        assertEq(vault.totalDebt(), debt);
        assertEq(vault.marketDebt(address(stock)), debt);
        assertEq(col, 10e18 - seized);
        assertEq(usdg.balanceOf(address(vault)), beforeLiquidity + repaid);
    }
}
