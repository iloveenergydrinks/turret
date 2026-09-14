// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {TurretFeeRouter} from "../src/TurretFeeRouter.sol";
import {TurretStaking} from "../src/TurretStaking.sol";
import {StakingTokenFixture} from "./TurretStaking.t.sol";

contract RouterCallbackUSDG is ERC20 {
    address public router;
    address public pool;
    uint256 public callbackStages;
    bool public blockStakingFunding;
    address public blockedSender;
    constructor() ERC20("USDG", "USDG") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function configure(address r, address p) external { router = r; pool = p; }
    function blockFunding(address sender, bool enabled) external { blockedSender = sender; blockStakingFunding = enabled; }
    function _transfer(address from, address to, uint256 amount) internal override {
        if (blockStakingFunding && from == blockedSender) revert("USDG funding blocked");
        super._transfer(from, to, amount);
        if (router != address(0)) {
            (bool ok, bytes memory result) = router.call(abi.encodeCall(TurretFeeRouter.collect, (pool)));
            require(!ok && keccak256(result) == keccak256(abi.encodeWithSignature("Error(string)", "ReentrancyGuard: reentrant call")), "Unexpected callback result");
            callbackStages |= from == pool ? 1 : to == router ? 2 : 4;
        }
    }
}
contract AdversarialRevenuePool {
    RouterCallbackUSDG public asset;
    address public feeRecipient;
    uint256 public protocolFees;
    uint256 public paid;
    constructor(RouterCallbackUSDG u, address treasury) { asset = u; feeRecipient = treasury; }
    function queue(uint256 reported, uint256 actual) external { protocolFees = reported; paid = actual; asset.mint(address(this), actual); }
    function claimRevenue() external { protocolFees = 0; asset.transfer(feeRecipient, paid); paid = 0; }
}
contract TurretFeeRouterSafetyTest is Test {
    StakingTokenFixture token;
    RouterCallbackUSDG usdg;
    AdversarialRevenuePool pool;
    TurretFeeRouter router;
    TurretStaking staking;
    address treasury = address(0x7777);
    function setUp() public {
        token = new StakingTokenFixture("TURRET"); usdg = new RouterCallbackUSDG();
        pool = new AdversarialRevenuePool(usdg, treasury);
        address[] memory pools = new address[](1); pools[0] = address(pool);
        router = new TurretFeeRouter(token, usdg, treasury, pools); staking = router.staking();
        token.mint(address(this), 100e18); token.approve(address(staking), 100e18); staking.stake(100e18);
        vm.prank(treasury); usdg.approve(address(router), type(uint256).max);
    }
    function testCallbacksCannotReenterAtAnyStageOfCollection() public {
        pool.queue(10e6, 10e6); usdg.configure(address(router), address(pool));
        router.collect(address(pool));
        assertEq(usdg.callbackStages(), 7);
        assertEq(router.totalCollected(), 10e6); assertEq(staking.earned(address(this)), 5e6);
        assertEq(usdg.balanceOf(treasury), 5e6); assertEq(usdg.balanceOf(address(router)), 0);
    }
    function testClaimedFeeMismatchRevertsEvenWithExistingTreasuryBalance() public {
        usdg.mint(treasury, 100e6); pool.queue(10e6, 9e6);
        vm.expectRevert(TurretFeeRouter.UnsupportedTransfer.selector); router.collect(address(pool));
        assertEq(pool.protocolFees(), 10e6); assertEq(usdg.balanceOf(treasury), 100e6);
        assertEq(router.totalCollected(), 0); assertEq(staking.totalFunded(), 0);
    }
    function testFundingFailureRollsBackPoolTreasuryAndAllCounters() public {
        pool.queue(10e6, 10e6); usdg.blockFunding(address(router), true);
        vm.expectRevert("USDG funding blocked"); router.collect(address(pool));
        assertEq(pool.protocolFees(), 10e6); assertEq(usdg.balanceOf(address(pool)), 10e6);
        assertEq(usdg.balanceOf(treasury), 0); assertEq(usdg.balanceOf(address(router)), 0);
        assertEq(router.totalCollected(), 0); assertEq(router.totalDistributed(), 0);
        assertEq(staking.totalFunded(), 0);
        usdg.blockFunding(address(router), false); router.collect(address(pool));
        assertEq(staking.earned(address(this)), 5e6);
    }
    function testRouterDonationsAreNotPulledIntoACollection() public {
        usdg.mint(address(router), 123); pool.queue(10e6, 10e6); router.collect(address(pool));
        assertEq(usdg.balanceOf(address(router)), 123); assertEq(staking.totalFunded(), 5e6);
    }
    function testDuplicatePoolRejectedAtConstruction() public {
        address[] memory pools = new address[](2); pools[0] = address(pool); pools[1] = address(pool);
        vm.expectRevert(TurretFeeRouter.InvalidConfiguration.selector);
        new TurretFeeRouter(token, usdg, treasury, pools);
    }
    function testWrongTreasuryAndWrongAssetRejectedAtConstruction() public {
        address[] memory pools = new address[](1); pools[0] = address(pool);
        vm.expectRevert(TurretFeeRouter.InvalidConfiguration.selector);
        new TurretFeeRouter(token, usdg, address(0x8888), pools);
        RouterCallbackUSDG other = new RouterCallbackUSDG();
        vm.expectRevert(TurretFeeRouter.InvalidConfiguration.selector);
        new TurretFeeRouter(token, other, treasury, pools);
    }
}
