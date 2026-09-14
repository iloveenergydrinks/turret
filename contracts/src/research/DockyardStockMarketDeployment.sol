// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20Metadata} from "openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DockyardIsolatedCreditEngine} from "./DockyardIsolatedCreditEngine.sol";
import {DockyardStockCreditEngine} from "./DockyardStockCreditEngine.sol";
import {DockyardStockCapitalPool} from "./DockyardStockCapitalPool.sol";

/// @notice Atomic, paused assembly of a stock credit engine and its lender pool.
/// @dev Does not fund or activate the market. The config digest is an integrity
/// check, not evidence of review, asset admission, oracle independence or an audit.
contract DockyardStockMarketDeployment {
    struct Pins {
        bytes32 usdg;
        bytes32 collateral;
        bytes32 stockFeed;
        bytes32 stockGuard;
        bytes32 executionGate;
        bytes32 usdgPrimary;
        bytes32 usdgSecondary;
    }

    struct Config {
        uint256 chainId;
        uint256 deadline;
        DockyardIsolatedCreditEngine.Config credit;
        address executionGate;
        DockyardStockCreditEngine.UsdgPricing usdgPricing;
        address treasury;
        uint256 debtLimit;
        uint16 revenueFeeBps;
        uint16 borrowAprBps;
        Pins pins;
    }
    DockyardStockCreditEngine public immutable engine;
    DockyardStockCapitalPool public immutable pool;
    bytes32 public immutable configHash;

    error InvalidDeployment();
    error DependencyMismatch(address dependency);
    event StockMarketDeployed(
        bytes32 indexed configHash, address indexed collateral, address indexed owner, address engine, address pool
    );

    constructor(Config memory c, bytes32 expectedHash) {
        bytes32 digest = keccak256(abi.encode(c));
        if (
            digest != expectedHash || c.chainId != block.chainid || c.deadline < block.timestamp
                || c.deadline > block.timestamp + 1 days || c.credit.guardian == address(0)
                || c.credit.guardian == address(this) || c.treasury == address(0) || c.treasury == address(this)
        ) {
            revert InvalidDeployment();
        }
        _check(c.credit.usdg, c.pins.usdg);
        _check(c.credit.collateral, c.pins.collateral);
        _check(c.credit.primary, c.pins.stockFeed);
        _check(c.credit.secondary, c.pins.stockGuard);
        _check(c.executionGate, c.pins.executionGate);
        _check(c.usdgPricing.primary, c.pins.usdgPrimary);
        _check(c.usdgPricing.secondary, c.pins.usdgSecondary);
        configHash = digest;
        address owner = c.credit.guardian;
        c.credit.guardian = address(this);
        engine = new DockyardStockCreditEngine(c.credit, c.executionGate, c.usdgPricing);
        pool = new DockyardStockCapitalPool(
            IERC20Metadata(c.credit.usdg),
            c.credit.collateral,
            address(engine),
            c.treasury,
            c.debtLimit,
            c.revenueFeeBps,
            c.borrowAprBps
        );
        if (
            owner == address(engine) || owner == address(pool) || c.treasury == address(engine)
                || c.treasury == address(pool)
        ) revert InvalidDeployment();
        engine.bindPool(pool);
        engine.transferOwnership(owner);
        emit StockMarketDeployed(digest, c.credit.collateral, owner, address(engine), address(pool));
    }

    function _check(address target, bytes32 expected) private view {
        if (target.code.length == 0 || expected == bytes32(0) || target.codehash != expected) {
            revert DependencyMismatch(target);
        }
    }
}
