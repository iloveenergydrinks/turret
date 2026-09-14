import test from 'node:test';
import assert from 'node:assert/strict';
import {publishCycle,RiskNotifications} from '../src/publication.mjs';
import {Alerts} from '../../liquidator/src/alerts.mjs';
import {Store} from '../../liquidator/src/store.mjs';

function fixture(t,deliver){
 const store=new Store(':memory:',{role:'publication-test'});
 store.set('transportVerified',true);
 const alerts=new Alerts(store,{alertWebhook:'http://localhost/unused'});alerts.deliver=deliver;
 const notifications=new RiskNotifications(alerts,store);
 t.after(async()=>{await notifications.close();store.close();});
 const proof={encoded:'0x1234',validUntil:2000},approvals=new Map(),status={lastError:null};
 const state={status,store,alerts,notifications,incidents:[{code:'risk_keeper_unavailable',severity:'critical',message:'Keeper unavailable'}],
  candidates:[['market',{encoded:'0xabcd'}]],livenessCandidate:proof,approvals,isStopped:()=>false,
  setLiveness:p=>{state.published=p;},session:{open:true},mode:'execute'};
 return state;
}

test('failed operator notification cannot suppress valid liquidation liveness',async t=>{
 const state=fixture(t,async()=>false);
 publishCycle(state);await state.notifications.flush();
 assert.equal(state.published,state.livenessCandidate);
 assert.equal(state.approvals.size,0,'The keeper incident must still stop new admission');
});

test('a slow notification does not delay publication of a validated proof',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const state=fixture(t,()=>pending);
 publishCycle(state);
 const publishedBeforeDelivery=state.published;
 const newer={encoded:'0x5678',validUntil:2010};
 publishCycle({...state,livenessCandidate:newer});
 assert.equal(state.published,newer,'A second cycle refreshes proofs while delivery is still pending');
 release(false);await state.notifications.flush();
 assert.equal(publishedBeforeDelivery,state.livenessCandidate);
});

test('stopped or invalidated cycles never publish execution proofs',async t=>{
 for(const change of [{isStopped:()=>true},{status:{lastError:'RPCDisagreement'}},{livenessCandidate:undefined}]){
  const state=Object.assign(fixture(t,async()=>true),change);
  publishCycle(state);assert.equal(state.published,undefined);
 }
});
test('a failed cycle does not advertise the previous healthy liveness observation',async t=>{
 const state=fixture(t,async()=>true);
 state.status={lastError:'Error',liveness:{ok:true,code:'healthy',healthySince:1000,observedAt:1120,gate:'gate'}};
 publishCycle(state);
 assert.equal(state.published,undefined);assert.equal(state.status.liveness.ok,false);
 assert.equal(state.status.liveness.code,'cycle_failed');
 assert.equal(state.status.liveness.healthySince,undefined);assert.equal(state.status.liveness.observedAt,undefined);
 assert.equal(state.status.liveness.gate,'gate');
});

test('new admission waits for the current notification set and verified transport',async t=>{
 const state=fixture(t,async()=>true);
 state.incidents=[];
 publishCycle(state);assert.equal(state.approvals.size,0);
 await state.notifications.flush();
 publishCycle(state);assert.equal(state.approvals.size,1);
 await state.notifications.flush();
 state.incidents=[{code:'risk_AAPL_QuoteStale',severity:'critical',message:'Stale quote'}];
 publishCycle(state);assert.equal(state.approvals.size,0,'A previously delivered generation cannot authorize a new one');
 await state.notifications.flush();
 state.store.set('transportVerified',false);
 publishCycle(state);assert.equal(state.approvals.size,0);
 assert.equal(state.published,state.livenessCandidate);
});

test('notification exceptions fail admission closed without breaking liveness',async t=>{
 const state=fixture(t,async()=>{throw Error('simulated delivery failure');});
 publishCycle(state);await state.notifications.flush();publishCycle(state);
 assert.equal(state.approvals.size,0);assert.equal(state.published,state.livenessCandidate);
});

test('notification attempts are serialized and waiting cycles are coalesced',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});let active=0,peak=0;const seen=[];
 const state=fixture(t,async event=>{seen.push(event.code);peak=Math.max(peak,++active);await pending;active--;return true;});
 state.notifications.request([{code:'first',severity:'warning'}]);
 state.notifications.request([{code:'discarded',severity:'warning'}]);
 state.notifications.request([{code:'latest',severity:'warning'}]);
 release();await state.notifications.flush();
 assert.equal(peak,1);assert.deepEqual(seen,['first','latest']);
});

test('slow initial transport verification cannot block proof refresh',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const state=fixture(t,async()=>true);state.store.set('transportVerified',false);
 state.notifications.verifyTransport=()=>pending;
 state.incidents=[];
 publishCycle(state);
 assert.equal(state.published,state.livenessCandidate);assert.equal(state.approvals.size,0);
 release(true);await state.notifications.flush();
 publishCycle(state);assert.equal(state.approvals.size,1);
});

test('notification completion cannot republish a proof after shutdown',async t=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const state=fixture(t,()=>pending);
 publishCycle(state);state.isStopped=()=>true;publishCycle(state);
 const closing=state.notifications.close();release(true);await closing;
 assert.equal(state.published,undefined);assert.equal(state.approvals.size,0);assert.equal(state.status.ready,false);
});
