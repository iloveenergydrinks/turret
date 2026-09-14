import {keccak256,parseAbi} from 'viem';
const abi=parseAbi([
  'function staking() view returns(address)','function stakingToken() view returns(address)',
  'function rewardToken() view returns(address)','function distributor() view returns(address)',
  'function treasury() view returns(address)','function STAKER_SHARE_BPS() view returns(uint256)',
  'function STREAM_VERSION() view returns(uint256)','function DAILY_RELEASE_BPS() view returns(uint256)','function RETENTION_PER_SECOND() view returns(uint256)',
  'function poolCount() view returns(uint256)','function pools(uint256) view returns(address)',
  'function poolCodeHash(address) view returns(bytes32)','function asset() view returns(address)',
  'function feeRecipient() view returns(address)','function revenueFeeBps() view returns(uint16)',
]);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
export async function verifyDeployment(client,peer,m,p) {
  const [chain,peerChain,a,b]=await Promise.all([client.getChainId(),peer.getChainId(),client.getBlock(),peer.getBlock()]);
  if(chain!==4663||peerChain!==4663)throw Error('chain_mismatch');
  const number=a.number<b.number?a.number:b.number;
  if(number<BigInt(m.deployment.startBlock))throw Error('deployment_block_unavailable');
  const [head,other]=await Promise.all([client.getBlock({blockNumber:number}),peer.getBlock({blockNumber:number})]);
  if(head.hash!==other.hash||Math.abs(Date.now()/1000-Number(head.timestamp))>60)throw Error('rpc_disagreement_or_stale_head');
  const d=m.deployment;
  if(!same(m.stakingToken,p.stakingToken)||!same(m.rewardToken,p.rewardToken)||!same(m.treasury,p.treasury))throw Error('manifest_identity_mismatch');
  const read=(address,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:number});
  const code=async(address,hash)=>{const runtime=await client.getCode({address,blockNumber:number});if(!runtime||keccak256(runtime)!==hash)throw Error('runtime_mismatch');};
  const expect=async(address,method,expected,args=[])=>{if(!same(await read(address,method,args),expected))throw Error('immutable_identity_mismatch');};
  await Promise.all([
    code(d.router,d.routerRuntimeHash),code(d.address,d.runtimeHash),code(m.stakingToken,p.stakingTokenHash),code(m.rewardToken,p.rewardTokenHash),
    expect(d.router,'staking',d.address),expect(d.router,'rewardToken',m.rewardToken),expect(d.router,'treasury',m.treasury),expect(d.router,'STAKER_SHARE_BPS',5000n),
    expect(d.address,'stakingToken',m.stakingToken),expect(d.address,'rewardToken',m.rewardToken),expect(d.address,'distributor',d.router),expect(d.router,'poolCount',BigInt(p.pools.length)),
    ...p.pools.flatMap((pool,i)=>[
      code(pool,p.poolHashes[i]),expect(d.router,'pools',pool,[BigInt(i)]),expect(d.router,'poolCodeHash',p.poolHashes[i],[pool]),
      expect(pool,'asset',m.rewardToken),expect(pool,'feeRecipient',m.treasury),expect(pool,'revenueFeeBps',1000),
    ]),
  ]);
  if(d.rewardModel) await Promise.all([
    expect(d.address,'STREAM_VERSION',d.rewardModel==='reserve-decay-v2'?2n:1n),expect(d.address,'DAILY_RELEASE_BPS',100n),
    expect(d.address,'RETENTION_PER_SECOND',999999883676675127810317475n),
  ]);
  if(d.rewardModel==='reserve-decay-v2') await expect(d.address,'treasury',m.treasury);
  // Pin the reviewed USDG proxy implementation too; proxy runtime alone does
  // not detect issuer upgrades. An upgrade requires a new review before restart.
  const implementation=await client.getStorageAt({address:m.rewardToken,slot:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',blockNumber:number});
  if(!implementation||!same('0x'+implementation.slice(-40),p.usdgImplementation))throw Error('usdg_implementation_changed');
  await code(p.usdgImplementation,p.usdgImplementationHash);
  if((await client.getBlock({blockNumber:number})).hash!==head.hash)throw Error('verification_reorg');
  return head;
}
