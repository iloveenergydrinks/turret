// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {DockyardStockCreditFixture} from "./DockyardStockCreditEngine.t.sol";
import {DockyardStockMarketDeployment as Deployment} from "src/research/DockyardStockMarketDeployment.sol";

contract DockyardStockMarketDeploymentTest is DockyardStockCreditFixture {
    function _deploymentConfig() private view returns (Deployment.Config memory c) {
        c.chainId = block.chainid;
        c.deadline = block.timestamp + 1 hours;
        c.credit = _config();
        c.executionGate = address(gate);
        c.usdgPricing = _usdgConfig();
        c.treasury = address(0xBEEF);
        c.debtLimit = 1000e6;
        c.revenueFeeBps = 1000;
        c.borrowAprBps = 1000;
        c.pins = Deployment.Pins(
            address(cash).codehash,
            address(stock).codehash,
            address(stockFeed).codehash,
            address(guard).codehash,
            address(gate).codehash,
            address(usdA).codehash,
            address(usdB).codehash
        );
    }

    function testAtomicPausedAssemblyHasNoFundsAndOwnerCanRecoverLifecycle() public {
        Deployment.Config memory c = _deploymentConfig();
        Deployment d = new Deployment(c, keccak256(abi.encode(c)));
        engine = d.engine();
        pool = d.pool();
        assertEq(engine.owner(), address(this));
        assertEq(address(engine.pool()), address(pool));
        assertEq(pool.creditEngine(), address(engine));
        assertTrue(engine.riskPaused());
        assertEq(pool.totalAssets(), 0);
        assertEq(pool.totalSupply(), 0);
        assertEq(d.configHash(), keccak256(abi.encode(c)));
        assertLe(address(d).code.length, 24576);
        assertLe(type(Deployment).creationCode.length + abi.encode(c, keccak256(abi.encode(c))).length, 49152);
        cash.mint(address(this), 100e6);
        cash.approve(address(pool), 100e6);
        pool.depositChecked(100e6, address(this), 100e12, block.timestamp + 300, "", "");
        engine.setRiskPaused(false);
        vm.startPrank(borrower);
        stock.approve(address(engine), 1e18);
        cash.approve(address(engine), 20e6);
        vm.stopPrank();
        _open();
        vm.prank(borrower);
        engine.close(20e6, borrower);
        assertEq(
            pool.redeemChecked(
                pool.balanceOf(address(this)), address(this), address(this), 100e6, block.timestamp + 300, "", ""
            ),
            100e6
        );
    }

    function testChangedInputsCannotUseOldConfigurationDigest() public {
        Deployment.Config memory c = _deploymentConfig();
        bytes32 digest = keccak256(abi.encode(c));
        c.borrowAprBps += 1;
        vm.expectRevert(Deployment.InvalidDeployment.selector);
        new Deployment(c, digest);
    }

    function testExpiredOrWrongChainDeploymentRejected() public {
        Deployment.Config memory c = _deploymentConfig();
        c.deadline = block.timestamp - 1;
        vm.expectRevert(Deployment.InvalidDeployment.selector);
        new Deployment(c, keccak256(abi.encode(c)));
        c = _deploymentConfig();
        c.chainId = 1;
        vm.expectRevert(Deployment.InvalidDeployment.selector);
        new Deployment(c, keccak256(abi.encode(c)));
    }

    function testDependencyChangeCannotBeSilentlyPinnedDuringCreation() public {
        Deployment.Config memory c = _deploymentConfig();
        vm.etch(address(usdB), hex"60006000fd");
        vm.expectRevert(abi.encodeWithSelector(Deployment.DependencyMismatch.selector, address(usdB)));
        new Deployment(c, keccak256(abi.encode(c)));
    }

    function testMissingDependencyPinRejected() public {
        Deployment.Config memory c = _deploymentConfig();
        c.pins.executionGate = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(Deployment.DependencyMismatch.selector, address(gate)));
        new Deployment(c, keccak256(abi.encode(c)));
    }

    function testOwnerCannotBeAChildContractWithNoRecoveryAuthority() public {
        Deployment.Config memory c = _deploymentConfig();
        address receipt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        c.credit.guardian = vm.computeCreateAddress(receipt, 1);
        vm.expectRevert(Deployment.InvalidDeployment.selector);
        new Deployment(c, keccak256(abi.encode(c)));
    }
}
