import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { createFacilityLoanIndex } from "./facility-loan-index.mjs";
import { ZERO_HASH } from "../src/facilities/quotes.mjs";

const address = n => `0x${String(n).padStart(40,"0")}`;
const entry = { chainId:31337,address:address(1),lender:address(2),loanToken:address(3),collateralToken:address(4),feeRecipient:address(5),feeBps:"1000",vaultImplementation:address(6),startBlock:"1",runtimeHash:keccak256("0x6000"),vaultImplementationHash:ZERO_HASH };
const baseline = { schemaVersion:1,chainId:31337,blockNumber:"1",blockHash:ZERO_HASH,tokens:[3,4].map(n=>({address:address(n),runtimeHash:ZERO_HASH,implementationSlot:ZERO_HASH,beaconSlot:ZERO_HASH,decimals:n===3?6:18,checks:[]})) };
async function fixture(t, options={}) {
  const dir=await mkdtemp(join(tmpdir(),"facility-history-")), databasePath=join(dir,"history.sqlite"), instances=[];
  const state={head:10n,branch:0n,forkAt:0n,previousForks:[],loans:[],calls:[],drop:false,code:"0x6000",chain:31337,failLogs:false};
  const hash=n=>`0x${(n+1n+(n>=state.forkAt?state.branch:state.previousForks.find(f=>n>=f.at)?.branch??0n)*100000n).toString(16).padStart(64,"0")}`;
  const header=n=>({number:n,hash:hash(n),timestamp:BigInt(Math.floor(Date.now()/1000))});
  const client={getChainId:async()=>state.chain,getBlock:async args=>header(args?.blockNumber??state.head),getCode:async()=>state.code,
    getLogs:async({fromBlock,toBlock})=>{state.calls.push([fromBlock,toBlock]);if(state.failLogs)throw Error("RPC unavailable");return state.loans.filter(l=>l.block>=fromBlock&&l.block<=toBlock&&!(state.drop&&l.id===1n)).map(l=>({address:entry.address,eventName:"LoanOpened",blockNumber:l.block,blockHash:hash(l.block),logIndex:0,removed:false,args:{id:l.id,borrower:l.borrower}}));},
    readContract:async({functionName,args,blockNumber})=>{if(functionName==="nextLoanId")return BigInt(state.loans.filter(l=>l.block<=blockNumber).length)+1n;
      const loan=state.loans.find(l=>l.id===args[0]);return [loan.borrower,address(7),1000000n,2n*10n**18n,100000n,1000000n,loan.status===2?1090000n:0n,0n,0n,loan.status??1,false];},
  };
  const open=extra=>{const index=createFacilityLoanIndex({entries:[entry],baseline,client,databasePath,...options,...extra});instances.push(index);return index;};
  t.after(async()=>{for(const index of instances)try{index.close();}catch{}await rm(dir,{recursive:true,force:true});});
  const list=(index,account=address(8),before)=>index.list({chainId:31337,facility:entry.address,account,before});
  const loan=(id,block,borrower=address(8),status=1)=>({id:BigInt(id),block:BigInt(block),borrower,status});
  return {state,client,open,list,loan};
}
test("durable history retains repaid/defaulted loans and paginates per wallet without rereading old logs",async t=>{
  const {state,open,list,loan}=await fixture(t);state.head=30n;
  state.loans=Array.from({length:25},(_,i)=>loan(i+1,i+1,address(8),i===0?2:i===1?3:1));
  const first=open(), page=await list(first);assert.equal(page.complete,true);assert.equal(page.rows.length,20);assert.equal(page.nextCursor,"6");assert.equal(page.rows[0].id,"25");
  const rest=await list(first,address(8),page.nextCursor);assert.equal(rest.rows.length,5);assert.equal(rest.rows.at(-1).status,2);assert.equal(rest.rows.at(-2).status,3);assert.equal(rest.nextCursor,null);
  assert.equal((await list(first,address(9))).rows.length,0);assert.equal((await list(first,entry.lender)).rows.length,20);
  first.close();const next=open();state.calls=[];assert.equal((await list(next)).rows.length,20);assert.deepEqual(state.calls,[]);
  state.head=31n;state.loans.push(loan(26,31));await list(next);assert.deepEqual(state.calls,[[31n,31n]]);
});
test("bounded synchronization reports incomplete history until all ranges are indexed",async t=>{
  const {state,open,list,loan}=await fixture(t,{pageBlocks:3n,maxPages:1});state.loans=[loan(1,2),loan(2,9)];
  const index=open();let result=await list(index);assert.equal(result.complete,false);assert.equal(result.status,"syncing");assert.equal(result.indexedThrough,"3");assert.equal(result.rows.length,1);
  result=await list(index);assert.equal(result.indexedThrough,"6");assert.equal(result.complete,false);
  result=await list(index);assert.equal(result.rows.length,2);assert.equal(result.complete,false);
  result=await list(index);assert.equal(result.complete,true);assert.equal(result.indexedThrough,"10");
});
test("shallow and deep reorganizations discard orphaned borrowers and rebuild from canonical history",async t=>{
  const {state,open,list,loan}=await fixture(t,{pageBlocks:3n,maxPages:4,retainedCheckpoints:2});
  state.loans=[loan(1,2),loan(2,9)];const index=open();await list(index);
  state.branch=1n;state.forkAt=9n;state.loans=[loan(1,2),loan(2,9,address(9))];state.calls=[];
  let result=await list(index);assert.equal(result.historyEpoch,1);assert.deepEqual(result.rows.map(l=>l.id),["1"]);assert.equal((await list(index,address(9))).rows[0].id,"2");
  assert.equal(state.calls[0][0],1n,"fork is deeper than both retained checkpoints and must restart");
  state.head=11n;state.loans.push(loan(3,11));await list(index);state.previousForks=[{at:9n,branch:1n}];state.branch=2n;state.forkAt=11n;state.loans=[loan(1,2),loan(2,9,address(9)),loan(3,11,address(9))];state.calls=[];
  result=await list(index);assert.equal(result.historyEpoch,2);assert.deepEqual(result.rows.map(l=>l.id),["1"]);assert.equal((await list(index,address(9))).rows.length,2);
  assert.deepEqual(state.calls,[[11n,11n]],"shallow fork resumes from the retained canonical checkpoint");
});
test("missing events, wrong runtime and failed RPC never persist a false complete history",async t=>{
  const {state,open,list,loan}=await fixture(t);state.loans=[loan(1,2)];const index=open();state.drop=true;
  await assert.rejects(list(index),/loan count/);state.drop=false;state.failLogs=true;await assert.rejects(list(index),/RPC unavailable/);
  state.failLogs=false;state.code="0x6001";await assert.rejects(list(index),/identity changed/);state.code="0x6000";
  assert.equal((await list(index)).rows.length,1);
});
test("invalid checkpoints cannot be reused with different deployment configuration",async t=>{
  const {open,list}=await fixture(t);await list(open());const changed=open({entries:[{...entry,startBlock:"2"}]});await assert.rejects(list(changed),/configuration changed/);
});
test("concurrent processes cannot overwrite one another's checkpoint",async t=>{
  const {state,open,list,loan}=await fixture(t);state.loans=[loan(1,2)];const a=open(),b=open();
  const results=await Promise.allSettled([list(a),list(b)]);assert(results.some(r=>r.status==="fulfilled"));
  for(const result of results)if(result.status==="rejected")assert.match(result.reason.message,/concurrently|pagination/);
  assert.equal((await list(a)).rows.length,1);assert.equal((await list(b)).rows.length,1);
});
test("history remains unavailable if its block changes while current loan rows are read",async t=>{
  const {state,client,open,list,loan}=await fixture(t);state.loans=[loan(1,2)];const original=client.readContract;
  client.readContract=async args=>{const value=await original(args);if(args.functionName==="loans"){state.branch=1n;state.forkAt=0n;}return value;};
  const index=open();await assert.rejects(list(index),/changed or became stale/);
  client.readContract=original;assert.equal((await list(index)).rows.length,1);
});
test("too many concurrent history requests are bounded and capacity returns after completion",async t=>{
  const {client,open,list}=await fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;}), original=client.getBlock;
  client.getBlock=async args=>{await gate;return original(args);};
  const index=open(), pending=Array.from({length:8},()=>list(index));
  await assert.rejects(list(index),/requests are busy/);release();await Promise.all(pending);assert.equal((await list(index)).complete,true);
});
