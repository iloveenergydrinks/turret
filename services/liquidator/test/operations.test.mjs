import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chain } from '../src/chain.mjs';
import { configFromEnv } from '../src/config.mjs';

test('retired keeper can preserve journal account identity with no signing key or wallet',()=>{
  const address='0x0000000000000000000000000000000000000001';
  const env={KEEPER_RPC_URL:'http://localhost:1111',KEEPER_MODE:'observe',KEEPER_OBSERVER_ADDRESS:address};
  const chain=new Chain(configFromEnv(env));
  assert.equal(chain.account?.address,address);
  assert.equal(chain.account.signTransaction,undefined);
  assert.equal(chain.wallet,undefined);
  assert.ok(chain.providers.every(p=>!p.wallet));
  assert.throws(()=>configFromEnv({...env,KEEPER_MODE:'execute'}));
  assert.throws(()=>configFromEnv({...env,KEEPER_OBSERVER_ADDRESS:'0x0000000000000000000000000000000000000000'}));
  assert.throws(()=>configFromEnv({...env,KEEPER_PRIVATE_KEY:'0x'+'01'.padStart(64,'0')}));
});

test('RPC failover checks chain identity, head age, shared block hash and request cooldown',async()=>{
  const chain=new Chain(configFromEnv({KEEPER_RPC_URL:'http://localhost:1111',KEEPER_FALLBACK_RPC_URLS:'http://localhost:2222'}));
  const head={number:100n,hash:'same',timestamp:BigInt(Math.floor(Date.now()/1000))};
  for(const p of chain.providers)p.client={getChainId:async()=>4663,getBlock:async()=>head};
  await chain.select();assert.equal(chain.active.name,'rpc_1');assert.equal(chain.consistent,true);
  chain.providers[1].client.getBlock=async args=>({...head,number:args?.blockNumber??105n});
  await chain.select();assert.equal(chain.active.name,'rpc_1','Subsecond probe skew must not abandon Alchemy');
  chain.providers[1].client.getBlock=async()=>head;
  chain.recordFailure();await chain.select();assert.equal(chain.active.name,'rpc_2');
  chain.providers[0].retryAfter=0;
  chain.providers[1].client.getBlock=async()=>({...head,hash:'different'});
  await chain.select();assert.equal(chain.consistent,false);
  chain.providers[0].client.getChainId=async()=>1;
  await chain.select();assert.equal(chain.active.name,'rpc_2');
  chain.providers[1].client.getBlock=async()=>({...head,timestamp:1n});
  await assert.rejects(chain.select(),/No healthy RPC/);
});
test('an actual failure on a newly selected fallback keeps its own full cooldown',async t=>{
  let now=1800000000000;
  t.mock.method(Date,'now',()=>now);
  const chain=new Chain(configFromEnv({KEEPER_RPC_URL:'http://localhost:1111',KEEPER_FALLBACK_RPC_URLS:'http://localhost:2222'}));
  const block=()=>({number:100n,hash:'same',timestamp:BigInt(now/1000)});
  for(const p of chain.providers)p.client={getChainId:async()=>4663,getBlock:async()=>block()};
  await chain.select();chain.recordFailure();const primaryRetry=chain.providers[0].retryAfter;
  now+=5000;await chain.select();assert.equal(chain.active.name,'rpc_2');
  chain.recordFailure();assert.equal(chain.providers[1].retryAfter,now+60000);
  assert.equal(chain.providers[0].retryAfter,primaryRetry);
  now+=5000;await assert.rejects(chain.select(),/No healthy RPC/);chain.recordFailure();
  assert.equal(chain.providers[0].retryAfter,primaryRetry);
  assert.equal(chain.providers[1].retryAfter,primaryRetry+5000);
});
test('independent watchdog reports each new incident once and detects recovery',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'dockyard-watchdog-test-'));
  const vault='0xb99D842DFFc140b9DD1927767653Bf21861120e9';
  let unavailable=false;
  let state={alive:true,alertDelivery:{delivered:true},snapshot:{vault,mode:'execute',reconciled:true,checkedAt:Date.now(),incidents:[{severity:'critical',code:'eth_reserve'}]}};
  const server=createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer test-token'){res.writeHead(401);res.end();return;}
    if(unavailable){res.writeHead(503);res.end();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const run=(extra={})=>new Promise(resolve=>{
    const child=spawn(process.execPath,['src/watchdog.mjs'],{env:{...process.env,KEEPER_STATUS_URL:`http://127.0.0.1:${server.address().port}/status`,KEEPER_STATUS_TOKEN:'test-token',KEEPER_EXPECTED_VAULT:vault,KEEPER_DATA_DIR:directory,...extra},stdio:'ignore'});
    child.on('exit',resolve);
  });
  try {
    assert.equal(await run(),0);assert.equal(await run(),0);
    state.snapshot.incidents.push({severity:'critical',code:'oracle_unavailable'});
    assert.equal(await run(),0);
    state.snapshot.incidents=[];assert.equal(await run(),0);
    state.snapshot.mode='observe';assert.equal(await run(),1);
    state.snapshot.mode='execute';assert.equal(await run(),0);
    state.alertDelivery.delivered=false;assert.equal(await run(),1);
    state.alertDelivery.delivered=true;assert.equal(await run(),0);
    state.snapshot.vault='0x0000000000000000000000000000000000000001';assert.equal(await run(),1);
    state.snapshot.vault=vault;assert.equal(await run(),0);
    unavailable=true;assert.equal(await run(),1);assert.equal(await run(),0);
    unavailable=false;assert.equal(await run(),0);
    state.snapshot.checkedAt=1;assert.equal(await run(),1);
    const stock={KEEPER_EXPECTED_KIND:'stock',KEEPER_EXPECTED_POOL:'0x'+'11'.repeat(20),KEEPER_EXPECTED_GATE:'0x'+'22'.repeat(20),
      KEEPER_EXPECTED_COLLATERAL:'0x'+'33'.repeat(20),KEEPER_EXPECTED_ACCOUNT:'0x'+'44'.repeat(20),
      KEEPER_EXPECTED_CODE_HASH:'0x'+'55'.repeat(32),KEEPER_EXPECTED_POOL_CODE_HASH:'0x'+'66'.repeat(32)};
    state.operational=true;state.snapshot={...state.snapshot,checkedAt:Date.now(),marketKind:'stock',engine:vault,chainId:4663,
      pool:stock.KEEPER_EXPECTED_POOL,executionGate:stock.KEEPER_EXPECTED_GATE,collateral:stock.KEEPER_EXPECTED_COLLATERAL,
      account:stock.KEEPER_EXPECTED_ACCOUNT,codeHash:stock.KEEPER_EXPECTED_CODE_HASH,poolCodeHash:stock.KEEPER_EXPECTED_POOL_CODE_HASH};
    delete state.snapshot.vault;assert.equal(await run(stock),0);
    state.snapshot.pool=vault;assert.equal(await run(stock),1);assert.equal(await run(stock),0);
    state.snapshot.pool=stock.KEEPER_EXPECTED_POOL;assert.equal(await run(stock),0);
    state.snapshot.marketKind='generic';assert.equal(await run(stock),1);
    state.snapshot.marketKind='stock';assert.equal(await run(stock),0);
    state.operational=false;assert.equal(await run(stock),1);
    state.snapshot.mode='observe';
    const observing={...stock,KEEPER_EXPECTED_MODE:'observe'};
    assert.equal(await run(observing),0,'Explicit paused commissioning does not claim execution readiness');
    state.snapshot.reconciled=false;assert.equal(await run(observing),1);
    state.snapshot.reconciled=true;assert.equal(await run(observing),0);
    state.snapshot.pool=vault;assert.equal(await run(observing),1);
    state.snapshot.pool=stock.KEEPER_EXPECTED_POOL;assert.equal(await run(observing),0);
    assert.equal(await run({...observing,KEEPER_EXPECTED_MODE:'disabled'}),1);
    assert.equal(await run(stock),1,'Default still requires execution');
    assert.equal(await run({...stock,KEEPER_EXPECTED_POOL_CODE_HASH:''}),1);
  } finally {await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
});
