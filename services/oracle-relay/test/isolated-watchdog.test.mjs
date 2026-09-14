import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../../liquidator/src/store.mjs';
import {isolatedConfigFromEnv} from '../src/isolated-config.mjs';
import {CASHCAT_PAIR} from '../src/isolated-pyth-preflight.mjs';
import {watchdogConfig,snapshotProblems,checkIsolatedOracle} from '../src/isolated-watchdog.mjs';
const hash='0x'+'a'.repeat(64),now=1800000000000;
const config={url:'https://example.invalid/status',token:'test-token-'.repeat(4),identityHash:hash,timeoutMs:1000,reminderMs:3600000};
const snapshot=()=>({kind:'isolated-pyth-ratio',chainId:4663,identityHash:hash,mode:'execute',live:true,ready:true,
  lastCycle:now,incidents:[],cache:{available:true,checkedAt:now,validUntil:now+20000},
  operatorAlerts:{delivered:true,checkedAt:now,verifiedUntil:now+300000}});
function fixture(){
  const kv=new Map(),notices=[];let response=snapshot(),clock=now,delivery=true;
  const store={assertLease(){},get:k=>kv.get(k),set:(k,v)=>kv.set(k,v)};
  const args={config,store,now:()=>clock,fetchImpl:async()=>Response.json(response),
    notify:async(codes,recovered,probe)=>{notices.push({codes,recovered,probe});return {configured:true,delivered:delivery};}};
  return {args,kv,notices,setSnapshot:s=>{response=s;},setClock:t=>{clock=t;},setDelivery:b=>{delivery=b;}};
}
test('watchdog requires explicit identity and protects status credentials from redirects/nonlocal HTTP',()=>{
  const env={ISOLATED_ORACLE_STATUS_URL:'https://example.invalid/status',ORACLE_STATUS_TOKEN:config.token,ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH:hash};
  assert.equal(watchdogConfig(env).identityHash,hash);
  for(const url of ['http://example.invalid/status','https://user:secret@example.invalid/status','https://example.invalid/status?key=secret','https://example.invalid/health','https://example.invalid/status#x'])
    assert.throws(()=>watchdogConfig({...env,ISOLATED_ORACLE_STATUS_URL:url}));
  assert.throws(()=>watchdogConfig({...env,ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH:undefined}));
});
test('expected identity hash binds exact oracle policy/runtime but excludes provider and status secrets',()=>{
  const addr=x=>'0x'+x.repeat(40);
  const manifest={kind:'isolated-pyth-ratio',chainId:4663,startBlock:'123',relayAddress:addr('3'),guardian:addr('4'),keeper:addr('5'),
    publication:{policy:CASHCAT_PAIR,hub:addr('1'),adapter:addr('2'),hubCodeHash:hash,adapterCodeHash:hash,
      verifierCodeHash:hash,collateralCodeHash:hash,usdgCodeHash:hash}};
  const env={ORACLE_RPC_URL:'http://127.0.0.1',ORACLE_STATUS_TOKEN:config.token,PYTH_API_KEY:'local-placeholder'};
  const initial=isolatedConfigFromEnv(env,manifest).identityHash;
  assert.equal(isolatedConfigFromEnv({...env,PYTH_API_KEY:'rotated-local',ORACLE_STATUS_TOKEN:'different-token'.repeat(3)},manifest).identityHash,initial);
  assert.notEqual(isolatedConfigFromEnv(env,{...manifest,publication:{...manifest.publication,policy:{...CASHCAT_PAIR,maxPriceAge:59}}}).identityHash,initial);
});
test('watchdog rejects stale/future clocks, wrong identity/mode, critical incidents and false readiness',()=>{
  assert.deepEqual(snapshotProblems(snapshot(),config,now),[]);
  for(const mutate of [s=>{s.identityHash='0x'+'b'.repeat(64);},s=>{s.identityHash=5;},s=>{s.chainId=1;},s=>{s.mode='observe';},
    s=>{s.ready=false;},s=>{s.live=false;},s=>{s.lastCycle=now-30000;},s=>{s.lastCycle=now+1;},s=>{s.incidents=[{severity:'critical',code:'do-not-forward'}];},
    s=>{s.cache.validUntil=now;},s=>{s.cache.validUntil=now+30001;},s=>{s.cache.checkedAt=now+1;},s=>{s.cache.available=false;},
    s=>{s.operatorAlerts.verifiedUntil=now;},s=>{s.operatorAlerts.delivered=false;},s=>{s.operatorAlerts.checkedAt=now-30000;}]){
    const s=snapshot();mutate(s);assert.ok(snapshotProblems(s,config,now).length>0);
    assert.ok(!snapshotProblems(s,config,now).includes('do-not-forward'));
  }
});
test('healthy startup verifies watchdog transport, and retries failure instead of claiming operational monitoring',async()=>{
  const f=fixture();f.setDelivery(false);
  assert.equal((await checkIsolatedOracle(f.args)).healthy,false);assert.equal(f.notices[0].probe,true);
  f.setDelivery(true);assert.equal((await checkIsolatedOracle(f.args)).healthy,true);
  assert.equal(f.notices.length,2);assert.equal((await checkIsolatedOracle(f.args)).healthy,true);assert.equal(f.notices.length,2);
});
test('outage stays nonzero while notices deduplicate; failed notices retry, recovery waits for delivery',async()=>{
  const f=fixture();f.setSnapshot({...snapshot(),ready:false});f.setDelivery(false);
  assert.equal((await checkIsolatedOracle(f.args)).exitCode,1);assert.equal(f.notices.length,1);
  f.setDelivery(true);assert.equal((await checkIsolatedOracle(f.args)).exitCode,1);assert.equal(f.notices.length,2);
  assert.equal((await checkIsolatedOracle(f.args)).exitCode,1);assert.equal(f.notices.length,2);
  f.setSnapshot(snapshot());f.setDelivery(false);
  assert.equal((await checkIsolatedOracle(f.args)).exitCode,1);assert.ok(f.kv.get('isolatedOracleProblem'));
  f.setDelivery(true);assert.equal((await checkIsolatedOracle(f.args)).exitCode,0);
  assert.equal(f.kv.get('isolatedOracleProblem'),null);assert.equal(f.notices.at(-1).recovered,true);
});
test('HTTP errors, malformed/oversized responses and exceptions are bounded and redacted',async()=>{
  for(const fetchImpl of [async()=>new Response('secret-error',{status:503}),async()=>new Response('invalid-secret'),
    async()=>new Response('x'.repeat(65537)),async()=>{throw Error('secret-credentials');}]){
    const f=fixture();f.args.fetchImpl=fetchImpl;
    const result=await checkIsolatedOracle(f.args);assert.deepEqual(result.codes,['oracle_unreachable']);
    assert.ok(!JSON.stringify(f.notices).includes('secret'));
  }
});
test('independent watchdog detects actual HTTP endpoint death and persists deduplication across restarts',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-oracle-watchdog-'));let store,server;
  try{
    server=createServer((req,res)=>{assert.equal(req.headers.authorization,`Bearer ${config.token}`);res.end(JSON.stringify(snapshot()));});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${server.address().port}/status`,identity={kind:'watchdog-test',url};
    store=new Store(directory,identity);store.acquireLease();
    const notices=[];const args={config:{...config,url},store,now:()=>now,notify:async(codes,recovered,probe)=>{
      notices.push({codes,recovered,probe});return {configured:true,delivered:true};}};
    assert.equal((await checkIsolatedOracle(args)).healthy,true);
    await new Promise(r=>{server.close(r);server.closeAllConnections();});server=undefined;
    assert.equal((await checkIsolatedOracle(args)).exitCode,1);assert.deepEqual(notices.at(-1).codes,['oracle_unreachable']);
    store.close();store=new Store(directory,identity);store.acquireLease();args.store=store;
    assert.equal((await checkIsolatedOracle(args)).exitCode,1);assert.equal(notices.length,2,'restart must not spam the same outage');
  }finally{
    if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});
    store?.close();rmSync(directory,{recursive:true,force:true});
  }
});
test('fetch refuses redirects rather than forwarding the status credential',async()=>{
  const f=fixture();f.args.fetchImpl=async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,`Bearer ${config.token}`);return Response.json(snapshot());
  };
  assert.equal((await checkIsolatedOracle(f.args)).healthy,true);
});
