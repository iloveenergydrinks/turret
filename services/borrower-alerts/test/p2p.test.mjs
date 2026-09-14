import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { Engine } from '../src/engine.mjs';
import { Store } from '../src/store.mjs';
import { P2PMonitor } from '../src/p2p-monitor.mjs';
import { bindP2PAlertsDeployment, p2pAlertsDeployment, validateP2PAlertsRegistry } from '../src/p2p-deployment.mjs';
import { activateAlerts, bindAlertsRuntime } from '../src/runtime.mjs';

const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,h=n=>`0x${n.toString(16).padStart(64,'0')}`;
const lender=addr(1),borrower=addr(2),unrelated=addr(3),code='0x60016000';
const market={address:addr(10),version:3,chainId:4663,loanToken:addr(11),collateralToken:addr(12),runtimeHash:keccak256(code),startBlock:'1',loanDecimals:6,collateralDecimals:18,collateralSymbol:'SLV',loanSymbol:'USDG'};
function fixture(t,{kind='p2p'}={}) {
  const dir=mkdtempSync(join(tmpdir(),'p2p-alert-unit-')),store=new Store(join(dir,'alerts.sqlite'),'ab'.repeat(32));
  const deployment=validateP2PAlertsRegistry({markets:[market]},{confirmations:1});
  let now=1800000000000,head=100n,deadline=1800001000,status=2,proposal=[borrower,1n,1800001000n,1800090000n,1800000500n],logs=[],badCode=false,fail=false;
  const sent=[];
  const block=number=>({number,hash:h(Number(number)),timestamp:BigInt(Math.floor(now/1000))});
  const client={getChainId:async()=>4663,getBlock:async(args)=>{if(fail)throw new Error('offline');return block(args?.blockNumber??head);},
    getCode:async()=>badCode?'0x00':code,
    getContractEvents:async({fromBlock,toBlock})=>logs.filter(log=>log.blockNumber>=fromBlock&&log.blockNumber<=toBlock),
    readContract:async({functionName})=>{
      if(functionName==='loanToken')return market.loanToken;if(functionName==='collateralToken')return market.collateralToken;
      if(functionName==='getAccountOfferIds')return [[1n],0n];
      if(functionName==='offers')return [lender,borrower,10_000000n,10n**18n,1_000000n,86400n,1799990000n,BigInt(deadline-86400),status];
      if(functionName==='repaymentDeadline')return BigInt(deadline);if(functionName==='extensionProposals')return proposal;
      throw new Error(functionName);
    }};
  const engine=new Engine({store,origin:'https://turret.capital',vault:market.address,protocol:kind,scope:deployment.scope,chainId:4663,now:()=>now,verify:async()=>true,send:async(...args)=>sent.push(args)});
  const monitor=new P2PMonitor(engine,client,deployment);
  function subscribe(wallet,channel='email') {const token=engine.subscribe(wallet,channel,'test@example.com');engine.activate(token,channel,channel==='telegram'?'123':undefined,head);return token;}
  function log(eventName,args={},number=Number(head)+1){return {address:market.address,eventName,args:{id:1n,...args},blockNumber:BigInt(number),blockHash:h(number),transactionHash:h(number+10000),logIndex:0,removed:false};}
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,engine,client,monitor,deployment,sent,subscribe,log,dir,
    set:(values)=>{if(values.now!==undefined)now=values.now;if(values.head!==undefined)head=values.head;if(values.deadline!==undefined)deadline=values.deadline;if(values.status!==undefined)status=values.status;if(values.proposal!==undefined)proposal=values.proposal;if(values.logs!==undefined)logs=values.logs;if(values.badCode!==undefined)badCode=values.badCode;if(values.fail!==undefined)fail=values.fail;}};
}
test('P2P scope is order-independent, rejects unreviewed/local defaults, and never inherits pooled consent',t=>{
  const f=fixture(t),second={...market,address:addr(20)};
  assert.equal(validateP2PAlertsRegistry({markets:[market,second]}).scope,validateP2PAlertsRegistry({markets:[second,market]}).scope);
  assert.throws(()=>validateP2PAlertsRegistry({markets:[market,market]}));
  assert.throws(()=>validateP2PAlertsRegistry({markets:[{...market,chainId:31337}]}));
  bindP2PAlertsDeployment(f.store,f.deployment);
  assert.throws(()=>bindAlertsRuntime(f.store,{kind:'stock',vault:market.address,codeHash:market.runtimeHash}),/P2P/);
  assert.throws(()=>bindP2PAlertsDeployment(f.store,validateP2PAlertsRegistry({markets:[second]})),/scope changed/);
  writeFileSync(join(f.dir,'registry.json'),JSON.stringify({markets:[market]}));
  assert.equal(p2pAlertsDeployment({ALERTS_P2P_REGISTRY_PATH:join(f.dir,'registry.json')}).scope,f.deployment.scope);
});
test('unverified contacts receive only verification; current loans get deduplicated deadline notices across monitor restart',async t=>{
  const f=fixture(t);f.engine.subscribe(borrower,'email','test@example.com');await f.monitor.scan();await f.engine.deliver();
  assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/^Confirm Turret P2P/);
  f.subscribe(borrower);await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,2);assert.match(f.sent[1][2],/within one hour/);
  await new P2PMonitor(f.engine,f.client,f.deployment).scan();await f.engine.deliver();assert.equal(f.sent.length,2);
});
test('extension and settlement cancel queued reminders and preserve refreshed deadline phases',async t=>{
  const f=fixture(t);f.subscribe(borrower);await f.monitor.scan();assert.equal(f.store.all('outbox').length,1);
  f.set({deadline:1800200000});await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,0);
  f.set({now:1800199000000});await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,1);
  f.set({deadline:1800201000});await f.monitor.scan();assert.equal(f.store.all('outbox').length,1);
  f.set({status:3});await f.engine.deliver();assert.equal(f.sent.length,1);assert.equal(f.store.all('outbox').length,0);
});
test('acceptance notifies consenting parties only and refuses events at or before channel consent',async t=>{
  const f=fixture(t);f.subscribe(lender);f.subscribe(borrower,'telegram');f.subscribe(unrelated);await f.monitor.scan();await f.engine.deliver();f.sent.length=0;
  f.set({head:103n,logs:[f.log('OfferAccepted',{dueAt:1799914600n,repaymentDeadline:1800001000n},101)]});
  await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,2);assert.ok(f.sent.every(args=>args[2].includes('Loan accepted')));
  await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,2);
  f.subscribe(borrower,'telegram');await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.filter(args=>args[2].includes('Loan accepted')).length,2);
});
test('extension proposal notifies only the counterparty and a cancelled proposal is suppressed before delivery',async t=>{
  const f=fixture(t);f.set({deadline:1800200000});f.subscribe(lender);f.subscribe(borrower);await f.monitor.scan();
  f.set({head:103n,logs:[f.log('ExtensionProposed',{proposer:borrower,nonce:1n,oldDeadline:1800001000n,newDeadline:1800090000n,expiresAt:1800000500n},101)]});
  await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,1);assert.match(f.sent[0][2],/extension proposed/);
  f.set({head:105n,proposal:[borrower,2n,1800001000n,1800090000n,1800000500n],logs:[f.log('ExtensionProposed',{proposer:borrower,nonce:2n,oldDeadline:1800001000n,newDeadline:1800090000n,expiresAt:1800000500n},103)]});
  await f.monitor.scan();f.set({proposal:[addr(0),0n,0n,0n,0n]});await f.engine.deliver();assert.equal(f.sent.length,1);
});
test('failed monitoring and changed contract identity hold deliveries; revocation deletes queued contact jobs',async t=>{
  const f=fixture(t);f.subscribe(borrower);await f.monitor.scan();f.set({badCode:true});await assert.rejects(f.monitor.scan());await f.engine.deliver();assert.equal(f.sent.length,0);
  f.set({badCode:false});await f.monitor.scan();f.set({fail:true});await f.engine.deliver();assert.equal(f.sent.length,0);
  f.engine.remove(borrower,'email');f.set({fail:false});await f.monitor.scan();await f.engine.deliver();assert.equal(f.sent.length,0);assert.equal(f.store.all('outbox').length,0);
});
test('delivery retries survive storage reopen and use stable provider idempotency keys',async t=>{
  const f=fixture(t);f.subscribe(borrower);await f.monitor.scan();const ids=[];
  f.engine.send=async(...args)=>{ids.push(args[3]);throw new Error('provider down');};await f.engine.deliver();assert.equal(f.store.all('outbox')[0].attempts,1);
  const reopened=new Store(join(f.dir,'alerts.sqlite'),'ab'.repeat(32));t.after(()=>reopened.close());f.engine.store=reopened;
  f.engine.send=async(...args)=>{ids.push(args[3]);f.sent.push(args);};f.set({now:1800000040000});await f.monitor.scan();await f.engine.deliver();
  assert.equal(f.sent.length,1);assert.equal(ids[0],ids[1]);assert.equal(f.store.all('outbox').length,0);
});
test('pooled alert engine cannot send queued P2P messages',async t=>{
  const f=fixture(t,{kind:'stock'});f.engine.enqueue('bad',{kind:'p2p-event',scope:f.deployment.scope,subId:`${borrower}:email`});await f.engine.deliver();assert.equal(f.sent.length,0);
});
test('consent head failure does not consume P2P verification token',async t=>{
  const f=fixture(t),token=f.engine.subscribe(borrower,'email','test@example.com');f.set({fail:true});
  await assert.rejects(activateAlerts(f.engine,f.client,f.deployment,token,'email'));f.set({fail:false});
  assert.deepEqual(await activateAlerts(f.engine,f.client,f.deployment,token,'email'),{verified:true});
});
