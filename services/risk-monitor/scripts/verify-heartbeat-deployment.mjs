import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,http,keccak256,parseAbi} from '../src/deps.mjs';
const root=new URL('../../../',import.meta.url),readJson=p=>JSON.parse(readFileSync(new URL(p,root)));
const m=readJson('contracts/utils/assets/test_output/dockyard-pilot-heartbeat-candidate.json'),accounts=readJson('output/pilot-deployment/accounts.json');
const broadcast=readJson('contracts/broadcast/DeployDockyardHeartbeatPilot.s.sol/4663/run-latest.json');
const c=createPublicClient({transport:http(process.env.ALCHEMY_RPC_URL,{timeout:12000,retryCount:1})});
assert.equal(await c.getChainId(),4663);assert.equal(m.kind,'chainlink-guarded-pilot');assert.equal(m.revision,'heartbeat-v2');assert.equal(m.guardian.toLowerCase(),accounts.guardian.toLowerCase());
assert.equal(broadcast.transactions.length,23);assert.equal(broadcast.receipts.length,23);assert.equal(broadcast.pending.length,0);
const receipts=[];
for(let start=0;start<23;start+=4){
 receipts.push(...await Promise.all(broadcast.transactions.slice(start,start+4).map(async(p,j)=>{
  const [tx,r]=await Promise.all([c.getTransaction({hash:p.hash}),c.getTransactionReceipt({hash:p.hash})]);
  assert.equal(r.status,'success');assert.equal(tx.chainId,4663);assert.equal(tx.from.toLowerCase(),accounts.deployer.toLowerCase());assert.equal(tx.nonce,24+start+j);assert.equal(tx.value,0n);
  assert.equal(tx.input.toLowerCase(),(p.transaction.input??p.transaction.data).toLowerCase());
  assert.equal(tx.to?.toLowerCase()??null,p.transaction.to?.toLowerCase()??null);
  assert.equal((await c.getBlock({blockNumber:r.blockNumber})).hash,r.blockHash);
  return {hash:p.hash,block:r.blockNumber,contractAddress:r.contractAddress,gasUsed:r.gasUsed,effectiveGasPrice:r.effectiveGasPrice};
 })));
}
const head=await c.getBlock();assert.ok(head.number>=receipts.at(-1).block+2n);
const vaultAbi=readJson('contracts/out/DockyardUSDGCreditVaultPilot.sol/DockyardUSDGCreditVaultPilot.json').abi;
const guardAbi=readJson('contracts/out/DockyardChainlinkGuard.sol/DockyardChainlinkGuard.json').abi;
const read=(address,abi,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber:head.number});
const vr=(name,args)=>read(m.vault,vaultAbi,name,args);
assert.equal(keccak256(await c.getCode({address:m.vault,blockNumber:head.number})),m.vaultCodeHash);
assert.equal((await vr('owner')).toLowerCase(),m.owner.toLowerCase());assert.equal(await vr('paused'),true);
assert.equal((await vr('usdg')).toLowerCase(),'0x5fc5360d0400a0fd4f2af552add042d716f1d168');
assert.equal(await vr('globalDebtCeiling'),250000000n);assert.equal(await vr('originationFeeBps'),50);assert.equal(await vr('MAX_MARKET_DEBT'),50000000n);
assert.equal(await vr('totalDebt'),0n);assert.equal(await vr('availableLiquidity'),0n);assert.equal(await vr('borrowerAllowed',[m.owner]),true);
for(const a of [accounts.deployer,m.keeper,m.guardian])assert.equal(await vr('borrowerAllowed',[a]),false);
const created=receipts.filter(r=>r.contractAddress).map(r=>r.contractAddress.toLowerCase()).sort();
assert.deepEqual(created,[m.vault,...m.markets.map(x=>x.adapter)].map(x=>x.toLowerCase()).sort());
for(const x of m.markets){
 const gr=name=>read(x.adapter,guardAbi,name);
 const [code,collateral,primary,guardian,age,ttl,delay,deviation,market]=await Promise.all([c.getCode({address:x.adapter,blockNumber:head.number}),gr('collateral'),gr('primaryOracle'),gr('guardian'),gr('MAX_PRICE_AGE'),gr('MAX_HEALTH_AGE'),gr('RECOVERY_DELAY'),gr('maxDeviationBps'),vr('markets',[x.collateral])]);
 assert.equal(keccak256(code),x.adapterCodeHash);assert.equal(collateral.toLowerCase(),x.collateral.toLowerCase());assert.equal(primary.toLowerCase(),x.primaryOracle.toLowerCase());assert.equal(guardian.toLowerCase(),m.guardian.toLowerCase());
 assert.equal(age,86400n);assert.equal(x.maxPriceAgeSeconds,86400);assert.equal(ttl,60n);assert.equal(delay,120n);assert.equal(deviation,200);
 assert.equal(market[0].toLowerCase(),x.primaryOracle.toLowerCase());assert.equal(market[1].toLowerCase(),x.adapter.toLowerCase());assert.deepEqual(market.slice(2,7),[50000000n,3000,4000,500,200]);assert.equal(market[9],false);
 assert.equal(await vr('marketDebt',[x.collateral]),0n);
}
const report={verifiedAt:new Date().toISOString(),block:head.number,vault:m.vault,owner:m.owner,guardian:m.guardian,paused:true,allMarketsDisabled:true,totalDebt:0,availableLiquidity:0,globalDebtCeiling:250000000,marketDebtCeiling:50000000,bytecodeAndWiringVerified:true,receipts,totalGasSpent:receipts.reduce((s,r)=>s+r.gasUsed*r.effectiveGasPrice,0n),deployerRemainingEth:await c.getBalance({address:accounts.deployer})};
m.status='receipt-verified';m.startBlock=Number(receipts[0].block);m.marketDataVerified=false;m.verifiedAt=report.verifiedAt;
writeFileSync(new URL('contracts/utils/assets/test_output/dockyard-pilot-heartbeat-deployed.json',root),JSON.stringify(m,null,2)+'\n');
const json=JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2);writeFileSync(new URL('docs/security/evidence/2026-09-02/pilot-heartbeat-deployment-verification.json',root),json+'\n');
console.log(JSON.stringify({...report,receipts:receipts.length},(_,v)=>typeof v==='bigint'?v.toString():v,2));
