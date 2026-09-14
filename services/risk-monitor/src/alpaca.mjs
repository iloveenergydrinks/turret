import {parseUnits} from './deps.mjs';
export class DataFault extends Error {constructor(code){super(code);this.name=code;}}
export async function requestSnapshots({key,secret,feed='iex',recentExecutions=false,corroborationWindowSeconds=30},symbols,fetcher=fetch) {
 if(!key||!secret)throw new DataFault('MarketDataCredentialsMissing');
 if(!['iex','sip','boats'].includes(feed)||![30,60].includes(corroborationWindowSeconds)||!symbols.length||symbols.some(s=>!/^([A-Z]{1,6})$/.test(s)))throw new DataFault('MarketDataConfiguration');
 const url=new URL('https://data.alpaca.markets/v2/stocks/snapshots');
 url.searchParams.set('symbols',symbols.join(','));url.searchParams.set('feed',feed);
 const request=async target=>{
 let response;
 try{response=await fetcher(target,{headers:{'APCA-API-KEY-ID':key,'APCA-API-SECRET-KEY':secret},redirect:'error',signal:AbortSignal.timeout(10000)});}
 catch{throw new DataFault('MarketDataUnavailable');}
 if(!response.ok)throw new DataFault(response.status===401||response.status===403?'MarketDataAccessDenied':response.status===429?'MarketDataRateLimited':'MarketDataUnavailable');
 let data;try{const text=await response.text();if(text.length>200000)throw new Error();data=JSON.parse(text);}catch{throw new DataFault('MarketDataMalformed');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw new DataFault('MarketDataMalformed');
 return data;
 };
 const [data,recent]=await Promise.all([request(url),recentExecutions?Promise.all(symbols.map(async symbol=>{
  const tradesUrl=new URL(`https://data.alpaca.markets/v2/stocks/${symbol}/trades`);
  tradesUrl.search=new URLSearchParams({feed,sort:'desc',limit:'100',asof:'-',start:new Date(Date.now()-corroborationWindowSeconds*1000).toISOString()}).toString();
  // A failed supplementary request cannot refresh or replace the snapshot.
  try{return await request(tradesUrl);}catch{return null;}
 })):[]]);
 return Object.fromEntries(symbols.map((symbol,i)=>{
  const snapshot=data[symbol]??null;
  if(!snapshot||!recentExecutions)return [symbol,snapshot];
  const execution=corroboratedRecentTrade(recent[i]?.trades,Date.now()/1000,{windowSeconds:corroborationWindowSeconds});
  return [symbol,execution&&Date.parse(execution.t)>Date.parse(snapshot.latestTrade?.t)
   ?{...snapshot,latestTrade:execution}:snapshot];
 }));
}

// The latest-trade endpoint excludes odd lots. Use the original timestamp of
// an actual execution only when at least three distinct, consistent executions
// cover ten shares inside the configured corroboration window. The newest
// execution must still be younger than 30 seconds. Exclude late, average-price,
// contingent, corrected and every unknown sale condition. This is a price
// corroboration input, not evidence of executable collateral liquidity.
export function corroboratedRecentTrade(trades,now,{windowSeconds=30}={}){
 if(![30,60].includes(windowSeconds)||!Number.isFinite(now)||!Array.isArray(trades)||trades.length>100)return null;
 const allowed=new Set(['@','T','I','F']),seen=new Set(),eligible=[];
 for(const trade of trades){
  if(trade?.z!=='C'||!Array.isArray(trade.c)||!trade.c.includes('@')
   ||!trade.c.every(c=>allowed.has(c))||typeof trade.x!=='string'||!trade.x
   ||!Number.isSafeInteger(trade.i)||trade.i<0||!Number.isSafeInteger(trade.s)||trade.s<1||trade.s>1000000000)continue;
  const at=Date.parse(trade.t)/1000,key=`${trade.x}:${trade.i}`;
  if(!Number.isFinite(at)||at>now+2||now-at>=windowSeconds||seen.has(key))continue;
  let price;try{price=price18(trade.p);}catch{continue;}
  seen.add(key);eligible.push({trade,at,price});
 }
 if(eligible.length<3||eligible.reduce((n,x)=>n+x.trade.s,0)<10)return null;
 const prices=eligible.map(x=>x.price),low=prices.reduce((a,b)=>a<b?a:b),high=prices.reduce((a,b)=>a>b?a:b);
 if((high-low)*10000n>low*50n)return null;
 eligible.sort((a,b)=>b.at-a.at);return now-eligible[0].at<30?eligible[0].trade:null;
}
const price18=value=>{
 const s=String(value);
 if(!/^[0-9]+(?:\.[0-9]{1,8})?$/.test(s))throw new DataFault('QuoteInvalid');
 const p=parseUnits(s,18);if(p<=0n||p>10n**30n)throw new DataFault('QuoteInvalid');return p;
};
const time=value=>{const n=Date.parse(value)/1000;if(!Number.isFinite(n))throw new DataFault('QuoteInvalid');return n;};
export function validateSnapshot(snapshot,now,{maxAgeSeconds=60,maxSpreadBps=100,priceBasis='mid',maxQuoteAgeSeconds=maxAgeSeconds}={}) {
 if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<15||maxAgeSeconds>60
  ||!Number.isSafeInteger(maxSpreadBps)||maxSpreadBps<1||maxSpreadBps>100
  ||!['mid','trade','freshest'].includes(priceBasis)||!Number.isSafeInteger(maxQuoteAgeSeconds)||maxQuoteAgeSeconds<15
  ||maxQuoteAgeSeconds>(priceBasis==='mid'?maxAgeSeconds:180))throw new DataFault('InvalidQuotePolicy');
 if(!snapshot?.latestTrade||!snapshot.latestQuote)throw new DataFault('QuoteMissing');
 const trade=price18(snapshot.latestTrade.p),bid=price18(snapshot.latestQuote.bp),ask=price18(snapshot.latestQuote.ap);
 const tradeAt=time(snapshot.latestTrade.t),quoteAt=time(snapshot.latestQuote.t);
 const tradePrice=priceBasis==='trade'||priceBasis==='freshest'&&tradeAt>=quoteAt;
 const tradeAgeLimit=priceBasis==='freshest'&&!tradePrice?maxQuoteAgeSeconds:maxAgeSeconds;
 const quoteAgeLimit=priceBasis==='freshest'&&!tradePrice?maxAgeSeconds:maxQuoteAgeSeconds;
 if(tradeAt>now+2||quoteAt>now+2||now-tradeAt>=tradeAgeLimit||now-quoteAt>=quoteAgeLimit)throw new DataFault('QuoteStale');
 if(ask<bid||(ask-bid)*10000n>bid*BigInt(maxSpreadBps))throw new DataFault('QuoteSpread');
 const mid=(bid+ask)/2n,low=trade<mid?trade:mid,diff=trade>mid?trade-mid:mid-trade;
 if(diff*10000n>low*100n)throw new DataFault('TradeQuoteDisagreement');
 // With an unchanged book, a bid/ask event can predate current executions.
 // Extended admission uses the freshest actual trade or quote event as its
 // independent price. The older event is a bounded disagreement check, never
 // a price whose observation timestamp is advanced to HTTP response time.
 return priceBasis==='mid'
  ?{price:mid,sourceTime:Math.floor(Math.min(tradeAt,quoteAt)),bid,ask}
  :{price:tradePrice?trade:mid,sourceTime:Math.floor(tradePrice?tradeAt:quoteAt),
    quoteTime:Math.floor(quoteAt),tradeTime:Math.floor(tradeAt),
    quoteValidUntil:Math.floor(Math.min(quoteAt,tradeAt))+maxQuoteAgeSeconds,bid,ask};
}
