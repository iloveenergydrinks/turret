// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/security/ReentrancyGuard.sol";

interface IBurnableTurret is IERC20 { function burn(uint256 amount) external; }
interface IBuybackKyber {
    struct Description {
        address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts;
        address[] feeReceivers; uint256[] feeAmounts; address dstReceiver;
        uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit;
    }
    struct Execution { address callTarget; address approveTarget; bytes targetData; Description desc; bytes clientData; }
    function swap(Execution calldata execution) external payable returns (uint256 returnAmount, uint256 gasUsed);
}

/// @notice Dev-funded hourly purchases with atomic, supply-reducing TURRET burns.
/// @dev 6.7% hourly decay of the wallet balance ABOVE 100 USDG, sampled once per hour.
/// No catch-up spending after downtime; fee distribution and staking are separate.
contract TurretBuybackBurn is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant HOURLY_RATE = 67000000000000000;
    uint256 public constant RATE_SCALE = 1e18;
    uint256 public constant reserveFloor = 100e6;
    uint256 public constant cooldown = 1 hours;
    IERC20 public immutable usdg;
    IBurnableTurret public immutable turret;
    address public immutable treasury;
    address public immutable swapRouter;
    address public immutable swapTarget;
    bytes32 public immutable usdgHash;
    bytes32 public immutable turretHash;
    bytes32 public immutable routerHash;
    bytes32 public immutable targetHash;
    address public keeper;
    bool public paused = true;
    uint256 public minTokensPerUSDG;
    uint256 public totalSpent;
    uint256 public totalBurned;
    uint256 public lastBuyback;
    error Unauthorized();
    error InvalidConfiguration();
    error Unavailable();
    error InvalidSwap();
    error InvalidSettlement();
    event Configured(address keeper, uint256 minTokensPerUSDG);
    event Paused(bool paused);
    event BoughtAndBurned(uint256 usdgSpent, uint256 turretBurned, uint256 timestamp);

    constructor(IERC20 stable, IBurnableTurret token, address wallet, address router, address target) {
        if (block.chainid != 4663 || address(stable).code.length == 0 || address(token).code.length == 0
            || wallet == address(0) || router.code.length == 0 || target.code.length == 0
            || address(stable) == address(token)) revert InvalidConfiguration();
        usdg = stable; turret = token; treasury = wallet;
        swapRouter = router; swapTarget = target;
        usdgHash = address(stable).codehash; turretHash = address(token).codehash;
        routerHash = router.codehash; targetHash = target.codehash;
    }
    modifier onlyTreasury() { if (msg.sender != treasury) revert Unauthorized(); _; }

    /// @notice Changing operator or minimum exchange rate pauses the module.
    /// minRate is TURRET base units per one USDG, an additional owner-controlled price guard.
    function configure(address operator, uint256 minRate) external onlyTreasury {
        if (operator == address(0) || minRate == 0) revert InvalidConfiguration();
        keeper = operator; minTokensPerUSDG = minRate; paused = true;
        emit Configured(operator, minRate); emit Paused(true);
    }
    function setPaused(bool value) external onlyTreasury {
        if (!value && keeper == address(0)) revert InvalidConfiguration();
        // Resume cannot create a second purchase inside the last purchase's hourly window.
        if (paused && !value && lastBuyback == 0) lastBuyback = block.timestamp;
        paused = value; emit Paused(value);
    }
    function availableBudget() public view returns (uint256) {
        if (paused || block.timestamp < lastBuyback + cooldown) return 0;
        uint256 balance = usdg.balanceOf(treasury);
        if (balance <= reserveFloor) return 0;
        return Math.min(Math.mulDiv(balance - reserveFloor, HOURLY_RATE, RATE_SCALE), usdg.allowance(treasury, address(this)));
    }
    function minimumReturn(uint256 amount) public view returns (uint256) {
        return Math.mulDiv(amount, minTokensPerUSDG, 1e6, Math.Rounding.Up);
    }
    function execute(IBuybackKyber.Execution calldata execution, uint256 deadline) external nonReentrant {
        if (msg.sender != keeper) revert Unauthorized();
        if (deadline < block.timestamp || deadline > block.timestamp + 120 || block.chainid != 4663) revert Unavailable();
        if (address(usdg).codehash != usdgHash
            || address(turret).codehash != turretHash || swapRouter.codehash != routerHash
            || swapTarget.codehash != targetHash) revert Unavailable();
        IBuybackKyber.Description calldata d = execution.desc;
        if (d.amount == 0 || d.amount > availableBudget()) revert Unavailable();
        if (execution.callTarget != swapTarget || execution.approveTarget != address(0)
            || execution.targetData.length < 4 || execution.targetData.length > 65536 || execution.clientData.length > 4096
            || d.srcToken != address(usdg) || d.dstToken != address(turret) || d.dstReceiver != address(this)
            || d.minReturnAmount == 0 || d.minReturnAmount < minimumReturn(d.amount)
            || d.flags != 512 || d.permit.length != 0 || d.feeReceivers.length != 0 || d.feeAmounts.length != 0
            || d.srcReceivers.length == 0 || d.srcReceivers.length > 32 || d.srcAmounts.length != d.srcReceivers.length) revert InvalidSwap();
        uint256 sum;
        for (uint256 i; i < d.srcAmounts.length; ++i) {
            if (d.srcReceivers[i] != swapTarget || d.srcAmounts[i] == 0) revert InvalidSwap();
            sum += d.srcAmounts[i];
        }
        if (sum != d.amount) revert InvalidSwap();
        uint256 beforeTreasury = usdg.balanceOf(treasury);
        uint256 beforeUSDG = usdg.balanceOf(address(this));
        uint256 beforeToken = turret.balanceOf(address(this));
        totalSpent += d.amount; lastBuyback = block.timestamp;
        usdg.safeTransferFrom(treasury, address(this), d.amount);
        if (usdg.balanceOf(address(this)) != beforeUSDG + d.amount
            || usdg.balanceOf(treasury) != beforeTreasury - d.amount) revert InvalidSettlement();
        usdg.safeApprove(swapRouter, d.amount);
        IBuybackKyber(swapRouter).swap(execution);
        usdg.safeApprove(swapRouter, 0);
        if (usdg.balanceOf(address(this)) != beforeUSDG || usdg.balanceOf(treasury) != beforeTreasury - d.amount) revert InvalidSettlement();
        uint256 bought = turret.balanceOf(address(this)) - beforeToken;
        if (bought < d.minReturnAmount) revert InvalidSettlement();
        uint256 supply = turret.totalSupply();
        turret.burn(bought);
        if (turret.balanceOf(address(this)) != beforeToken || turret.totalSupply() != supply - bought) revert InvalidSettlement();
        totalBurned += bought;
        emit BoughtAndBurned(d.amount, bought, block.timestamp);
    }
}
