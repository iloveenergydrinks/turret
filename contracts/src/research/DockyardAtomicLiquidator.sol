// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

interface IDockyardExitEngine {
    function usdg() external view returns (address);
    function collateralToken() external view returns (address);
    function liquidate(address, uint256, uint256) external returns (uint256, uint256);
}

interface IDockyardExitPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function factory() external view returns (address);
    function fee() external view returns (uint24);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IDockyardExitFactory {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice Research-only atomic USDG-funded liquidation and two-hop collateral sale.
/// @dev No owner, arbitrary call, recipient override or treasury withdrawal. Do not
/// send tokens directly: only caller-funded execution deltas are returned.
/// minProfit is after swap fees but BEFORE native gas and L1 data fees.
contract DockyardAtomicLiquidator is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IDockyardExitEngine public immutable engine;
    IERC20 public immutable usdg;
    IERC20 public immutable collateral;
    IERC20 public immutable intermediate;
    IDockyardExitPool public immutable firstPool;
    IDockyardExitPool public immutable secondPool;
    bytes32 public immutable engineCodeHash;
    bytes32 public immutable firstCodeHash;
    bytes32 public immutable secondCodeHash;
    address private callbackPool;
    IERC20 private callbackToken;
    uint256 private callbackBudget;

    error InvalidConfiguration();
    error InvalidAmount();
    error Expired();
    error RouteChanged();
    error UnsupportedTransfer();
    error UnexpectedCallback();
    error IncompleteSwap();
    error InsufficientReturn();

    event LiquidationExited(
        address indexed borrower, address indexed keeper, uint256 paid, uint256 seized, uint256 usdgOut, uint256 profit
    );

    constructor(address engine_, address intermediate_, address first_, address second_, address factory_) {
        if (
            engine_.code.length == 0 || intermediate_.code.length == 0 || factory_.code.length == 0 || first_ == second_
        ) {
            revert InvalidConfiguration();
        }
        engine = IDockyardExitEngine(engine_);
        address cash = engine.usdg();
        address token = engine.collateralToken();
        if (
            cash.code.length == 0 || token.code.length == 0 || cash == token || cash == intermediate_
                || token == intermediate_
        ) {
            revert InvalidConfiguration();
        }
        _validatePool(first_, factory_, token, intermediate_);
        _validatePool(second_, factory_, intermediate_, cash);
        usdg = IERC20(cash);
        collateral = IERC20(token);
        intermediate = IERC20(intermediate_);
        firstPool = IDockyardExitPool(first_);
        secondPool = IDockyardExitPool(second_);
        engineCodeHash = engine_.codehash;
        firstCodeHash = first_.codehash;
        secondCodeHash = second_.codehash;
    }

    function _validatePool(address venue, address factory, address a, address b) private view {
        if (venue.code.length == 0) revert InvalidConfiguration();
        IDockyardExitPool p = IDockyardExitPool(venue);
        if (
            p.factory() != factory || p.token0() != (a < b ? a : b) || p.token1() != (a < b ? b : a)
                || IDockyardExitFactory(factory).getPool(a, b, p.fee()) != venue
        ) revert InvalidConfiguration();
    }

    function routeHealthy() public view returns (bool) {
        return address(engine).codehash == engineCodeHash && address(firstPool).codehash == firstCodeHash
            && address(secondPool).codehash == secondCodeHash;
    }

    function liquidateAndSell(
        address borrower,
        uint256 maxRepay,
        uint256 minCollateral,
        uint256 minProfit,
        uint256 deadline
    ) public nonReentrant returns (uint256 paid, uint256 seized, uint256 usdgOut) {
        if (maxRepay == 0 || minCollateral == 0 || minProfit == 0) revert InvalidAmount();
        if (deadline < block.timestamp || deadline > block.timestamp + 5 minutes) revert Expired();
        if (!routeHealthy()) revert RouteChanged();
        uint256 cashBefore = usdg.balanceOf(address(this));
        uint256 collateralBefore = collateral.balanceOf(address(this));
        uint256 intermediateBefore = intermediate.balanceOf(address(this));
        usdg.safeTransferFrom(msg.sender, address(this), maxRepay);
        if (usdg.balanceOf(address(this)) != cashBefore + maxRepay) revert UnsupportedTransfer();
        usdg.safeApprove(address(engine), maxRepay);
        (paid, seized) = engine.liquidate(borrower, maxRepay, minCollateral);
        usdg.safeApprove(address(engine), 0);
        if (
            paid == 0 || paid > maxRepay || seized < minCollateral
                || usdg.balanceOf(address(this)) != cashBefore + maxRepay - paid
                || collateral.balanceOf(address(this)) != collateralBefore + seized
        ) revert UnsupportedTransfer();
        uint256 middleOut = _swap(firstPool, collateral, intermediate, seized);
        usdgOut = _swap(secondPool, intermediate, usdg, middleOut);
        if (usdgOut < paid || usdgOut - paid < minProfit) revert InsufficientReturn();
        if (
            collateral.balanceOf(address(this)) != collateralBefore
                || intermediate.balanceOf(address(this)) != intermediateBefore
        ) revert IncompleteSwap();
        _sendExact(usdg, msg.sender, maxRepay - paid + usdgOut);
        if (usdg.balanceOf(address(this)) != cashBefore) revert UnsupportedTransfer();
        emit LiquidationExited(borrower, msg.sender, paid, seized, usdgOut, usdgOut - paid);
    }

    function _swap(IDockyardExitPool venue, IERC20 input, IERC20 output, uint256 amount)
        private
        returns (uint256 received)
    {
        if (amount == 0 || amount > uint256(type(int256).max) || callbackPool != address(0)) {
            revert InvalidAmount();
        }
        uint256 beforeInput = input.balanceOf(address(this));
        uint256 beforeOutput = output.balanceOf(address(this));
        callbackPool = address(venue);
        callbackToken = input;
        callbackBudget = amount;
        bool zeroForOne = venue.token0() == address(input);
        venue.swap(
            address(this),
            zeroForOne,
            int256(amount),
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341),
            ""
        );
        if (callbackBudget != 0 || input.balanceOf(address(this)) != beforeInput - amount) revert IncompleteSwap();
        callbackPool = address(0);
        callbackToken = IERC20(address(0));
        received = output.balanceOf(address(this)) - beforeOutput;
        if (received == 0) revert IncompleteSwap();
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (msg.sender != callbackPool || callbackPool == address(0) || callbackBudget == 0) {
            revert UnexpectedCallback();
        }
        bool zero = IDockyardExitPool(msg.sender).token0() == address(callbackToken);
        int256 due = zero ? d0 : d1;
        if (due <= 0 || (zero ? d1 : d0) > 0 || uint256(due) > callbackBudget) revert UnexpectedCallback();
        callbackBudget -= uint256(due);
        _sendExact(callbackToken, msg.sender, uint256(due));
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
