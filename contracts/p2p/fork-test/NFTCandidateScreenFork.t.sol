// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {NFTLiveCollectionsForkTest} from "./NFTLiveCollectionsFork.t.sol";
/// @dev Candidate screening only. Mutations occur solely in a mainnet fork.
contract NFTCandidateScreenForkTest is NFTLiveCollectionsForkTest {
    function testCandidate0Repay() public { lifecycle(0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0, false); }
    function testCandidate0Default() public { lifecycle(0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0, true); }
    function testCandidate1Repay() public { lifecycle(0x797a2e030B7e49107C8F07bF0300Ea9caE88cA57, false); }
    function testCandidate1Default() public { lifecycle(0x797a2e030B7e49107C8F07bF0300Ea9caE88cA57, true); }
    function testCandidate2Repay() public { lifecycle(0xF08c65564eB07d880021105489552080b08e4319, false); }
    function testCandidate2Default() public { lifecycle(0xF08c65564eB07d880021105489552080b08e4319, true); }
    function testCandidate3Repay() public { lifecycle(0x6dC3f3abf0945958bE19B02f86BE257C4A05Fcf2, false); }
    function testCandidate3Default() public { lifecycle(0x6dC3f3abf0945958bE19B02f86BE257C4A05Fcf2, true); }
}
