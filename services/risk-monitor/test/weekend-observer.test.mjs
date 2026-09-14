import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {WeekendStore} from '../src/weekend-store.mjs';
import {publicWeekendSnapshot,startWeekendObserver} from '../src/weekend-observer.mjs';
import {weekendHttpResponse} from '../src/weekend-http.mjs';

test('observation worker receives no wallet credentials and cannot enable admission',async()=>{
 let worker,options;
 class FakeWorker extends EventEmitter{constructor(url,o){super();assert.match(url.pathname,/weekend-worker.mjs$/);options=o;worker=this;}unref(){}terminate(){this.emit('exit');}}
 const manifest={kind:'stock-pool',chainId:4663,vault:'0x1234',markets:[{symbol:'AAPL'}],continuousSessionAdmission:{route:{}}};
 const observer=startWeekendObserver({manifest,rpcUrls:['https://one.example','https://two.example'],dataDir:'/tmp/observer',privateKey:'never-pass'}, {WorkerClass:FakeWorker});
 assert.deepEqual(options.env,{NODE_ENV:'production'});
 assert.deepEqual(Object.keys(options.workerData).sort(),['directory','manifest','rpcUrls']);
 const checkedAt=Math.floor(Date.now()/1000);
 worker.emit('message',{type:'sample',sample:{checkedAt,observationComplete:true,code:'observed',sources:{}},recent:[],history:{samples:1}});
 assert.equal(observer.publicSnapshot().live,true);
 assert.equal(observer.publicSnapshot().borrowingEnabled,false);
 worker.emit('error',new Error('RPC URL and secret must not be exposed'));
 assert.equal(observer.publicSnapshot().code,'observer_worker_unavailable');
 assert.equal(observer.publicSnapshot().observationComplete,false);
 assert.equal(observer.publicSnapshot().live,false);
 assert.doesNotMatch(JSON.stringify(observer.snapshot()),/RPC URL and secret/);
 await observer.close();
});

test('other markets do not start the AAPL observer',async()=>{
 const observer=startWeekendObserver({manifest:{kind:'stock-pool',chainId:4663,markets:[{symbol:'MSFT'}]},rpcUrls:[],dataDir:'/tmp/observer'},{WorkerClass:class {constructor(){assert.fail('unexpected worker');}}});
 assert.equal(observer.publicSnapshot().enabled,false);await observer.close();
});

test('stale observations cannot appear complete and public diagnostics exclude prices',()=>{
 const state={enabled:true,latest:{checkedAt:1000,observationComplete:true,code:'observed',privatePrice:321.1},history:{samples:1}};
 assert.equal(publicWeekendSnapshot(state,1151).observationComplete,false);
 assert.equal(publicWeekendSnapshot(state,999).live,false);
 assert.equal(publicWeekendSnapshot(state,1001).privatePrice,undefined);
 assert.equal(publicWeekendSnapshot(state,1001).borrowingEnabled,false);
});

test('public source freshness expires by trade time even when the observer is live',()=>{
 const state={enabled:true,latest:{checkedAt:1100,observationComplete:true,code:'observed',
  sources:{kraken:{fresh:true}},kraken:{latestTradeAt:1000,maxTradeAgeSeconds:120}}};
 assert.equal(publicWeekendSnapshot(state,1119).sources.kraken.fresh,true);
 assert.equal(publicWeekendSnapshot(state,1120).sources.kraken.fresh,false);
});

test('a stalled worker is terminated and restarted without stopping the risk service',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:1000});
 let starts=0,terminations=0;
 class FakeWorker extends EventEmitter{constructor(){super();starts++;}unref(){}terminate(){terminations++;this.emit('exit');}}
 const observer=startWeekendObserver({manifest:{kind:'stock-pool',chainId:4663,markets:[{symbol:'AAPL'}],continuousSessionAdmission:{route:{}}},rpcUrls:['https://one.example'],dataDir:'/tmp/observer'},{WorkerClass:FakeWorker});
 t.mock.timers.tick(210000);assert.equal(terminations,1);
 t.mock.timers.tick(60000);assert.equal(starts,2);
 await observer.close();t.mock.timers.reset();
});

test('private observation history requires the existing status token; never handles approvals',()=>{
 const token='test-status-token'.repeat(3),observer={publicSnapshot:()=>({mode:'observation'}),snapshot:()=>({latest:{price:321}})};
 assert.equal(weekendHttpResponse('/weekend/observations',undefined,token,observer).status,401);
 assert.equal(weekendHttpResponse('/weekend/observations','Bearer wrong',token,observer).status,401);
 assert.equal(weekendHttpResponse('/weekend/observations',`Bearer ${token}`,token,observer).body.latest.price,321);
 assert.deepEqual(weekendHttpResponse('/weekend/status',undefined,token,observer).body,{mode:'observation'});
 assert.equal(weekendHttpResponse('/stock/approvals/0x1234',undefined,token,observer),null);
});

test('observer journal survives restart, bounds retention and rejects the wrong engine',()=>{
 const dir=mkdtempSync(`${tmpdir()}/weekend-store-`);
 try{
  let store=new WeekendStore(dir,'0xABCD');
  store.save({checkedAt:1000,observationComplete:true});store.close();
  store=new WeekendStore(dir,'0xabcd');assert.equal(store.recent()[0].checkedAt,1000);
  store.save({checkedAt:1000+15*86400,observationComplete:false});
  assert.equal(store.summary().samples,1);assert.equal(store.summary().completeSamples,0);
  assert.throws(()=>store.save({checkedAt:NaN}),/InvalidWeekendSample/);store.close();
  assert.throws(()=>new WeekendStore(dir,'0x1234'),/WeekendJournalIdentityMismatch/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
