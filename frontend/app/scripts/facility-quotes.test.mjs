import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createFacilityQuoteBoard, createFacilityQuotesHandler, openFacilityQuoteStore } from "./facility-quotes.mjs";
import { ZERO_ADDRESS, ZERO_HASH } from "../src/facilities/quotes.mjs";

const now=1_800_000_000_000;
const address=n=>`0x${n.toString(16).padStart(40,"0")}`;
const quote=(nonce="1",terms={})=>({schemaVersion:1,chainId:31337,facility:address(1),signature:"0x",quote:{epoch:"1",nonce,borrower:ZERO_ADDRESS,
  capacity:"300000000",minDraw:"1000000",collateralForCapacity:"600000000000000000000",interestForCapacity:"30000000",duration:"604800",
  validAfter:"1800000000",expiresAt:"1800000600",...terms}});
const entry={chainId:31337,address:address(1),lender:address(2),loanToken:address(3),collateralToken:address(4),feeRecipient:address(5),
  feeBps:"1000",vaultImplementation:address(6),runtimeHash:ZERO_HASH,vaultImplementationHash:ZERO_HASH};
const baseline={schemaVersion:1,chainId:31337,blockNumber:"1",blockHash:ZERO_HASH,
  tokens:[3,4].map(n=>({address:address(n),runtimeHash:ZERO_HASH,implementationSlot:ZERO_HASH,beaconSlot:ZERO_HASH,decimals:18,checks:[]}))};
async function fixture(t,options) {
  const dir=await mkdtemp(join(tmpdir(),"facility-quotes-"));const file=join(dir,"quotes.sqlite");
  const store=openFacilityQuoteStore(file,options);t.after(async()=>{try{store.close();}catch{}await rm(dir,{recursive:true,force:true});});
  return {file,store};
}
function checker({observation={},error}={}) {
  return async(_client,_entry,_baseline,envelopes)=>{
    if(error)throw error;
    const block={number:1n,hash:ZERO_HASH,timestamp:BigInt(now/1000)};
    return {block,checkedAt:now,rows:envelopes.map(envelope=>({envelope,observation:{facility:entry.address,chainId:31337,lender:entry.lender,
      healthy:true,signatureValid:true,paused:false,epoch:1n,idleCash:500_000000n,cashBalance:500_000000n,activePrincipal:0n,unresolvedDefaultPrincipal:0n,feeBps:1000n,
      limits:{maxExposure:500_000000n,minDraw:1_000000n,maxDraw:300_000000n,minDuration:86400n,maxDuration:2592000n,maxQuoteLifetime:3600n,minCollateralPerPrincipalWad:10n**30n,minInterestBps:100n},
      use:{digest:ZERO_HASH,filled:0n,cancelled:false},block,checkedAt:now,...observation}}))};
  };
}
const board=(store,read=checker(),extra={})=>createFacilityQuoteBoard({entries:[entry],baseline,store,client:{},read,clock:()=>now,...extra});

test("durable quotes survive reopen; same payload is idempotent while conflicting nonce is rejected",async t=>{
  const {file,store}=await fixture(t);
  const first=store.put(quote(),now);store.put({...quote(),signature:"0xab"},now);
  assert.equal(store.list(31337,entry.address,now).length,1);
  assert.throws(()=>store.put(quote("1",{interestForCapacity:"31000000"}),now),e=>e.status===409);
  store.close();const reopened=openFacilityQuoteStore(file);t.after(()=>reopened.close());
  const rows=reopened.list(31337,entry.address,now);assert.equal(rows.length,1);assert.equal(rows[0].signature,"0xab");
  assert.equal(reopened.put(quote(),now).id,first.id);
  assert.equal(reopened.list(31337,entry.address,now+600000).length,0);
  reopened.put(quote("1",{validAfter:"1800000600",expiresAt:"1800000900",interestForCapacity:"31000000"}),now+600000);
  assert.equal(reopened.list(31337,entry.address,now+600000).length,1);
});
test("store quotas are enforced transactionally and expiry releases capacity",async t=>{
  const {store}=await fixture(t,{maxQuotes:2,maxPerFacility:1});
  store.put(quote(),now);
  assert.throws(()=>store.put(quote("2"),now),e=>e.status===429);
  store.put({...quote(),facility:address(7)},now);
  assert.throws(()=>store.put({...quote(),facility:address(8)},now),e=>e.status===429);
  assert.throws(()=>store.put(quote("2",{expiresAt:"1800086401"}),now),e=>e.status===400);
  assert.throws(()=>store.put(quote(),now+600000),e=>e.status===409);
  store.put(quote("2",{validAfter:"1800000600",expiresAt:"1800000900"}),now+600000);
  assert.equal(store.list(31337,entry.address,now+600000).length,1);
});
test("two independent SQLite writers cannot publish different terms for one nonce",async t=>{
  const {file,store}=await fixture(t);const moduleUrl=new URL("./facility-quotes.mjs",import.meta.url).href;
  const worker=envelope=>new Promise((resolve,reject)=>{
    const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.moduleUrl).then(({openFacilityQuoteStore})=>{
        const store=openFacilityQuoteStore(workerData.file);
        try{store.put(workerData.envelope,workerData.now);parentPort.postMessage(200);}
        catch(e){parentPort.postMessage(e.status||500);}finally{store.close();}
      }).catch(e=>{throw e});`,{eval:true,workerData:{moduleUrl,file,envelope,now}});
    w.on("message",resolve);w.on("error",reject);
  });
  const results=await Promise.all([worker(quote()),worker(quote("1",{interestForCapacity:"31000000"}))]);
  assert.deepEqual(results.sort(),[200,409]);assert.equal(store.list(31337,entry.address,now).length,1);
});
test("board checks signatures before persistence and rechecks capital each time; failures are not empty listings",async t=>{
  const {store}=await fixture(t);
  await assert.rejects(board(store,checker({observation:{signatureValid:false}})).submit(quote()),e=>e.status===409);
  assert.equal(store.list(31337,entry.address,now).length,0);
  const live=board(store);await live.submit(quote());await live.submit(quote("2"));
  assert.equal((await live.list({chainId:31337,facility:entry.address})).capacity,500_000000n);
  const paused=board(store,checker({observation:{paused:true}}));
  assert.equal((await paused.list({chainId:31337,facility:entry.address})).quotes.length,0);
  const revoked=board(store,checker({observation:{epoch:2n}}));
  assert.equal((await revoked.list({chainId:31337,facility:entry.address})).capacity,0n);
  await assert.rejects(board(store,checker({error:new Error("RPC secret internals")})).list({chainId:31337,facility:entry.address}),e=>e.status===503&&!e.message.includes("secret"));
  await assert.rejects(board(store,checker({observation:{cashBalance:0n}})).list({chainId:31337,facility:entry.address}),e=>e.status===503);
  await assert.rejects(live.submit({...quote(),facility:address(99)}),e=>e.status===404);
});
test("borrower restriction filters discovery without claiming confidentiality",async t=>{
  const {store}=await fixture(t);const live=board(store);
  await live.submit(quote("1",{borrower:address(8)}));
  assert.equal((await live.list({chainId:31337,facility:entry.address})).capacity,0n);
  assert.equal((await live.list({chainId:31337,facility:entry.address,account:address(8)})).capacity,300_000000n);
  assert.equal((await live.list({chainId:31337,facility:entry.address,account:address(9)})).capacity,0n);
});
test("bounded concurrent reads reject excess load and recover after completion",async t=>{
  const {store}=await fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const live=board(store,async(...args)=>{await gate;return checker()(...args);});
  const pending=Array.from({length:4},()=>live.list({chainId:31337,facility:entry.address}));
  await assert.rejects(live.list({chainId:31337,facility:entry.address}),e=>e.status===429);
  release();await Promise.all(pending);
  assert.equal((await live.list({chainId:31337,facility:entry.address})).status,"checked");
});
test("HTTP handler bounds streamed input, rejects foreign origins and serializes uints losslessly",async t=>{
  const {store}=await fixture(t);const origin="https://turret.capital";
  const handle=createFacilityQuotesHandler({board:board(store),origin});
  const post=(body,headers={})=>handle(new Request(`${origin}/api/facility-quotes`,{method:"POST",headers:{origin,"content-type":"application/json",...headers},body}));
  assert.equal((await post(JSON.stringify(quote()),{origin:"https://other.example"})).status,403);
  assert.equal((await post(" ".repeat(17000))).status,413);
  assert.equal((await post("{")).status,400);
  const added=await post(JSON.stringify(quote()));assert.equal(added.status,200);assert.equal((await added.json()).availability.capacity,"300000000");
  const url=`${origin}/api/facility-quotes?chainId=31337&facility=${entry.address}`;
  const result=await handle(new Request(url));assert.equal(result.headers.get("cache-control"),"no-store");assert.equal((await result.json()).capacity,"300000000");
  assert.equal((await handle(new Request(`${url}&chainId=4663`))).status,400);
  assert.equal((await handle(new Request(url,{method:"DELETE"}))).status,405);
});
