// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Local test fixture: a deployed wallet can revoke its owner's signing power.
contract Wallet1271 {
    address public immutable owner;
    bool public enabled = true;
    constructor(address owner_) { owner = owner_; }
    function setEnabled(bool value) external { require(msg.sender == owner); enabled = value; }
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (!enabled || signature.length != 65) return 0xffffffff;
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := calldataload(signature.offset) s := calldataload(add(signature.offset, 32)) v := byte(0, calldataload(add(signature.offset, 64))) }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
