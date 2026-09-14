import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionData} from 'viem';
import {createPacedFetch,kyber,quote,quoteWithinBudget,swapAbi,SWAP_ROUTER,SWAP_TARGET,USDG,TOKEN} from '../src/quote.mjs';
const module='0x2222222222222222222222222222222222222222';
const json=x=>new Response(JSON.stringify({code:0,data:x}));
test('real quote pipeline downsizes through a rate-limited gateway without request bursts',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});let last=-Infinity;const seen=[];
 const upstream=async(url,options)=>{
  if(Date.now()-last<11000)return new Response('{}',{status:429});last=Date.now();seen.push(last);
  if(new URL(url).pathname.endsWith('/routes')){
   const amount=new URL(url).searchParams.get('amountIn'),a=BigInt(amount);
   return json({routerAddress:SWAP_ROUTER,routeSummary:{tokenIn:USDG,tokenOut:TOKEN,amountIn:amount,amountOut:String(a*(a>3000000n?900n:1000n)),timestamp:Math.floor(Date.now()/1000),route:[[{exchange:'uniswapv3'}]]}});
  }
  const {routeSummary:r}=JSON.parse(options.body);const amount=BigInt(r.amountIn);
  const execution={callTarget:SWAP_TARGET,approveTarget:'0x0000000000000000000000000000000000000000',targetData:'0x12345678',clientData:'0x',desc:{srcToken:USDG,dstToken:TOKEN,srcReceivers:[SWAP_TARGET],srcAmounts:[amount],feeReceivers:[],feeAmounts:[],dstReceiver:module,amount,minReturnAmount:BigInt(r.amountOut)*995n/1000n,flags:512n,permit:'0x'}};
  return json({routerAddress:SWAP_ROUTER,amountIn:r.amountIn,transactionValue:'0',data:encodeFunctionData({abi:swapAbi,functionName:'swap',args:[execution]})});
 };
 const fetcher=createPacedFetch(upstream,{sleep:async ms=>{t.mock.timers.tick(ms);}});
 const result=await quoteWithinBudget(module,24000000n,(m,a)=>quote(m,a,fetcher));
 assert.equal(result.amount,3000000n);assert.equal(seen.length,9);assert(seen.every((t,i)=>!i||t-seen[i-1]>=11000));
});
test('429 exposes Retry-After without retrying stale quote data',async()=>{
 let calls=0;
 await assert.rejects(kyber('route/build',{},async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});}),e=>e.message==='quote_rate_limited'&&e.retryAfterMs===120000);
 assert.equal(calls,1);
});
test('failed paced requests do not poison the queue',async()=>{
 let now=0,calls=0;const f=createPacedFetch(async()=>{if(++calls===1)throw Error('network');return new Response('{}');},{now:()=>now,sleep:async ms=>{now+=ms;}});
 await assert.rejects(f('https://example.invalid'),/network/);assert.equal((await f('https://example.invalid')).status,200);assert.equal(now,11000);
});
