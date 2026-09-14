import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {verifyDeployment} from '../src/verify.mjs';
const addr=n=>'0x'+String(n).padStart(40,'0'),code='0x1234',hash=keccak256(code),blockHash='0x'+'ab'.repeat(32);
function fixture(){
  const m={stakingToken:addr(1),rewardToken:addr(2),treasury:addr(3),deployment:{router:addr(4),address:addr(5),startBlock:'1',routerRuntimeHash:hash,runtimeHash:hash}};
  const p={...m,pools:[addr(6)],poolHashes:[hash],stakingTokenHash:hash,rewardTokenHash:hash,usdgImplementation:addr(7),usdgImplementationHash:hash};
  const head={number:100n,hash:blockHash,timestamp:BigInt(Math.floor(Date.now()/1000))};
  const client={getChainId:async()=>4663,getBlock:async()=>head,getCode:async()=>code,getStorageAt:async()=>'0x'+'0'.repeat(24)+addr(7).slice(2),
    readContract:async({functionName})=>({staking:addr(5),stakingToken:addr(1),rewardToken:addr(2),distributor:addr(4),treasury:addr(3),STAKER_SHARE_BPS:5000n,poolCount:1n,pools:addr(6),poolCodeHash:hash,asset:addr(2),feeRecipient:addr(3),revenueFeeBps:1000}[functionName])};
  return {m,p,head,client,peer:{...client}};
}
test('verification pins chain, all runtime, pool identity and proxy implementation',async()=>{const f=fixture();assert.equal((await verifyDeployment(f.client,f.peer,f.m,f.p)).number,100n);});
for(const[name,mutate,reason]of[
  ['wrong chain',f=>f.peer.getChainId=async()=>1,/chain_mismatch/],
  ['different fork',f=>f.peer.getBlock=async()=>({...f.head,hash:'other'}),/rpc_disagreement/],
  ['stale head',f=>f.head.timestamp-=100n,/stale_head/],
  ['runtime change',f=>f.client.getCode=async()=>'0x99',/runtime_mismatch/],
  ['wrong fee share',f=>{const read=f.client.readContract;f.client.readContract=async args=>args.functionName==='STAKER_SHARE_BPS'?4000n:read(args);},/identity_mismatch/],
  ['pool recipient change',f=>{const read=f.client.readContract;f.client.readContract=async args=>args.functionName==='feeRecipient'?addr(9):read(args);},/identity_mismatch/],
  ['proxy upgrade',f=>f.client.getStorageAt=async()=>'0x'+'0'.repeat(64),/implementation_changed/],
  ['manifest tampering',f=>f.m.treasury=addr(9),/manifest_identity_mismatch/],
])test(name+' prevents collection',async()=>{const f=fixture();mutate(f);await assert.rejects(verifyDeployment(f.client,f.peer,f.m,f.p),reason);});

test('streaming verification checks the immutable release model',async()=>{
  const f=fixture();f.m.deployment.rewardModel='reserve-decay-v1';const read=f.client.readContract;
  f.client.readContract=async args=>({STREAM_VERSION:1n,DAILY_RELEASE_BPS:100n,RETENTION_PER_SECOND:999999883676675127810317475n}[args.functionName]??read(args));
  await verifyDeployment(f.client,f.peer,f.m,f.p);
  const valid=f.client.readContract;f.client.readContract=async args=>args.functionName==='DAILY_RELEASE_BPS'?200n:valid(args);
  await assert.rejects(verifyDeployment(f.client,f.peer,f.m,f.p),/identity_mismatch/);
});

test('recovery treasury and v2 version are pinned before collecting',async()=>{
  const f=fixture();f.m.deployment.rewardModel='reserve-decay-v2';const read=f.client.readContract;
  f.client.readContract=async args=>({STREAM_VERSION:2n,DAILY_RELEASE_BPS:100n,RETENTION_PER_SECOND:999999883676675127810317475n}[args.functionName]??read(args));
  await verifyDeployment(f.client,f.peer,f.m,f.p);
  const valid=f.client.readContract;f.client.readContract=async args=>args.address===f.m.deployment.address&&args.functionName==='treasury'?addr(9):valid(args);
  await assert.rejects(verifyDeployment(f.client,f.peer,f.m,f.p),/identity_mismatch/);
});
