// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {NFTLiveCollectionsForkTest} from "./NFTLiveCollectionsFork.t.sol";
/// Tests actual deployed contracts. Only Turret's own allowlist is changed on the fork.
contract RobinhoodPunksAdmissionForkTest is NFTLiveCollectionsForkTest {
    function testPunks1Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 1); }
    function testPunks1Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 1); }
    function testPunks2Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 2); }
    function testPunks2Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 2); }
    function testPunks42Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 42); }
    function testPunks42Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 42); }
    function testPunks100Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 100); }
    function testPunks100Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 100); }
    function testPunks1000Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 1000); }
    function testPunks1000Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 1000); }
    function testPunks5000Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 5000); }
    function testPunks5000Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 5000); }
    function testPunks9999Repay() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, false, 9999); }
    function testPunks9999Default() public { lifecycleToken(0xF08c65564eB07d880021105489552080b08e4319, true, 9999); }
}
