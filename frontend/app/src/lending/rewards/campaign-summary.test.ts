import { expect, test, vi } from 'vitest';
import { keccak256 } from 'viem';
import { campaignStatus, readCampaignSummary } from './campaign-summary';
import type { RewardsDeployment, RewardsReads } from './client';
const now=1_000_000;
const d={address:'0x1111111111111111111111111111111111111111',pool:'0x2222222222222222222222222222222222222222',administrator:'0x3333333333333333333333333333333333333333',runtimeHash:keccak256('0x1234'),budget:'1000'} as RewardsDeployment;
const data={start:900n,end:1100n,budget:1000n,finalized:false,expiresAt:now+120000};
const client=()=>({getChainId:vi.fn(async()=>4663),getBlock:vi.fn(async()=>({number:1n,hash:'0xabc',timestamp:1000n})),getCode:vi.fn(async()=>'0x1234'),readContract:vi.fn(async({functionName}:{functionName:string})=>({startsAt:900n,endsAt:1100n,campaignBudget:1000n,finalized:false})[functionName])});
test('campaign boundaries and finalization determine status',()=>{
 expect(campaignStatus(data,899999)).toBe('scheduled');expect(campaignStatus(data,900000)).toBe('active');expect(campaignStatus(data,1100000)).toBe('ended');expect(campaignStatus({...data,finalized:true},now)).toBe('stopped');expect(campaignStatus({...data,budget:0n},now)).toBe('unfunded');
});
test('reads a funded campaign at one canonical block',async()=>{
 const c=client();expect(await readCampaignSummary(c as unknown as RewardsReads,d,()=>now)).toEqual(data);expect(c.readContract.mock.calls.every(([args])=>(args as {blockNumber?:bigint}).blockNumber===1n)).toBe(true);
});
test('rejects stale, wrong-chain and wrong-contract data',async()=>{
 const c=client();c.getChainId.mockResolvedValue(1);await expect(readCampaignSummary(c as unknown as RewardsReads,d,()=>now)).rejects.toThrow();c.getChainId.mockResolvedValue(4663);c.getCode.mockResolvedValue('0x5678');await expect(readCampaignSummary(c as unknown as RewardsReads,d,()=>now)).rejects.toThrow();c.getCode.mockResolvedValue('0x1234');await expect(readCampaignSummary(c as unknown as RewardsReads,d,()=>now+120001)).rejects.toThrow();
});
test('rejects excess budget and reorgs',async()=>{
 const c=client();await expect(readCampaignSummary(c as unknown as RewardsReads,{...d,budget:'999'},()=>now)).rejects.toThrow();c.getBlock.mockResolvedValueOnce({number:1n,hash:'0xabc',timestamp:1000n}).mockResolvedValueOnce({number:1n,hash:'0xdef',timestamp:1000n});await expect(readCampaignSummary(c as unknown as RewardsReads,d,()=>now)).rejects.toThrow();
});
