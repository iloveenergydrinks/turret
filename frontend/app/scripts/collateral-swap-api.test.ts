import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createCollateralSwapAPI} from './collateral-swap-api.mjs';
const market={engine:'0x2222222222222222222222222222222222222222',collateral:'0x3333333333333333333333333333333333333333',chainId:4663,admission:'active',central:{id:'NVDA',apiUrl:'https://example.com/',policyHash:'0x'+'a'.repeat(64),weekend:false}};
test('HTTP quote boundary validates input, market readiness, origin and method',async()=>{
 let healthy=true,calls=0;
 const handler=createCollateralSwapAPI({markets:[market],status:async()=>({ready:healthy,validUntil:BigInt(Math.floor(Date.now()/1000)+15),availability:{cash:10n,principal:0n,debtLimit:10n,paused:false}}),fetcher:async()=>{calls++;return new Response(JSON.stringify({code:0,data:{routerAddress:'0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',routeSummary:{tokenIn:'0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',tokenOut:market.collateral,amountIn:'100',amountOut:'1000',timestamp:Math.floor(Date.now()/1000),route:[[{exchange:'uniswapv3'}]]}}}));}});
 const server=createServer((req,res)=>void handler(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as any;const url=`http://127.0.0.1:${address.port}/api/collateral-swap/`;
 const input={engine:market.engine,payToken:'USDG',amountIn:'100',slippageBps:50};
 const post=(path:string,body:any,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  const good=await post('quote',input);assert.equal(good.status,200);const quote:any=await good.json();assert.ok(quote.id);assert.equal(good.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(url+'quote')).status,405);
  assert.equal((await post('quote',input,{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('quote',{...input,amountIn:'0'})).status,400);
  assert.equal((await post('quote',{...input,engine:'0x4444444444444444444444444444444444444444'})).status,400);
  assert.equal((await post('build',{quoteId:'invented',account:market.engine})).status,400);
  healthy=false;assert.equal((await post('quote',input)).status,400);assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
