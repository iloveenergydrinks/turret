// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test,console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
interface LiquidityProbePool {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256);
}
interface LiquidityProbeOracle {function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80);}

/// @notice Real pool/token bytecode on a fork; synthetic input inventory only.
/// No price, transfer restrictions, pool liquidity or swap implementation is changed.
contract DockyardStockLiquidityTest is Test {
    address constant USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address activePool;
    address activeToken;
    uint256 activeLimit;
    function uniswapV3SwapCallback(int256 a,int256 b,bytes calldata) external {
        require(msg.sender==activePool,"Pool only");
        uint256 owed=uint256(a>0?a:b);require(owed<=activeLimit,"Input limit");
        require(IERC20(activeToken).transfer(msg.sender,owed),"Transfer failed");
    }
    function testDirectStockSalesAtFiftyUSDGSize() external {
        uint256 forkBlock=vm.envOr("FORK_BLOCK",uint256(0));
        if(forkBlock==0)vm.createSelectFork(vm.envString("FORK_RPC_URL"));
        else vm.createSelectFork(vm.envString("FORK_RPC_URL"),forkBlock);
        string memory manifest=vm.readFile("./utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json");
        string memory pools=vm.readFile("./utils/assets/oracle-fixtures/stock-pool-discovery.json");
        for(uint256 i;i<10;i++){
            string memory p=string.concat(".markets[",vm.toString(i),"]");
            address token=vm.parseJsonAddress(manifest,string.concat(p,".collateral"));
            address feed=vm.parseJsonAddress(manifest,string.concat(p,".primaryOracle"));
            (,int256 answer,,,)=LiquidityProbeOracle(feed).latestRoundData();require(answer>0);
            uint256 input=50e18*1e8/uint256(answer);
            uint256 poolCount=vm.parseJsonUint(pools,string.concat(p,".poolCount"));
            uint256 best;
            for(uint256 j;j<poolCount;j++){
                if(vm.parseJsonAddress(pools,string.concat(p,".pools[",vm.toString(j),"].base"))!=USDG)continue;
                uint256 snapshot=vm.snapshot();
                address pool=vm.parseJsonAddress(pools,string.concat(p,".pools[",vm.toString(j),"].pool"));
                activePool=pool;activeToken=token;activeLimit=input;
                bool zeroForOne=LiquidityProbePool(pool).token0()==token;
                require(zeroForOne?LiquidityProbePool(pool).token1()==USDG:LiquidityProbePool(pool).token0()==USDG,"Pair");
                deal(token,address(this),input);
                try LiquidityProbePool(pool).swap{gas:500000}(address(this),zeroForOne,int256(input),zeroForOne?4295128740:1461446703485210103287273052203988822378723970341,"") returns(int256,int256){
                    uint256 output=IERC20(USDG).balanceOf(address(this));
                    if(output>best)best=output;
                }catch{}
                require(vm.revertTo(snapshot));
            }
            console2.log(vm.parseJsonString(manifest,string.concat(p,".symbol")),best);
        }
        console2.log("Fork block",block.number);
    }
}
