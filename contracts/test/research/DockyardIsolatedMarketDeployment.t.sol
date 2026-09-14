// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardMockERC20, DockyardMockOracle} from "../DockyardUSDGCreditVault.t.sol";
import {IsolatedMockV3Factory} from "./DockyardV3TwapFeed.t.sol";
import {IsolatedExitMockPool} from "./DockyardAtomicLiquidator.t.sol";
import {DockyardIsolatedCreditEngine} from "src/research/DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedMarketDeployment as Deployment} from "src/research/DockyardIsolatedMarketDeployment.sol";

contract DockyardIsolatedMarketDeploymentTest is Test {
    DockyardMockERC20 cash;
    DockyardMockERC20 token;
    DockyardMockERC20 middle;
    DockyardMockOracle primary;
    DockyardMockOracle secondary;
    IsolatedMockV3Factory factory;
    IsolatedExitMockPool first;
    IsolatedExitMockPool second;
    address guardian = makeAddr("deployment-guardian");
    address treasury = makeAddr("deployment-treasury");

    function setUp() public {
        vm.warp(1000000);
        cash = new DockyardMockERC20("USDG", "USDG", 6);
        token = new DockyardMockERC20("Collateral", "COL", 18);
        middle = new DockyardMockERC20("WETH", "WETH", 18);
        primary = new DockyardMockOracle(8, 100e8);
        secondary = new DockyardMockOracle(8, 100e8);
        factory = new IsolatedMockV3Factory();
        first = new IsolatedExitMockPool(address(token), address(middle), address(factory), 1e16);
        second = new IsolatedExitMockPool(address(middle), address(cash), address(factory), 10000e6);
        factory.register(address(token), address(middle), address(first));
        factory.register(address(middle), address(cash), address(second));
    }

    function config() private view returns (Deployment.Config memory c) {
        c.chainId = block.chainid;
        c.deadline = block.timestamp + 1 hours;
        c.credit = DockyardIsolatedCreditEngine.Config({
            usdg: address(cash),
            collateral: address(token),
            primary: address(primary),
            secondary: address(secondary),
            guardian: guardian,
            staleness: 1 hours,
            maxLtvBps: 5000,
            liquidationLtvBps: 6500,
            bonusBps: 500,
            deviationBps: 500,
            minimumDebt: 1e6
        });
        c.treasury = treasury;
        c.debtLimit = 10000e6;
        c.revenueFeeBps = 1000;
        c.borrowAprBps = 1000;
        c.intermediate = address(middle);
        c.firstPool = address(first);
        c.secondPool = address(second);
        c.factory = address(factory);
        c.pins = Deployment.Pins({
            usdg: address(cash).codehash,
            collateral: address(token).codehash,
            primary: address(primary).codehash,
            secondary: address(secondary).codehash,
            intermediate: address(middle).codehash,
            firstPool: address(first).codehash,
            secondPool: address(second).codehash,
            factory: address(factory).codehash
        });
    }

    function deploy(Deployment.Config memory c) private returns (Deployment) {
        return new Deployment(c, keccak256(abi.encode(c)));
    }

    function testAtomicBindingPausedOwnershipAndNoFunds() public {
        Deployment.Config memory c = config();
        Deployment d = deploy(c);
        DockyardIsolatedCreditEngine engine = d.engine();
        assertEq(d.configHash(), keccak256(abi.encode(c)));
        assertEq(address(d.engine().pool()), address(d.pool()));
        assertEq(d.pool().creditEngine(), address(d.engine()));
        assertEq(address(d.executor().engine()), address(d.engine()));
        assertEq(d.engine().owner(), guardian);
        assertTrue(d.engine().riskPaused());
        assertTrue(d.executor().routeHealthy());
        assertEq(d.pool().totalAssets(), 0);
        assertEq(d.pool().totalSupply(), 0);
        assertEq(d.pool().feeRecipient(), c.treasury);
        assertEq(d.pool().debtLimit(), c.debtLimit);
        assertEq(d.pool().borrowAprBps(), c.borrowAprBps);
        assertEq(d.pool().revenueFeeBps(), c.revenueFeeBps);
        vm.expectRevert("Ownable: caller is not the owner");
        engine.setRiskPaused(false);
    }

    function testGuardianCanActivateThenBorrowCloseAndWithdraw() public {
        Deployment d = deploy(config());
        DockyardIsolatedCreditEngine engine = d.engine();
        cash.mint(address(this), 1000e6);
        cash.approve(address(d.pool()), 1000e6);
        d.pool().deposit(1000e6, address(this));
        token.mint(address(this), 10 ether);
        token.approve(address(d.engine()), 10 ether);
        vm.expectRevert(DockyardIsolatedCreditEngine.NotReady.selector);
        engine.depositAndBorrow(10 ether, 400e6);
        assertEq(token.balanceOf(address(this)), 10 ether);
        vm.prank(guardian);
        engine.setRiskPaused(false);
        d.engine().depositAndBorrow(10 ether, 400e6);
        cash.approve(address(d.engine()), 400e6);
        d.engine().close(400e6, address(this));
        assertEq(token.balanceOf(address(this)), 10 ether);
        assertEq(d.pool().redeem(d.pool().balanceOf(address(this)), address(this), address(this)), 1000e6);
    }

    function testDifferentReviewedInputsRejected() public {
        Deployment.Config memory c = config();
        bytes32 reviewed = keccak256(abi.encode(c));
        c.debtLimit++;
        vm.expectRevert(Deployment.ConfigurationMismatch.selector);
        new Deployment(c, reviewed);
    }

    function testWrongChainRejected() public {
        Deployment.Config memory c = config();
        c.chainId++;
        vm.expectRevert(Deployment.WrongChain.selector);
        deploy(c);
    }

    function testExpiredAndExcessivelyLongConfigurationRejected() public {
        Deployment.Config memory c = config();
        c.deadline = block.timestamp - 1;
        vm.expectRevert(Deployment.ExpiredConfiguration.selector);
        deploy(c);
        c.deadline = block.timestamp + 1 days + 1;
        vm.expectRevert(Deployment.ExpiredConfiguration.selector);
        deploy(c);
    }

    function testEachDependencyPinRequired() public {
        for (uint256 i; i < 8; i++) {
            Deployment.Config memory c = config();
            if (i == 0) c.pins.usdg = bytes32(0);
            if (i == 1) c.pins.collateral = bytes32(0);
            if (i == 2) c.pins.primary = bytes32(0);
            if (i == 3) c.pins.secondary = bytes32(0);
            if (i == 4) c.pins.intermediate = bytes32(0);
            if (i == 5) c.pins.firstPool = bytes32(0);
            if (i == 6) c.pins.secondPool = bytes32(0);
            if (i == 7) c.pins.factory = bytes32(0);
            vm.expectPartialRevert(Deployment.DependencyMismatch.selector);
            deploy(c);
        }
    }

    function testChangedRuntimeRejected() public {
        Deployment.Config memory c = config();
        vm.etch(address(primary), hex"00");
        vm.expectRevert(abi.encodeWithSelector(Deployment.DependencyMismatch.selector, address(primary)));
        deploy(c);
    }

    function testInvalidGuardianRejected() public {
        Deployment.Config memory c = config();
        c.credit.guardian = address(0);
        vm.expectRevert(Deployment.InvalidGuardian.selector);
        deploy(c);
        c.credit.guardian = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(Deployment.InvalidGuardian.selector);
        deploy(c);
    }

    function testOracleFailureRollsBackAllCreations() public {
        Deployment.Config memory c = config();
        address receipt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedEngine = vm.computeCreateAddress(receipt, 1);
        primary.setShouldRevert(true);
        vm.expectRevert(DockyardIsolatedCreditEngine.OracleUnavailable.selector);
        deploy(c);
        assertEq(receipt.code.length, 0);
        assertEq(predictedEngine.code.length, 0);
    }

    function testGuardianCannotBeAnyCreatedMarketContract() public {
        for (uint256 child = 1; child <= 3; child++) {
            Deployment.Config memory c = config();
            address receipt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
            c.credit.guardian = vm.computeCreateAddress(receipt, child);
            vm.expectRevert(Deployment.InvalidGuardian.selector);
            deploy(c);
            assertEq(receipt.code.length, 0);
        }
    }

    function testTreasuryCannotBeReceiptOrCreatedMarketContract() public {
        for (uint256 child; child <= 3; child++) {
            Deployment.Config memory c = config();
            address receipt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
            c.treasury = child == 0 ? receipt : vm.computeCreateAddress(receipt, child);
            // The pool itself also rejects its own address as recipient.
            vm.expectRevert();
            deploy(c);
            assertEq(receipt.code.length, 0);
        }
    }

    function testInvalidRouteRollsBackBoundPoolAndEngine() public {
        Deployment.Config memory c = config();
        address receipt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address predictedEngine = vm.computeCreateAddress(receipt, 1);
        address predictedPool = vm.computeCreateAddress(receipt, 2);
        factory.register(address(token), address(middle), address(second));
        vm.expectRevert();
        deploy(c);
        assertEq(receipt.code.length, 0);
        assertEq(predictedEngine.code.length, 0);
        assertEq(predictedPool.code.length, 0);
    }

    function testDeploymentFitsEvmCodeLimits() public {
        Deployment.Config memory c = config();
        assertLe(abi.encodePacked(type(Deployment).creationCode, abi.encode(c, keccak256(abi.encode(c)))).length, 49152);
        Deployment d = deploy(c);
        assertLe(address(d).code.length, 24576);
        assertLe(address(d.engine()).code.length, 24576);
        assertLe(address(d.pool()).code.length, 24576);
        assertLe(address(d.executor()).code.length, 24576);
    }
}
