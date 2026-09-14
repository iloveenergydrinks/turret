// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardIsolatedCreditEngine} from "./DockyardIsolatedCreditEngine.sol";
import {DockyardIsolatedCapitalPool} from "./DockyardIsolatedCapitalPool.sol";
import {DockyardAtomicLiquidator} from "./DockyardAtomicLiquidator.sol";

/// @notice Atomic, paused market assembly. Does not certify collateral or oracle safety.
/// @dev Configuration hash binds inputs, not external review approval. No funds are
/// moved and borrowing is never enabled here. Do not send assets to this receipt.
contract DockyardIsolatedMarketDeployment {
    struct Pins {
        bytes32 usdg;
        bytes32 collateral;
        bytes32 primary;
        bytes32 secondary;
        bytes32 intermediate;
        bytes32 firstPool;
        bytes32 secondPool;
        bytes32 factory;
    }

    struct Config {
        uint256 chainId;
        uint256 deadline;
        DockyardIsolatedCreditEngine.Config credit;
        address treasury;
        uint256 debtLimit;
        uint16 revenueFeeBps;
        uint16 borrowAprBps;
        address intermediate;
        address firstPool;
        address secondPool;
        address factory;
        Pins pins;
    }

    DockyardIsolatedCreditEngine public immutable engine;
    DockyardIsolatedCapitalPool public immutable pool;
    DockyardAtomicLiquidator public immutable executor;
    bytes32 public immutable configHash;

    error ConfigurationMismatch();
    error WrongChain();
    error ExpiredConfiguration();
    error InvalidGuardian();
    error InvalidTreasury();
    error DependencyMismatch(address dependency);

    event MarketDeployed(
        bytes32 indexed configHash,
        address indexed collateral,
        address indexed guardian,
        address engine,
        address pool,
        address executor
    );

    constructor(Config memory c, bytes32 expectedConfigHash) {
        bytes32 digest = keccak256(abi.encode(c));
        if (expectedConfigHash == bytes32(0) || digest != expectedConfigHash) revert ConfigurationMismatch();
        if (c.chainId != block.chainid) revert WrongChain();
        if (c.deadline < block.timestamp || c.deadline > block.timestamp + 1 days) revert ExpiredConfiguration();
        address guardian = c.credit.guardian;
        if (guardian == address(0) || guardian == address(this)) revert InvalidGuardian();
        if (c.treasury == address(0) || c.treasury == address(this)) revert InvalidTreasury();
        _check(c.credit.usdg, c.pins.usdg);
        _check(c.credit.collateral, c.pins.collateral);
        _check(c.credit.primary, c.pins.primary);
        _check(c.credit.secondary, c.pins.secondary);
        _check(c.intermediate, c.pins.intermediate);
        _check(c.firstPool, c.pins.firstPool);
        _check(c.secondPool, c.pins.secondPool);
        _check(c.factory, c.pins.factory);

        configHash = digest;
        // Temporary constructor-only authority binds the pool before handover.
        c.credit.guardian = address(this);
        engine = new DockyardIsolatedCreditEngine(c.credit);
        engine.price();
        pool = new DockyardIsolatedCapitalPool(
            IERC20Metadata(c.credit.usdg),
            c.credit.collateral,
            address(engine),
            c.treasury,
            c.debtLimit,
            c.revenueFeeBps,
            c.borrowAprBps
        );
        engine.bindPool(pool);
        executor = new DockyardAtomicLiquidator(address(engine), c.intermediate, c.firstPool, c.secondPool, c.factory);
        if (guardian == address(engine) || guardian == address(pool) || guardian == address(executor)) {
            revert InvalidGuardian();
        }
        if (c.treasury == address(engine) || c.treasury == address(pool) || c.treasury == address(executor)) {
            revert InvalidTreasury();
        }
        engine.transferOwnership(guardian);
        emit MarketDeployed(digest, c.credit.collateral, guardian, address(engine), address(pool), address(executor));
    }

    function _check(address dependency, bytes32 expected) private view {
        if (expected == bytes32(0) || dependency.code.length == 0 || dependency.codehash != expected) {
            revert DependencyMismatch(dependency);
        }
    }
}
