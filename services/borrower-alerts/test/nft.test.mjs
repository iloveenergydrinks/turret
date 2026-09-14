import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { NFTMonitor } from '../src/nft-monitor.mjs';
import { validateNFTAlertsRegistry } from '../src/nft-deployment.mjs';
import { bindAlertsRuntime } from '../src/runtime.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,h=n=>`0x${n.toString(16).padStart(64,'0')}`;
const code='0x60016000',lender=addr(1),borrower=addr(2);
const registry={version:1,address:addr(10),chainId:4663,loanToken:addr(11),runtimeHash:keccak256(code),startBlock:'1',loanDecimals:6};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'nft-alert-unit-')),store=new Store(join(dir,'alerts.sqlite'),'ab'.repeat(32));
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const deployment=validateNFTAlertsRegistry(registry,{confirmations:1});
 let now=1800000000000,status=2,badCode=false,badPage=false,head=100n,logs=[];const sent=[];
 const block=n=>({number:n,hash:h(Number(n)),timestamp:BigInt(Math.floor(now/1000))});
 const client={getChainId:async()=>4663,getBlock:async args=>block(args?.blockNumber??head),getCode:async()=>badCode?'0x00':code,
  getContractEvents:async({fromBlock,toBlock})=>logs.filter(l=>l.blockNumber>=fromBlock&&l.blockNumber<=toBlock),
  readContract:async({functionName,args})=>{
   if(functionName==='loanToken')return registry.loanToken;if(functionName==='decimals')return 6;
   if(functionName==='accountOffers')return [[1n],badPage?0n:1n];
   if(functionName==='getOffer')return {lender,terms:{borrower,collection:addr(12),tokenId:999999999999999999999999n,principal:10_000000n,interest:1_000000n,duration:86400n,expiresAt:1799999000n},vault:addr(13),dueAt:1799914600n,status};
   throw Error(functionName);
  }};
 const engine=new Engine({store,origin:'https://turret.capital',vault:registry.address,protocol:'nft',scope:deployment.scope,now:()=>now,verify:async()=>true,send:async(...a)=>sent.push(a)});
 const monitor=new NFTMonitor(engine,client,deployment);
 function subscribe(wallet=borrower){engine.activate(engine.subscribe(wallet,'email','nft@example.test'),'email',undefined,head);}
 return {store,engine,monitor,client,deployment,sent,subscribe,set:v=>{if(v.status!==undefined)status=v.status;if(v.badCode!==undefined)badCode=v.badCode;if(v.badPage!==undefined)badPage=v.badPage;if(v.now!==undefined)now=v.now;if(v.logs!==undefined)logs=v.logs;if(v.head!==undefined)head=v.head;}};
}
test('NFT consent is separate from stock P2P and remains valid when collection admission changes',t=>{
 const f=fixture(t);bindAlertsRuntime(f.store,f.deployment);
 assert.equal(validateNFTAlertsRegistry({...registry,collections:[{address:addr(12),enabled:false}]}).scope,f.deployment.scope);
 assert.throws(()=>bindAlertsRuntime(f.store,{kind:'p2p',scope:f.deployment.scope}),/NFT/);
 assert.throws(()=>bindAlertsRuntime(f.store,validateNFTAlertsRegistry({...registry,address:addr(20)})),/fresh NFT consent/);
 assert.throws(()=>validateNFTAlertsRegistry({...registry,chainId:31337}));
 assert.match(f.engine.challenge(borrower).message,/Turret NFT P2P alert access/);
});
test('NFT reminders preserve exact token ID, survive monitor restart, and cancel after repayment',async t=>{
 const f=fixture(t);f.subscribe();await f.monitor.scan();await f.engine.deliver();
 assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/within one hour/);assert.match(f.sent[0][2],/999999999999999999999999/);assert.match(f.sent[0][2],/\/p2p\/nfts\?offer=1/);
 f.monitor=new NFTMonitor(f.engine,f.client,f.deployment);await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,1);
 f.set({now:1800001001000});await f.monitor.scan();assert.equal(f.store.all('outbox').length,1);
 f.set({status:3});await f.engine.deliver();assert.equal(f.sent.length,1);assert.equal(f.store.all('outbox').length,0);
});
test('NFT discovery and delivery reject wrong runtime and malformed ascending pagination',async t=>{
 const f=fixture(t);f.subscribe();f.set({badPage:true});await assert.rejects(f.monitor.scan());assert.equal(f.store.all('p2p-discovery').length,0);
 f.set({badPage:false});await f.monitor.scan();f.set({badCode:true});await f.engine.deliver();assert.equal(f.sent.length,0);
 f.engine.remove(borrower,'email');assert.equal(f.store.all('outbox').length,0);
});
test('NFT accepted-event ABI uses finalDeadline and messages only consenting participants',async t=>{
 const f=fixture(t);f.subscribe();f.subscribe(lender);f.subscribe(addr(3));await f.monitor.scan();await f.engine.deliver();f.sent.length=0;
 f.set({head:103n,logs:[{address:registry.address,eventName:'OfferAccepted',args:{id:1n,borrower,dueAt:1799914600n,finalDeadline:1800001000n},blockNumber:101n,blockHash:h(101),transactionHash:h(10001),logIndex:0,removed:false}]});
 await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,2);assert.ok(f.sent.every(a=>a[2].includes('Loan accepted')));
});
