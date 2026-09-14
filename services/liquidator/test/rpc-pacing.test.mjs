import test from 'node:test';
import assert from 'node:assert/strict';
import {createRpcPacer,paceRpcTransport} from '../src/rpc-pacing.mjs';
import {configFromEnv} from '../src/config.mjs';
import {Chain} from '../src/chain.mjs';

function clock(){
 let at=0,id=0;const timers=[];
 return {now:()=>at,schedule:(fn,delay)=>{timers.push({fn,due:at+delay,id:++id});return id;},
  advance(ms){const target=at+ms;for(;;){timers.sort((a,b)=>a.due-b.due);if(!timers.length||timers[0].due>target)break;
   const next=timers.shift();at=next.due;next.fn();}at=target;},
  late(ms){at+=ms;timers.sort((a,b)=>a.due-b.due);if(timers[0]?.due<=at)timers.shift().fn();}};
}

test('burst starts are spaced, with no catch-up burst after delayed timers',async()=>{
 const time=clock(),pace=createRpcPacer(8,time),starts=[];
 const jobs=Array.from({length:17},(_,i)=>pace(()=>{starts.push(time.now());return i;}));
 assert.deepEqual(starts,[0]);
 time.advance(1000);assert.equal(starts.length,9);
 time.late(500);assert.equal(starts.length,10);assert.equal(starts.at(-1),1500);
 time.advance(875);assert.equal(starts.length,17);
 assert.deepEqual(await Promise.all(jobs),Array.from({length:17},(_,i)=>i));
 assert.ok(starts.slice(1).every((at,i)=>at-starts[i]>=125));
});

test('failed and unresolved requests do not block subsequent starts or add retries',async()=>{
 const time=clock(),pace=createRpcPacer(10,time),calls=[];let finish;
 const pending=pace(()=>{calls.push('pending');return new Promise(resolve=>{finish=resolve;});});
 const failed=pace(()=>{calls.push('failed');throw Error('failure');});
 const recovered=pace(()=>{calls.push('recovered');return 'ok';});
 const rejected=assert.rejects(failed,/failure/);
 time.advance(200);
 assert.deepEqual(calls,['pending','failed','recovered']);assert.equal(await recovered,'ok');
 finish('done');assert.equal(await pending,'done');await rejected;
});

test('queue rejects overflow and expired work before execution, then recovers',async()=>{
 const time=clock(),pace=createRpcPacer(1,{...time,maxQueued:2,maxWaitMs:100});let executions=0;
 const first=pace(()=>++executions);
 const expired=[pace(()=>++executions),pace(()=>++executions)];
 const overflow=assert.rejects(pace(()=>++executions),{name:'RpcQueueFull'});
 const expiry=expired.map(p=>assert.rejects(p,{name:'RpcQueueExpired'}));
 time.advance(100);await Promise.all([first,overflow,...expiry]);assert.equal(executions,1);
 time.advance(900);assert.equal(await pace(()=>++executions),2);
});

test('default bypass preserves direct transport behavior',async()=>{
 const time=clock(),pace=createRpcPacer(0,time),values=[];
 for(let i=0;i<100;i++)assert.equal(pace(()=>{values.push(time.now());return i;}),i);
 assert.ok(values.every(x=>x===0));assert.throws(()=>pace(()=>{throw Error('direct');}),/direct/);
});

test('public and wallet transports share a schedule before underlying request starts',async()=>{
 const time=clock(),pace=createRpcPacer(5,time),starts=[];
 const transport=()=>({config:{retryCount:0},request:({method})=>{starts.push([method,time.now()]);return method;}});
 const shared=paceRpcTransport(transport,pace),publicRpc=shared({}),walletRpc=shared({});
 const a=publicRpc.request({method:'eth_call'}),b=walletRpc.request({method:'eth_sendRawTransaction'}),c=publicRpc.request({method:'eth_blockNumber'});
 assert.deepEqual(starts,[['eth_call',0]]);time.advance(400);
 assert.deepEqual(starts,[['eth_call',0],['eth_sendRawTransaction',200],['eth_blockNumber',400]]);
 assert.deepEqual(await Promise.all([a,b,c]),starts.map(x=>x[0]));assert.equal(walletRpc.config.retryCount,0);
});

test('fallback config is opt-in and rejects invalid values',()=>{
 const env={KEEPER_RPC_URL:'https://primary.invalid'};
 assert.equal(configFromEnv(env).fallbackRpcMaxRps,0);
 assert.equal(configFromEnv({...env,KEEPER_FALLBACK_RPC_MAX_RPS:'8'}).fallbackRpcMaxRps,8);
 for(const value of ['',' ','-1','1.5','NaN','Infinity','1001','1e2',null])
  assert.throws(()=>configFromEnv({...env,KEEPER_FALLBACK_RPC_MAX_RPS:value}),/Invalid KEEPER_FALLBACK_RPC_MAX_RPS/);
});

test('Chain integrates shared fallback pacing, leaves primary unlimited, and queues before HTTP timeout',async t=>{
 const calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({host:new URL(url).hostname,method:body.method,at:performance.now(),aborted:init.signal?.aborted});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:'0x1'}),{headers:{'Content-Type':'application/json'}});
 });
 const config={...configFromEnv({KEEPER_RPC_URL:'https://primary.invalid',KEEPER_FALLBACK_RPC_URLS:'https://fallback.invalid',
  KEEPER_FALLBACK_RPC_MAX_RPS:'4',KEEPER_PRIVATE_KEY:'0x'+'01'.repeat(32)}),rpcTimeoutMs:20};
 const chain=new Chain(config),primary=chain.providers[0],fallback=chain.providers[1];
 await primary.client.request({method:'eth_chainId'});calls.length=0;
 await Promise.all([fallback.client.request({method:'eth_call',params:[]}),
  fallback.wallet.request({method:'eth_sendRawTransaction',params:['0x00']}),
  fallback.client.request({method:'eth_blockNumber',params:[]}),
  ...Array.from({length:6},()=>primary.client.request({method:'eth_chainId'}))]);
 const limited=calls.filter(x=>x.host==='fallback.invalid'),unlimited=calls.filter(x=>x.host==='primary.invalid');
 assert.equal(limited.length,3);assert.equal(unlimited.length,6);
 assert.ok(limited[1].at-limited[0].at>=200);assert.ok(limited[2].at-limited[1].at>=200);
 assert.ok(unlimited.every(x=>x.at<limited[1].at));assert.ok(calls.every(x=>x.aborted===false));
 assert.equal(fallback.wallet.transport.retryCount,0);
});
