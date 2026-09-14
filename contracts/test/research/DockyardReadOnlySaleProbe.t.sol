// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {DockyardReadOnlySaleProbe} from "../../src/research/DockyardReadOnlySaleProbe.sol";

contract ProbeTestToken is ERC20 {
    bool public blocked;
    constructor() ERC20("Fixture", "FIX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(bool value) external { blocked = value; }
    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!blocked, "TokenPaused");
        return super.transfer(to, amount);
    }
}
contract ProbeTestPool {
    address public token0;
    address public token1;
    uint256 public fillBps = 10000;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function setFill(uint256 bps) external { fillBps = bps; }
    function swap(address to, bool zeroForOne, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        require(zeroForOne, "Direction");
        uint256 paid = uint256(amount) * fillBps / 10000;
        uint256 out = paid * 100 / 1e12;
        ProbeTestToken(token1).transfer(to, out);
        DockyardReadOnlySaleProbe(msg.sender).uniswapV3SwapCallback(int256(paid), -int256(out), "");
        return (int256(paid), -int256(out));
    }
}
contract ProbeTestRoute {
    address public immutable engine;
    address public immutable salePool;
    address public immutable factory;
    uint24 public constant poolFee = 500;
    constructor(address engine_, address salePool_, address factory_) {
        engine = engine_; salePool = salePool_; factory = factory_;
    }
    function routeHealthy() external pure returns (bool) { return true; }
}
contract DockyardReadOnlySaleProbeTest is Test {
    ProbeTestToken stock;
    ProbeTestToken cash;
    ProbeTestPool venue;
    DockyardReadOnlySaleProbe probe;
    function setUp() public {
        stock = new ProbeTestToken(); cash = new ProbeTestToken();
        venue = new ProbeTestPool(address(stock), address(cash));
        address executor = address(0x123456);
        vm.etch(executor, address(new DockyardReadOnlySaleProbe()).code);
        probe = DockyardReadOnlySaleProbe(executor);
        // Only caller inventory is synthetic, exactly as in the eth_call probe.
        vm.store(address(stock), keccak256(abi.encode(executor, uint256(0))), bytes32(uint256(1 ether)));
        cash.mint(address(venue), 1000e6);
    }
    function testFullSaleExecutesBothTokenTransfers() public {
        assertEq(probe.sell(address(venue), address(stock), address(cash), 0.525 ether), 52.5e6);
        assertEq(stock.balanceOf(address(probe)), 0.475 ether);
        assertEq(stock.balanceOf(address(venue)), 0.525 ether);
        assertEq(cash.balanceOf(address(probe)), 52.5e6);
    }
    function testPartialSaleRevertsAtomically() public {
        venue.setFill(5000);
        vm.expectRevert("IncompleteSale");
        probe.sell(address(venue), address(stock), address(cash), 0.525 ether);
        assertEq(stock.balanceOf(address(probe)), 1 ether);
        assertEq(cash.balanceOf(address(venue)), 1000e6);
    }
    function testRealTokenPauseIsNotOverridden() public {
        stock.setBlocked(true);
        vm.expectRevert("TokenPaused");
        probe.sell(address(venue), address(stock), address(cash), 0.525 ether);
    }
    function testInsufficientPoolCashRejects() public {
        vm.expectRevert();
        probe.sell(address(venue), address(stock), address(cash), 20 ether);
    }
    function testUnsolicitedCallbackAndWrongPairReject() public {
        vm.expectRevert("UnexpectedCallback");probe.uniswapV3SwapCallback(1, -1, "");
        vm.expectRevert("WrongPair");probe.sell(address(venue), address(stock), address(0x42), 1 ether);
    }
}
