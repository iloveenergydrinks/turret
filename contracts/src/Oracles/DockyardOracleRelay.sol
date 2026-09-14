// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {DockyardPythVerifier} from "./DockyardPythVerifier.sol";
import {DockyardDualOracle} from "./DockyardDualOracle.sol";

/// @notice Batches authenticated publication and recovery observations in one transaction.
/// @dev Permissionless: the caller pays gas but cannot choose prices or replace market adapters.
contract DockyardOracleRelay {
    DockyardPythVerifier public immutable hub;
    DockyardDualOracle[] public oracles;
    error InvalidConfiguration();
    event AdapterObserved(address indexed adapter, bool healthy);

    constructor(address hub_, address[] memory adapters) {
        if (hub_.code.length == 0 || adapters.length == 0 || adapters.length > 32) revert InvalidConfiguration();
        hub = DockyardPythVerifier(hub_);
        for (uint256 i; i < adapters.length; ++i) {
            DockyardDualOracle adapter = DockyardDualOracle(adapters[i]);
            if (adapters[i].code.length == 0 || address(adapter.pyth()) != hub_) revert InvalidConfiguration();
            for (uint256 j; j < i; ++j) {
                if (adapters[i] == adapters[j]) revert InvalidConfiguration();
            }
            oracles.push(adapter);
        }
    }

    function oracleCount() external view returns (uint256) {
        return oracles.length;
    }

    function update(bytes calldata signedUpdate) external payable {
        hub.update{value: msg.value}(signedUpdate);
        for (uint256 i; i < oracles.length; ++i) {
            // A failed market cannot prevent publication for the remaining markets.
            try oracles[i].observe{gas: 250_000}() returns (bool healthy) {
                emit AdapterObserved(address(oracles[i]), healthy);
            } catch {
                emit AdapterObserved(address(oracles[i]), false);
            }
        }
    }
}
