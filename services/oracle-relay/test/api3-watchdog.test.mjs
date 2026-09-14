import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../liquidator/src/store.mjs';
import {api3WatchdogConfig,checkApi3Oracle} from '../src/api3-watchdog.mjs';

const hash='0x'+'a'.repeat(64),now=1800000000000;
const env={API3_ORACLE_STATUS_URL:'https://example.invalid/status',ORACLE_STATUS_TOKEN:'local-test-token-'.repeat(3),
  API3_ORACLE_EXPECTED_IDENTITY_HASH:hash};
const snapshot=()=>({kind:'stock-api3-usdg',chainId:4663,identityHash:hash,mode:'execute',live:true,ready:true,
  lastCycle:now,incidents:[],cache:{available:true,latestAvailable:true,checkedAt:now,validUntil:now+20000},
  operatorAlerts:{delivered:true,checkedAt:now,verifiedUntil:now+300000}});

test('stock watchdog accepts only its own explicit identity and checks delivery before reporting healthy',async()=>{
  const config=api3WatchdogConfig(env),store=new Store(':memory:',{kind:'api3-watchdog-test'});store.acquireLease();
  let response=snapshot(),delivered=false;const notices=[];
  const args={config,store,now:()=>now,fetchImpl:async(url,options)=>{
    assert.equal(url,env.API3_ORACLE_STATUS_URL);assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,`Bearer ${env.ORACLE_STATUS_TOKEN}`);
    return Response.json(response);
  },notify:async(codes,recovered,probe)=>{notices.push({codes,recovered,probe});return {configured:true,delivered};}};
  try{
    assert.equal((await checkApi3Oracle(args)).healthy,false);assert.equal(notices[0].probe,true);
    delivered=true;assert.equal((await checkApi3Oracle(args)).healthy,true);
    assert.equal((await checkApi3Oracle(args)).healthy,true);assert.equal(notices.length,2);
    response={...snapshot(),kind:'isolated-pyth-ratio'};
    assert.ok((await checkApi3Oracle(args)).codes.includes('oracle_identity_mismatch'));
  }finally{store.close();}
  assert.throws(()=>api3WatchdogConfig({...env,API3_ORACLE_STATUS_URL:undefined,ISOLATED_ORACLE_STATUS_URL:env.API3_ORACLE_STATUS_URL}));
  assert.throws(()=>api3WatchdogConfig({...env,API3_ORACLE_EXPECTED_IDENTITY_HASH:undefined,ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH:hash}));
  for(const url of ['http://example.invalid/status','https://user:secret@example.invalid/status',
    'https://example.invalid/status?key=secret','https://example.invalid/health','https://example.invalid/status#x'])
    assert.throws(()=>api3WatchdogConfig({...env,API3_ORACLE_STATUS_URL:url}));
});

test('stock watchdog rejects invalid latest cache, stale process state and failed alert delivery; recovery must be delivered',async()=>{
  const config=api3WatchdogConfig(env),store=new Store(':memory:',{kind:'api3-watchdog-state-test'});store.acquireLease();
  let response=snapshot(),delivered=true;const notices=[];
  const args={config,store,now:()=>now,fetchImpl:async()=>Response.json(response),
    notify:async(codes,recovered,probe)=>{notices.push({codes,recovered,probe});return {configured:true,delivered};}};
  try{
    for(const [mutate,code] of [
      [s=>{s.cache.latestAvailable=false;},'oracle_latest_cache_unavailable'],
      [s=>{delete s.cache.latestAvailable;},'oracle_latest_cache_unavailable'],
      [s=>{s.cache.validUntil=now;},'oracle_confirmed_cache_stale'],
      [s=>{s.lastCycle=now-30000;},'oracle_process_stalled'],
      [s=>{s.lastCycle=now+1;},'oracle_process_stalled'],
      [s=>{s.operatorAlerts.delivered=false;},'oracle_operator_alerts_unavailable'],
      [s=>{s.mode='observe';},'oracle_execution_disabled'],
      [s=>{s.identityHash='0x'+'b'.repeat(64);},'oracle_identity_mismatch'],
      [s=>{s.incidents=[{severity:'critical',code:'private-untrusted-payload'}];},'oracle_critical_incident'],
    ]){
      response=snapshot();mutate(response);
      const result=await checkApi3Oracle(args);assert.equal(result.exitCode,1);assert.ok(result.codes.includes(code));
    }
    assert.ok(!JSON.stringify(notices).includes('private-untrusted-payload'));
    const count=notices.length;
    assert.equal((await checkApi3Oracle(args)).exitCode,1);assert.equal(notices.length,count,'persistent outage is deduplicated, not marked healthy');
    response=snapshot();delivered=false;
    assert.equal((await checkApi3Oracle(args)).exitCode,1);assert.equal(notices.at(-1).recovered,true);
    delivered=true;assert.equal((await checkApi3Oracle(args)).exitCode,0);assert.equal(notices.at(-1).recovered,true);
    assert.equal((await checkApi3Oracle({...args,fetchImpl:async()=>new Response('x'.repeat(65537))})).exitCode,1);
  }finally{store.close();}
});
