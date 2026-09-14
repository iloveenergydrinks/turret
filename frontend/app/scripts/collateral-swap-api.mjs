import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createPublicClient,http,keccak256,isAddress,zeroAddress} from 'viem';
import {centralStatus,validateCentral} from '../src/borrow/central-credit.ts';
import {PAYMENT_TOKENS,SWAP_ROUTER,SWAP_SOURCES,SWAP_CODE,SWAP_CHAIN,sameAddress,swapNeed,validateSwapInput,validateSwapRoute,validateSwapTransaction} from '../src/borrow/collateral-swap.mjs';

async function readJSON(response,limit=250000) {
  swapNeed(response.ok&&response.body,'The quote service is unavailable. Try again.');
  const reader=response.body.getReader();let bytes=0,chunks=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;swapNeed(bytes<=limit);chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createCollateralSwapAPI({markets=JSON.parse(readFileSync(new URL('../public/borrow-pools.json',import.meta.url))).markets,fetcher=fetch,now=Date.now,
 client=createPublicClient({transport:http('https://rpc.mainnet.chain.robinhood.com/',{timeout:7000,retryCount:0})}),
 status=market=>centralStatus(validateCentral(market.central),fetcher,now)}={}) {
  const quotes=new Map();let running=0,tokens=20,refilled=now(),verifiedUntil=0;
  const consume=()=>{const time=now();tokens=Math.min(20,tokens+(time-refilled)/1000);refilled=time;swapNeed(tokens>=1&&running<4,'The quote service is busy. Try again shortly.');tokens--;};
  async function ready(market){
    const s=await status(market);
    swapNeed(s.ready&&s.validUntil*1000n>BigInt(now())&&s.availability&&!s.availability.paused
      &&s.availability.cash>0n&&s.availability.debtLimit>s.availability.principal,'Borrowing is currently unavailable in this market. Try again later.');
  }
  async function verifyContracts(){
    if(verifiedUntil>now())return;
    swapNeed(await client.getChainId()===SWAP_CHAIN);
    for(const [address,hash]of Object.entries(SWAP_CODE)) {
      const code=await client.getCode({address});swapNeed(code&&keccak256(code)===hash,'The swap router needs verification. Swapping is unavailable.');
    }
    verifiedUntil=now()+60000;
  }
  async function kyber(path,body){
    const response=await fetcher('https://aggregator-api.kyberswap.com/robinhood/api/v1/'+path,{
      method:body?'POST':'GET',headers:{'x-client-id':'turret-collateral','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(8000),
    });
    const result=await readJSON(response);swapNeed(result.code===0&&result.data,'No supported swap route was found. Try another amount or payment token.');return result.data;
  }
  async function quote(input) {
    const market=validateSwapInput(input,markets);await ready(market);
    const query=new URLSearchParams({tokenIn:PAYMENT_TOKENS[input.payToken].address,tokenOut:market.collateral,amountIn:input.amountIn,
      includedSources:SWAP_SOURCES.join(','),excludeRFQSources:'true',gasInclude:'true'});
    const r=await kyber('routes?'+query);swapNeed(sameAddress(r.routerAddress,SWAP_ROUTER));
    validateSwapRoute(r.routeSummary,input,market,now());
    for(const [key,value]of quotes)if(value.quote.expiresAt<=now())quotes.delete(key);
    if(quotes.size>=256)quotes.delete(quotes.keys().next().value);
    const result={id:randomUUID(),routeSummary:r.routeSummary,expiresAt:Math.min(now()+30000,r.routeSummary.timestamp*1000+30000)};
    swapNeed(result.expiresAt>now()+5000,'This quote expired. Refresh the quote.');
    quotes.set(result.id,{input:{engine:market.engine,payToken:input.payToken,amountIn:input.amountIn,slippageBps:input.slippageBps},quote:result});
    return result;
  }
  async function build(input) {
    swapNeed(typeof input.quoteId==='string'&&isAddress(input.account)&&!sameAddress(input.account,zeroAddress));
    const entry=quotes.get(input.quoteId);swapNeed(entry&&entry.quote.expiresAt>now()+5000,'This quote expired. Refresh the quote.');
    const market=validateSwapInput(entry.input,markets);
    await Promise.all([ready(market),verifyContracts()]);
    const data=await kyber('route/build',{routeSummary:entry.quote.routeSummary,sender:input.account,recipient:input.account,
      // Slightly tighter than the reviewed tolerance to absorb upstream one-wei rounding.
      slippageTolerance:entry.input.slippageBps-0.01,deadline:Math.floor(now()/1000)+120,source:'turret-collateral'});
    swapNeed(sameAddress(data.routerAddress,SWAP_ROUTER)&&data.amountIn===entry.input.amountIn);
    const result={quoteId:input.quoteId,account:input.account,chainId:SWAP_CHAIN,expiresAt:entry.quote.expiresAt,
      transaction:{to:SWAP_ROUTER,data:data.data,value:data.transactionValue}};
    validateSwapTransaction(result,entry.quote,entry.input,market,input.account,now());
    return result;
  }
  return async function handler(req,res,headers={}) {
    const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/collateral-swap/'))return false;
    const send=(code,data)=>res.writeHead(code,{...headers,'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));
    if(req.method!=='POST'){send(405,{error:'Use POST.'});return true;}
    if(!['/api/collateral-swap/quote','/api/collateral-swap/build','/api/collateral-swap/status'].includes(url.pathname)){send(404,{error:'Not found.'});return true;}
    const origin=req.headers.origin;
    if(req.headers['sec-fetch-site']==='cross-site'||origin&&(()=>{try{return new URL(origin).host!==req.headers.host;}catch{return true;}})()) {send(403,{error:'Use the swap form on Turret.'});return true;}
    if(!(req.headers['content-type']||'').startsWith('application/json')){send(415,{error:'Expected JSON.'});return true;}
    try{consume();}catch(e){send(429,{error:e.message});return true;}
    running++;
    try {
      let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;swapNeed(size<=2048,'Request is too large.');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(url.pathname.endsWith('/status')) {
        const market=markets.find(m=>sameAddress(m.engine,body.engine)&&m.admission==='active'&&m.chainId===SWAP_CHAIN&&m.central);
        swapNeed(market,'This collateral market is unavailable.');validateCentral(market.central);
        send(200,await readJSON(await fetcher(new URL('/v1/markets/'+market.central.id,market.central.apiUrl),{redirect:'error',signal:AbortSignal.timeout(5000)}),20000));
      } else send(200,url.pathname.endsWith('/quote')?await quote(body):await build(body));
    } catch(e) {send(400,{error:e instanceof Error&&/^(Enter |Choose |This |The |Borrowing |No supported |Request )/.test(e.message)?e.message:'The swap could not be prepared. Refresh the quote and try again.'});}
    finally{running--;}
    return true;
  };
}
