// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";
import {IDockyardExitPool, IDockyardExitFactory} from "./DockyardAtomicLiquidator.sol";
import {DockyardStockCreditEngine} from "./DockyardStockCreditEngine.sol";

/// @notice Atomic stock liquidation followed by a direct, pinned V3 sale to USDG.
/// @dev Caller funds repayment and receives only execution deltas. No owner,
/// arbitrary router, receiver override or sweep. Do not send tokens directly.
/// Profit bounds are after swap fees but before ETH gas and L1 data costs.
contract DockyardStockDirectLiquidator is ReentrancyGuard {
    using SafeERC20 for IERC20;

    DockyardStockCreditEngine public immutable engine;
    IERC20 public immutable usdg;
    IERC20 public immutable collateral;
    IDockyardExitPool public immutable salePool;
    IDockyardExitFactory public immutable factory;
    address public immutable executionGate;
    uint24 public immutable poolFee;
    bytes32 public immutable engineCodeHash;
    bytes32 public immutable poolCodeHash;
    bytes32 public immutable factoryCodeHash;
    bytes32 public immutable usdgCodeHash;
    bytes32 public immutable collateralCodeHash;
    bytes32 public immutable gateCodeHash;
    bool private immutable zeroForOne;
    bool private callbackActive;
    uint256 private callbackBudget;

    error InvalidConfiguration();
    error InvalidAmount();
    error Expired();
    error RouteChanged();
    error UnsupportedTransfer();
    error UnexpectedCallback();
    error IncompleteSwap();
    error InsufficientReturn();

    // Same event and entrypoint signatures as the two-hop executor so receipt
    // reconciliation does not infer a sale merely from a successful transaction.
    event LiquidationExited(
        address indexed borrower, address indexed keeper, uint256 paid, uint256 seized, uint256 usdgOut, uint256 profit
    );

    constructor(address engine_, address pool_, address factory_) {
        if (engine_.code.length == 0 || pool_.code.length == 0 || factory_.code.length == 0) {
            revert InvalidConfiguration();
        }
        engine = DockyardStockCreditEngine(engine_);
        address cash = address(engine.usdg());
        address token = address(engine.collateralToken());
        address gate = address(engine.executionGate());
        if (
            cash.code.length == 0 || token.code.length == 0 || cash == token || gate.code.length == 0
                || address(engine.stockGuard()).code.length == 0
        ) revert InvalidConfiguration();
        usdg = IERC20(cash);
        collateral = IERC20(token);
        executionGate = gate;
        salePool = IDockyardExitPool(pool_);
        factory = IDockyardExitFactory(factory_);
        poolFee = salePool.fee();
        zeroForOne = token < cash;
        if (!_venueMatches()) revert InvalidConfiguration();
        engineCodeHash = engine_.codehash;
        poolCodeHash = pool_.codehash;
        factoryCodeHash = factory_.codehash;
        usdgCodeHash = cash.codehash;
        collateralCodeHash = token.codehash;
        gateCodeHash = gate.codehash;
    }

    function _venueMatches() private view returns (bool) {
        return salePool.factory() == address(factory) && salePool.fee() == poolFee
            && salePool.token0() == (zeroForOne ? address(collateral) : address(usdg))
            && salePool.token1() == (zeroForOne ? address(usdg) : address(collateral))
            && factory.getPool(address(collateral), address(usdg), poolFee) == address(salePool);
    }

    /// @dev A reverted dependency read is also an unusable route. Runtime pins
    /// cannot by themselves detect upgrades behind unchanged proxy bytecode.
    function routeHealthy() public view returns (bool) {
        return address(engine).codehash == engineCodeHash && address(salePool).codehash == poolCodeHash
            && address(factory).codehash == factoryCodeHash && address(usdg).codehash == usdgCodeHash
            && address(collateral).codehash == collateralCodeHash && executionGate.codehash == gateCodeHash
            && _venueMatches();
    }

    function liquidateAndSellChecked(
        address borrower,
        uint256 maxRepay,
        uint256 minCollateral,
        uint256 minProfit,
        uint256 deadline,
        bytes calldata liveness
    ) external nonReentrant returns (uint256 paid, uint256 seized, uint256 usdgOut) {
        if (!routeHealthy()) revert RouteChanged();
        engine.priceWithLiveness(liveness);
        return _execute(borrower, maxRepay, minCollateral, minProfit, deadline);
    }

    /// @notice The engine enforces current execution liveness even on this path.
    function liquidateAndSell(
        address borrower,
        uint256 maxRepay,
        uint256 minCollateral,
        uint256 minProfit,
        uint256 deadline
    ) external nonReentrant returns (uint256 paid, uint256 seized, uint256 usdgOut) {
        return _execute(borrower, maxRepay, minCollateral, minProfit, deadline);
    }

    function _execute(address borrower, uint256 maxRepay, uint256 minCollateral, uint256 minProfit, uint256 deadline)
        private
        returns (uint256 paid, uint256 seized, uint256 usdgOut)
    {
        if (maxRepay == 0 || minCollateral == 0 || minProfit == 0) revert InvalidAmount();
        if (deadline < block.timestamp || deadline > block.timestamp + 5 minutes) revert Expired();
        if (!routeHealthy()) revert RouteChanged();
        uint256 cashBefore = usdg.balanceOf(address(this));
        uint256 stockBefore = collateral.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), maxRepay);
        if (usdg.balanceOf(address(this)) != cashBefore + maxRepay) revert UnsupportedTransfer();
        usdg.safeApprove(address(engine), maxRepay);
        (paid, seized) = engine.liquidate(borrower, maxRepay, minCollateral);
        usdg.safeApprove(address(engine), 0);
        if (
            paid == 0 || paid > maxRepay || seized < minCollateral
                || usdg.balanceOf(address(this)) != cashBefore + maxRepay - paid
                || collateral.balanceOf(address(this)) != stockBefore + seized
        ) revert UnsupportedTransfer();
        if (seized > uint256(type(int256).max)) revert InvalidAmount();
        uint256 swapCashBefore = usdg.balanceOf(address(this));
        callbackBudget = seized;
        callbackActive = true;
        salePool.swap(
            address(this),
            zeroForOne,
            int256(seized),
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
            ""
        );
        callbackActive = false;
        if (callbackBudget != 0 || collateral.balanceOf(address(this)) != stockBefore) revert IncompleteSwap();
        usdgOut = usdg.balanceOf(address(this)) - swapCashBefore;
        if (usdgOut < paid || usdgOut - paid < minProfit) revert InsufficientReturn();
        _sendExact(usdg, msg.sender, maxRepay - paid + usdgOut);
        if (usdg.balanceOf(address(this)) != cashBefore) revert UnsupportedTransfer();
        emit LiquidationExited(borrower, msg.sender, paid, seized, usdgOut, usdgOut - paid);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (!callbackActive || msg.sender != address(salePool) || callbackBudget == 0) revert UnexpectedCallback();
        int256 due = zeroForOne ? d0 : d1;
        if (due <= 0 || (zeroForOne ? d1 : d0) > 0 || uint256(due) > callbackBudget) revert UnexpectedCallback();
        callbackBudget -= uint256(due);
        _sendExact(collateral, msg.sender, uint256(due));
    }

    function _sendExact(IERC20 token, address to, uint256 amount) private {
        uint256 beforeSender = token.balanceOf(address(this));
        uint256 beforeRecipient = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(address(this)) != beforeSender - amount || token.balanceOf(to) != beforeRecipient + amount)
        {
            revert UnsupportedTransfer();
        }
    }
}
