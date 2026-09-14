import {pathToFileURL} from 'node:url';
import {createPublicClient,http,parseAbi,keccak256} from 'viem';
import {MANAGED_API3_USDG,inspectManagedApi3Usdg} from './inspect-api3-managed.mjs';
import {evaluateUsdgRounds} from './inspect-stock-usdg.mjs';
import {CHAINLINK_API3_HEARTBEAT_POLICY as policy} from './usdg-heartbeat-policy.mjs';

export const CHAINLINK_USDG=Object.freeze({
  proxy:'0x61B7e5650328764B076A108EFF5fa7282a1B9aD2',
  aggregator:'0x8bEeE3503F6860D5dac4cE26b5eEe92982951c2e',
});
const abi=parseAbi(['function aggregator() view returns(address)','function decimals() view returns(uint8)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const demand=(ok,message)=>{if(!ok)throw Error(message);};
export async function inspectChainlinkApi3({client,now=Date.now}){
  // API3 inspection checks chain, wall-clock freshness, native runtime, mapping,
  // purchase and reader agreement. Chainlink is read at that SAME block.
  const api3=await inspectManagedApi3Usdg({client,now,maxAgeSeconds:Number(policy.secondaryMaxAge)});
  const blockNumber=api3.blockNumber;
  const read=functionName=>client.readContract({address:CHAINLINK_USDG.proxy,abi,functionName,blockNumber});
  const [aggregator,decimals,round]=await Promise.all(['aggregator','decimals','latestRoundData'].map(read));
  demand(aggregator.toLowerCase()===CHAINLINK_USDG.aggregator.toLowerCase(),'Chainlink USDG aggregator changed');
  demand(Number(decimals)===8,'Chainlink USDG decimals changed');
  const pins={};
  for(const [key,address] of Object.entries(CHAINLINK_USDG)){
    const code=await client.getCode({address,blockNumber});
    demand(code&&code!=='0x','Missing Chainlink dependency');pins[key]=keccak256(code);
  }
  const t=api3.updatedAt;
  const pricing=evaluateUsdgRounds({rounds:[round,[t,api3.price18,t,t,t]],decimals:[8,18],timestamp:api3.blockTimestamp,...policy});
  const canonical=await client.getBlock({blockNumber});
  demand(canonical.hash===api3.blockHash,'Pair snapshot changed');
  const wall=BigInt(Math.floor(now()/1000));
  demand(api3.blockTimestamp<=wall+15n&&wall-api3.blockTimestamp<=60n,'Pair snapshot expired');
  return {chainId:4663,blockNumber,blockHash:api3.blockHash,blockTimestamp:api3.blockTimestamp,
    policy,chainlink:{...CHAINLINK_USDG,runtimeHashes:pins},api3:{server:MANAGED_API3_USDG.server,dataFeedId:MANAGED_API3_USDG.dataFeedId},
    pricing,productionApproved:false,broadcast:false,
    limitations:'Candidate heartbeat policy, not deployment approval. Different oracle operators do not prove independent upstream inputs. Chainlink proxy upgrades require monitoring. 25-hour budgets cannot detect a frozen source early; both sources can agree on old prices. Invalid/disagreeing prices halt liquidations as well as new risk. Stock health, liveness, usage rights, renewal, monitoring and liquidation readiness remain separate.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    demand(process.argv.length===2&&process.env.COLLATERAL_RPC_URL,'Explicit RPC required');
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:15000,retryCount:0}),cacheTime:0});
    const result=await inspectChainlinkApi3({client});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2));
    if(!result.pricing.engineRoundChecksPassed)process.exitCode=2;
  })().catch(()=>{console.error('Chainlink/API3 inspection failed. No transaction sent.');process.exitCode=1;});
}
