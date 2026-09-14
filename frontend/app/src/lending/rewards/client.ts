import {getAddress,keccak256,parseAbi,type Address,type Hex,type PublicClient} from 'viem';
import manifest from './campaigns.json';
export const TURRET_REWARD_TOKEN=getAddress(manifest.rewardToken);
export type RewardsDeployment={pool:Address;address:Address;runtimeHash:Hex;administrator:Address;budget:string};
export const campaigns=manifest.deployments as RewardsDeployment[];
export const rewardsForPool=(pool:string)=>campaigns.find(d=>d.pool.toLowerCase()===pool.toLowerCase());
export const rewardsAbi=parseAbi([
 'function stakingToken() view returns(address)','function rewardToken() view returns(address)',
 'function administrator() view returns(address)','function lifetimeBudget() view returns(uint256)',
 'function totalStaked() view returns(uint256)','function stakedBalance(address) view returns(uint256)',
 'function earned(address) view returns(uint256)','function startsAt() view returns(uint256)',
 'function endsAt() view returns(uint256)','function campaignBudget() view returns(uint256)',
 'function finalized() view returns(bool)','function stake(uint256)','function unstake(uint256)','function claim()',
]);
export const shareAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function previewRedeem(uint256) view returns(uint256)']);
export type RewardsReads=Pick<PublicClient,'getChainId'|'getBlock'|'getCode'|'readContract'>;
export async function verifiedStakedShares(client:RewardsReads,deployment:RewardsDeployment,account:Address,blockNumber:bigint){
 const [chainId,code,stakingToken,rewardToken,admin,cap,shares]=await Promise.all([
  client.getChainId(),client.getCode({address:deployment.address,blockNumber}),
  client.readContract({address:deployment.address,abi:rewardsAbi,functionName:'stakingToken',blockNumber}),
  client.readContract({address:deployment.address,abi:rewardsAbi,functionName:'rewardToken',blockNumber}),
  client.readContract({address:deployment.address,abi:rewardsAbi,functionName:'administrator',blockNumber}),
  client.readContract({address:deployment.address,abi:rewardsAbi,functionName:'lifetimeBudget',blockNumber}),
  client.readContract({address:deployment.address,abi:rewardsAbi,functionName:'stakedBalance',args:[account],blockNumber}),
 ]);
 if(chainId!==4663||!code||keccak256(code)!==deployment.runtimeHash||getAddress(stakingToken)!==getAddress(deployment.pool)
  ||getAddress(rewardToken)!==TURRET_REWARD_TOKEN||getAddress(admin)!==getAddress(deployment.administrator)||cap!==BigInt(deployment.budget))throw Error('Rewards deployment verification failed.');
 return shares;
}
export async function readRewards(client:RewardsReads,d:RewardsDeployment,account:Address){
 const block=await client.getBlock();const blockNumber=block.number;
 if(blockNumber===null||!block.hash)throw Error('A mined rewards snapshot is unavailable.');
 const read=<T>(functionName:string,args:readonly unknown[]=[])=>client.readContract({address:d.address,abi:rewardsAbi,functionName,args,blockNumber} as never) as Promise<T>;
 const [staked,earned,totalStaked,start,end,budget,finalized,walletShares,allowance]=await Promise.all([
  verifiedStakedShares(client,d,account,blockNumber),read<bigint>('earned',[account]),read<bigint>('totalStaked'),
  read<bigint>('startsAt'),read<bigint>('endsAt'),read<bigint>('campaignBudget'),read<boolean>('finalized'),
  client.readContract({address:d.pool,abi:shareAbi,functionName:'balanceOf',args:[account],blockNumber}),
  client.readContract({address:d.pool,abi:shareAbi,functionName:'allowance',args:[account,d.address],blockNumber}),
 ]);
 const stakedAssets=staked===0n?0n:await client.readContract({address:d.pool,abi:shareAbi,functionName:'previewRedeem',args:[staked],blockNumber});
 if((await client.getBlock({blockNumber})).hash!==block.hash)throw Error('Rewards snapshot changed. Refresh and retry.');
 const acceptingStake=!finalized&&block.timestamp<end&&budget>0n;
 const active=!finalized&&block.timestamp>=start&&block.timestamp<end&&budget>0n;
 return {account,blockNumber,staked,stakedAssets,earned,totalStaked,start,end,budget,finalized,walletShares,allowance,active,acceptingStake,
  dailyEmission:acceptingStake?budget*86400n/(end-start):0n};
}
