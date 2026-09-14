// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {DockyardPythVerifier} from "src/Oracles/DockyardPythVerifier.sol";

contract DockyardPythForkTest is Test {
    DockyardPythVerifier hub;
    bytes signedReport;
    uint256 reportUs;

    function setUp() public {
        if (block.chainid != 4663) {
            vm.skip(true);
            return;
        }
        string memory fixture = vm.readFile("./utils/assets/oracle-fixtures/pyth-signed-sample.json");
        address verifier = vm.parseJsonAddress(fixture, ".verifier");
        assertEq(verifier.codehash, vm.parseJsonBytes32(fixture, ".verifierCodeHash"));
        signedReport = vm.parseJsonBytes(fixture, ".sample.signed");
        reportUs = vm.parseUint(vm.parseJsonString(fixture, ".sample.timestampUs"));
        vm.warp(reportUs / 1e6 + 1);
        vm.deal(address(this), 1 ether);
        hub = new DockyardPythVerifier(verifier);
    }

    function testRealPythVerifierAcceptsSignedWireFormat() public {
        hub.update{value: 1}(signedReport);
        DockyardPythVerifier.Report memory r = hub.report(1);
        assertEq(r.timestampUs, reportUs);
        assertEq(r.feedUpdateTimestampUs, reportUs);
        assertGt(r.price, 0);
        assertGt(r.publishers, 1);
        assertEq(r.session, 0);
    }

    function testTamperingFailsAtRealPythVerifier() public {
        signedReport[signedReport.length - 1] = bytes1(uint8(signedReport[signedReport.length - 1]) ^ 1);
        vm.expectRevert();
        hub.update{value: 1}(signedReport);
    }

    function testRealSignedReportCannotBeRefreshedByReplay() public {
        hub.update{value: 1}(signedReport);
        vm.warp(reportUs / 1e6 + 30);
        vm.expectRevert(DockyardPythVerifier.StaleReport.selector);
        hub.update{value: 1}(signedReport);
    }
}
