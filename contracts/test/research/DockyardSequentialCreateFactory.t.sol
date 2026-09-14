// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DockyardSequentialCreateFactory as Factory} from "src/research/DockyardSequentialCreateFactory.sol";

contract TinyCreated {
    uint256 public immutable value;

    constructor(uint256 value_) {
        value = value_;
    }
}

contract DockyardSequentialCreateFactoryTest is Test {
    Factory private factory;

    function setUp() public {
        factory = new Factory(address(this));
    }

    function _code(uint256 value) private pure returns (bytes memory) {
        return abi.encodePacked(type(TinyCreated).creationCode, abi.encode(value));
    }

    function _hashes(bytes[] memory codes) private returns (bytes32[] memory init, bytes32[] memory runtime) {
        init = new bytes32[](codes.length);
        runtime = new bytes32[](codes.length);
        for (uint256 i; i < codes.length; ++i) {
            init[i] = keccak256(codes[i]);
            runtime[i] = keccak256(address(new TinyCreated(i + 1)).code);
        }
    }

    function testAtomicPinnedBatchAndSequence() public {
        bytes[] memory codes = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            codes[i] = _code(i + 1);
        }
        (bytes32[] memory init, bytes32[] memory runtime) = _hashes(codes);
        address[] memory deployed = factory.deployBatch(codes, init, runtime, 0);
        assertEq(deployed.length, 3);
        assertEq(TinyCreated(deployed[0]).value(), 1);
        assertEq(TinyCreated(deployed[2]).value(), 3);
        assertEq(factory.totalCreated(), 3);
        vm.expectRevert(Factory.InvalidBatch.selector);
        factory.deployBatch(codes, init, runtime, 0);
    }

    function testOnlyOperatorAndExactHashes() public {
        bytes[] memory codes = new bytes[](1);
        codes[0] = _code(1);
        (bytes32[] memory init, bytes32[] memory runtime) = _hashes(codes);
        vm.prank(address(0xBEEF));
        vm.expectRevert(Factory.Unauthorized.selector);
        factory.deployBatch(codes, init, runtime, 0);
        init[0] = bytes32(uint256(1));
        vm.expectRevert(Factory.InvalidBatch.selector);
        factory.deployBatch(codes, init, runtime, 0);
    }

    function testRejectsMoreThanFourCreations() public {
        bytes[] memory codes = new bytes[](5);
        bytes32[] memory init = new bytes32[](5);
        bytes32[] memory runtime = new bytes32[](5);
        vm.expectRevert(Factory.InvalidBatch.selector);
        factory.deployBatch(codes, init, runtime, 0);
    }

    function testRuntimeMismatchRevertsWholeBatch() public {
        bytes[] memory codes = new bytes[](2);
        codes[0] = _code(1);
        codes[1] = _code(2);
        (bytes32[] memory init, bytes32[] memory runtime) = _hashes(codes);
        runtime[1] = bytes32(uint256(1));
        vm.expectRevert(
            abi.encodeWithSelector(Factory.RuntimeMismatch.selector, 1, vm.computeCreateAddress(address(factory), 2))
        );
        factory.deployBatch(codes, init, runtime, 0);
        assertEq(factory.totalCreated(), 0);
        assertEq(vm.getNonce(address(factory)), 1);
    }
}
