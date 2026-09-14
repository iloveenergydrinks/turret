import {describe,it,expect,vi} from 'vitest';
import {keccak256,type Address} from 'viem';
import {readRewards,verifiedStakedShares,TURRET_REWARD_TOKEN,type RewardsReads,type RewardsDeployment} from './client';
const account='0x1111111111111111111111111111111111111111' as Address;
const d:RewardsDeployment={pool:'0x2222222222222222222222222222222222222222',address:'0x3333333333333333333333333333333333333333',administrator:account,runtimeHash:keccak256('0x6000'),budget:'1000'};
function setup(){
 const values:Record<string,unknown>={stakingToken:d.pool,rewardToken:TURRET_REWARD_TOKEN,administrator:account,lifetimeBudget:1000n,stakedBalance:5n,earned:3n,totalStaked:10n,startsAt:100n,endsAt:200n,campaignBudget:1000n,finalized:false,balanceOf:4n,allowance:4n,previewRedeem:7n};
 const mocks={getChainId:vi.fn(async()=>4663),getCode:vi.fn(async()=>'0x6000'),getBlock:vi.fn(async()=>({number:1n,hash:keccak256('0x01'),timestamp:150n})),readContract:vi.fn(async({functionName}:{functionName:string})=>values[functionName])};
 return {values,mocks,client:mocks as unknown as RewardsReads};
}
describe('verified rewards snapshots',()=>{
 it('pins all reads and verifies code, identity, and canonical block',async()=>{const {client,mocks}=setup();expect(await readRewards(client,d,account)).toMatchObject({staked:5n,stakedAssets:7n,earned:3n,active:true});for(const [arg] of mocks.readContract.mock.calls)expect(arg).toHaveProperty('blockNumber',1n);});
 it('allows pre-staking without early accrual',async()=>{const {client,values}=setup();values.startsAt=160n;values.earned=0n;expect(await readRewards(client,d,account)).toMatchObject({active:false,acceptingStake:true,earned:0n});});
 it('rejects changed deployment identities and reorgs',async()=>{for(const field of ['stakingToken','rewardToken','administrator','lifetimeBudget','code','chain','block']){const {client,mocks,values}=setup();if(field==='code')mocks.getCode.mockResolvedValue('0x00');else if(field==='chain')mocks.getChainId.mockResolvedValue(1);else if(field==='block')mocks.getBlock.mockResolvedValueOnce({number:1n,hash:keccak256('0x01'),timestamp:150n}).mockResolvedValue({number:1n,hash:keccak256('0x02'),timestamp:150n});else values[field]=field==='lifetimeBudget'?999n:d.address;await expect(readRewards(client,d,account)).rejects.toThrow();}});
 it('returns staked shares even after rewards end; read failure is not zero',async()=>{const {client,mocks,values}=setup();values.finalized=true;expect(await readRewards(client,d,account)).toMatchObject({active:false,staked:5n,earned:3n});mocks.readContract.mockRejectedValueOnce(Error('RPC unavailable'));await expect(verifiedStakedShares(client,d,account,1n)).rejects.toThrow('RPC unavailable');});
});
