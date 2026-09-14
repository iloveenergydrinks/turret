import test from 'node:test';
import assert from 'node:assert/strict';
import {IsolatedOracleWorker} from '../src/isolated-worker.mjs';
import {isolatedHandler} from '../src/isolated-main.mjs';

function fixture(){
  let clock=1800000000000,pending;const calls=[],kv=new Map();
  const config={mode:'execute',publication:{},relayAddress:'local',key:'secret-not-for-status',
    confirmations:2n,minEth:1n,maxTxFee:1n,alertWebhook:'https://example.invalid',alertCheckMs:300000,cycleMaxAgeMs:30000};
  const store={assertLease(){},get:k=>kv.get(k),set:(k,v)=>kv.set(k,v),pendingTx:()=>pending,transactions:()=>[]};
  const chain={consistent:true,async select(){calls.push('select');return {number:100n};},client:{async getBalance(){return 10n**18n;}}};
  const txs={async recover(_h,broadcast){calls.push(`recover:${broadcast}`);return [];},async publish(){calls.push('publish');return [];}};
  const alerts={async deliver(){calls.push('transport');return true;},async update(incidents){calls.push('alerts');kv.set('alertDelivery',{delivered:true});return incidents;}};
  const prepare=async()=>{calls.push('provider');return {shouldSubmit:true};};
  const readiness=async()=>{calls.push('cache');return {available:true,validUntil:clock+20000};};
  const args={config,store,chain,txs,alerts,prepare,readiness,now:()=>clock};
  const worker=new IsolatedOracleWorker(args);
  return {...args,worker,calls,kv,setClock:v=>{clock=v;},getClock:()=>clock,setPending:v=>{pending=v;}};
}
test('cycle reconciles before provider, verifies transport, then publishes; snapshot contains no key',async()=>{
  const f=fixture(),r=await f.worker.cycle();assert.equal(r.ready,true);
  assert.deepEqual(f.calls,['select','recover:false','transport','cache','provider','publish','alerts']);
  assert.ok(!JSON.stringify(r).includes(f.config.key));
});
test('provider outage still recovers transactions and reads cache; readiness cannot remain green',async()=>{
  const f=fixture();await f.worker.cycle();f.calls.length=0;
  f.worker.prepare=async()=>{f.calls.push('provider');throw Error('secret-url');};
  const r=await f.worker.cycle();assert.equal(r.ready,false);assert.equal(r.live,true);
  assert.deepEqual(f.calls,['select','recover:false','cache','provider','alerts']);
  assert.ok(!JSON.stringify(r).includes('secret-url'));
});
test('failed transport prevents publish and retries; failed delivery clears prior verification',async()=>{
  const f=fixture();f.alerts.deliver=async()=>false;
  assert.equal((await f.worker.cycle()).ready,false);assert.ok(!f.calls.includes('publish'));
  f.alerts.deliver=async()=>true;
  assert.equal((await f.worker.cycle()).ready,true);
  f.alerts.update=async incidents=>{f.kv.set('alertDelivery',{delivered:false});return incidents;};
  assert.equal((await f.worker.cycle()).ready,false);assert.equal(f.worker.transportUntil,0);
});
test('invalidation cache does not suppress authenticated publication but remains unready',async()=>{
  const f=fixture();f.worker.readiness=async()=>({available:false,validUntil:f.getClock()+1000});
  assert.equal((await f.worker.cycle()).ready,false);assert.ok(f.calls.includes('publish'));
});
test('observe mode never publishes or replaces pending transactions',async()=>{
  const f=fixture();f.config.mode='observe';f.setPending({id:'x',status:'pending'});
  assert.equal((await f.worker.cycle()).ready,false);
  assert.ok(!f.calls.includes('publish'));assert.ok(!f.calls.includes('recover:true'));
});
test('RPC disagreement, failed cache verification or missing funding prevent publication',async()=>{
  for(const mode of ['rpc','cache','funds']){
    const f=fixture();
    if(mode==='rpc')f.chain.consistent=false;
    if(mode==='cache')f.worker.readiness=async()=>{throw Error();};
    if(mode==='funds')f.chain.client.getBalance=async()=>0n;
    assert.equal((await f.worker.cycle()).ready,false);assert.ok(!f.calls.includes('publish'));
  }
});
test('pending journal is recovered without creating a second intent, blocked journal is unready',async()=>{
  for(const status of ['pending','blocked']){
    const f=fixture();f.setPending({id:'x',status});
    const r=await f.worker.cycle();assert.ok(f.calls.includes('recover:true'));assert.ok(!f.calls.includes('publish'));
    if(status==='blocked')assert.equal(r.ready,false);
  }
});
test('health expires by cache deadline without waiting for another cycle, and on process stall',async()=>{
  const f=fixture();await f.worker.cycle();f.setClock(f.getClock()+20000);
  assert.deepEqual(f.worker.health(),{live:true,ready:false});
  f.setClock(f.getClock()+10000);assert.deepEqual(f.worker.health(),{live:false,ready:false});
});
test('status authentication and readiness HTTP status are separate from liveness',async()=>{
  const f=fixture();await f.worker.cycle();const handler=isolatedHandler(f.worker,'token');
  function request(url,auth){const res={statusCode:200,setHeader(){},end(body){this.body=body;}};handler({method:'GET',url,headers:{authorization:auth}},res);return res;}
  assert.equal(request('/status').statusCode,401);assert.equal(request('/status','Bearer wrong').statusCode,401);
  assert.equal(request('/status','Bearer token').statusCode,200);
  assert.equal(request('/ready').statusCode,200);
  f.setClock(f.getClock()+20000);
  assert.equal(request('/health').statusCode,200);assert.equal(request('/ready').statusCode,503);
});
test('concurrent cycles are rejected',async()=>{
  const f=fixture();let resolve;f.chain.select=()=>new Promise(r=>{resolve=r;});
  const first=f.worker.cycle();await assert.rejects(f.worker.cycle(),/already running/);
  resolve({number:100n});await first;
});
test('watchdog sees the last complete snapshot during polling, but its original expiry still applies',async()=>{
  const f=fixture();await f.worker.cycle();const completed=f.worker.status;
  let resolve;f.chain.select=()=>new Promise(r=>{resolve=r;});
  const running=f.worker.cycle();
  assert.equal(f.worker.status,completed);assert.equal(f.worker.health().ready,true);
  f.setClock(f.getClock()+20000);assert.equal(f.worker.health().ready,false);
  resolve({number:100n});await running;
  assert.notEqual(f.worker.status,completed);assert.equal(f.worker.health().ready,true);
});
test('fatal journal failure immediately invalidates the last complete snapshot',async()=>{
  const f=fixture();await f.worker.cycle();f.store.assertLease=()=>{throw Error('lost lease');};
  await assert.rejects(f.worker.cycle(),/lost lease/);assert.equal(f.worker.health().ready,false);
});
