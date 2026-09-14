import {decodeFunctionData} from 'viem';
import {swapAbi,SWAP_ROUTER,SWAP_TARGET,SWAP_CODE,SWAP_SOURCES,PAYMENT_TOKENS,validateSwapRoute,validateSwapTransaction,sameAddress} from '../../../frontend/app/src/borrow/collateral-swap.mjs';
export {swapAbi,SWAP_ROUTER,SWAP_TARGET,SWAP_CODE};
export const TOKEN='0x99d70a25Bd7e95A30e14Bcbb64752c92227de9d7';
export const USDG=PAYMENT_TOKENS.USDG.address;
// One queue for this worker, including candidate/probe/build calls. Do not burst
// requests while searching for a size accepted by the unchanged impact guard.
const timedFetch=(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(10000)});
export function createPacedFetch(fetcher=timedFetch,{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),intervalMs=11000}={}){
 let tail=Promise.resolve(),next=0;
 return (...args)=>{const request=tail.then(async()=>{const delay=next-now();if(delay>0)await sleep(delay);next=now()+intervalMs;return fetcher(...args);});tail=request.catch(()=>{});return request;};
}
const pacedFetch=createPacedFetch();
export async function kyber(path,body,fetcher=pacedFetch){
 const r=await fetcher('https://aggregator-api.kyberswap.com/robinhood/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','x-client-id':'turret-buyback'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error'});
 if(!r.ok||!r.body){
  const error=Error(r.status===429?'quote_rate_limited':'quote_unavailable');error.httpStatus=r.status;
  if(r.status===429){const header=r.headers.get('retry-after'),seconds=header!==null&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):NaN,date=Date.parse(header??'');error.retryAfterMs=Math.max(60000,Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-Date.now():60000);}
  await r.body?.cancel().catch(()=>{});throw error;
 }
 const reader=r.body.getReader();let size=0,parts=[];try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>250000)throw Error('quote_too_large');parts.push(x.value);}}finally{await reader.cancel().catch(()=>{});}
 const b=JSON.parse(Buffer.concat(parts).toString());if(b.code!==0||!b.data)throw Error('no_route');return b.data;
}
export async function route(amount,fetcher){
 const q=new URLSearchParams({tokenIn:USDG,tokenOut:TOKEN,amountIn:String(amount),includedSources:SWAP_SOURCES.join(','),excludeRFQSources:'true'});
 const r=await kyber('routes?'+q,undefined,fetcher);if(!sameAddress(r.routerAddress,SWAP_ROUTER))throw Error('router_mismatch');
 validateSwapRoute(r.routeSummary,{payToken:'USDG',amountIn:String(amount)}, {collateral:TOKEN});return r.routeSummary;
}
export function checkImpact(amount,out,probeAmount,probeOut){
 if(amount<=0n||out<=0n||probeAmount<=0n||probeOut<=0n||out*probeAmount*10000n<probeOut*amount*9900n)throw Error('price_impact_exceeds_one_percent');
}
export async function quote(module,amount,fetcher,{limitImpact=true}={}){
 if(amount<1000000n)throw Error('below_trade_threshold');
 // Fetch the reference first so pacing does not age the executable route.
 const p=limitImpact?await route(amount/10n,fetcher):null,r=await route(amount,fetcher);
 if(limitImpact){
  validateSwapRoute(p,{payToken:'USDG',amountIn:String(amount/10n)},{collateral:TOKEN});
  checkImpact(amount,BigInt(r.amountOut),amount/10n,BigInt(p.amountOut));
 }
 const expiresAt=r.timestamp*1000+30000;
 const b=await kyber('route/build',{routeSummary:r,sender:module,recipient:module,slippageTolerance:49.99,deadline:Math.floor(Date.now()/1000)+90,source:'turret-buyback'},fetcher);
 if(!sameAddress(b.routerAddress,SWAP_ROUTER)||b.amountIn!==String(amount))throw Error('build_mismatch');
 const input={payToken:'USDG',amountIn:String(amount),slippageBps:50};
 validateSwapTransaction({quoteId:'buyback',expiresAt,account:module,chainId:4663,transaction:{to:b.routerAddress,data:b.data,value:b.transactionValue}},{id:'buyback',expiresAt,routeSummary:r},input,{collateral:TOKEN},module);
 if(expiresAt<Date.now()+5000)throw Error('quote_expiring');
 return {execution:decodeFunctionData({abi:swapAbi,data:b.data}).args[0],deadline:BigInt(Math.floor(expiresAt/1000)),amount,expected:BigInt(r.amountOut)};
}

// Respect the hourly maximum while retaining the price-impact guard in thin markets.
// Only an explicit impact failure permits downsizing; transport/validation failures stop.
export async function quoteWithinBudget(module,budget,makeQuote=quote){
 let amount=budget;
 for(let attempt=0;attempt<8&&amount>=1000000n;attempt++){
  try{return await makeQuote(module,amount);}catch(e){if(e.message==='quote_rate_limited')e.candidateAmount=amount;if(e.message!=='price_impact_exceeds_one_percent')throw e;amount/=2n;}
 }
 throw Error('no_size_within_price_impact_limit');
}

// A successful full-budget purchase must use the entire live contract budget.
// Route freshness, calldata validation and quote slippage checks still apply.
export function quoteFullBudget(module,budget,fetcher){return quote(module,budget,fetcher,{limitImpact:false});}
export function quoteForPolicy(policy='impact-limited'){
 if(policy==='impact-limited')return quoteWithinBudget;
 if(policy==='full-budget')return quoteFullBudget;
 throw Error('invalid_sizing_policy');
}
