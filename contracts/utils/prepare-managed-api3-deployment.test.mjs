import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeAbiParameters,parseAbiParameters} from 'viem';
import {managedApi3Creation,prepareManagedApi3Deployment,verifyManagedApi3Deployment} from './prepare-managed-api3-deployment.mjs';
import {MANAGED_API3_USDG as cfg} from './inspect-api3-managed.mjs';
const artifact=JSON.parse(readFileSync(new URL('../out/DockyardApi3ManagedUsdgFeed.sol/DockyardApi3ManagedUsdgFeed.json',import.meta.url)));
test('creation binds exact native server, runtime pin and reviewed age; no call or token transfer',()=>{
  const data=managedApi3Creation(artifact);
  assert.ok(data.startsWith(artifact.bytecode.object));
  const args=decodeAbiParameters(parseAbiParameters('address,bytes32,uint32'),'0x'+data.slice(artifact.bytecode.object.length));
  assert.equal(args[0].toLowerCase(),cfg.server.toLowerCase());
  assert.equal(args[1],cfg.serverCodeHash);assert.equal(args[2],90000);
});
test('missing or incompatible artifacts fail closed',()=>{
  for(const a of [{},{...artifact,bytecode:{object:'0x'}},{...artifact,deployedBytecode:{}},
    {...artifact,abi:artifact.abi.filter(x=>x.type!=='constructor')}])assert.throws(()=>managedApi3Creation(a));
});
test('wrong-chain preparation cannot reach gas estimation or signing',async()=>{
  await assert.rejects(prepareManagedApi3Deployment({client:{getChainId:async()=>1},artifact,
    deployer:'0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086'}),/WrongManagedApi3Chain/);
});
test('wrong-chain or reverted receipt cannot be verified as deployed',async()=>{
  await assert.rejects(verifyManagedApi3Deployment({client:{getChainId:async()=>1}}),/Wrong receipt chain/);
  const client={getChainId:async()=>4663,getTransaction:async()=>({}),getTransactionReceipt:async()=>({status:'reverted'}),getBlock:async()=>({})};
  await assert.rejects(verifyManagedApi3Deployment({client,artifact,plan:{},transactionHash:'0x'+'11'.repeat(32)}),/Not successful/);
});
