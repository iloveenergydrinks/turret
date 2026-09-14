import {sessionAt} from './calendar.mjs';
import {requestKrakenWeekendSnapshot} from './weekend-kraken.mjs';
import {observeWeekendOnchain} from './weekend-onchain.mjs';

const demand=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{name:code});};
// Never expose transport error messages, which may contain an authenticated URL.
const code=error=>/^(Weekend|Kraken)[A-Za-z0-9]{1,70}$/.test(error?.name??'')?error.name:'ObservationSourceUnavailable';
// Observer-only tolerance for subsecond blocks; matches the current risk default.
const WEEKEND_MAX_PROVIDER_LAG_BLOCKS=40n;
export async function agreedWeekendHead(clients,now=()=>Math.floor(Date.now()/1000)){
 demand(clients.length>=1&&clients.length<=2,'WeekendProviderRequired');
 const states=await Promise.all(clients.map(async client=>{
  const [chainId,head]=await Promise.all([client.getChainId(),client.getBlock()]);
  return {chainId,head};
 }));
 demand(states.every(s=>s.chainId===4663),'WeekendWrongChain');
 const last=states.at(-1);
 const low=states[0].head.number<last.head.number?states[0].head.number:last.head.number;
 const high=states[0].head.number>last.head.number?states[0].head.number:last.head.number;
 demand(high-low<=WEEKEND_MAX_PROVIDER_LAG_BLOCKS,'WeekendProviderLag');
 const blocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:low})));
 demand(blocks.every(b=>b?.number===low)&&blocks[0].hash
  &&blocks.every(b=>b.hash===blocks[0].hash&&b.timestamp===blocks[0].timestamp),'WeekendProviderDisagreement');
 const checkedAt=typeof now==='function'?now():now;
 demand(checkedAt>=Number(blocks[0].timestamp)&&checkedAt-Number(blocks[0].timestamp)<=30,'WeekendBlockStale');
 return blocks[0];
}

export async function collectWeekendObservation({clients,manifest,now=()=>Math.floor(Date.now()/1000),
 kraken=requestKrakenWeekendSnapshot,onchain=observeWeekendOnchain}){
 const startedAt=now();
 const [dex,exchange]=await Promise.allSettled([
  (async()=>onchain({client:clients[0],manifest,head:await agreedWeekendHead(clients,now),now}))(),
  kraken({pair:'AAPLxUSD',sellTokenAmounts:[0.1,1,10],maxTradeAgeSeconds:120,allowStaleTrade:true}),
 ]);
 const chain=dex.status==='fulfilled'?dex.value:null;
 // Full books are transient. Keep bounded top-of-book, freshness and depth outcomes.
 let venue=null;
 if(exchange.status==='fulfilled'){const {bids,asks,...rest}=exchange.value;venue=rest;}
 const at=now();
 if(venue){
  venue.tradeAgeSeconds=at-venue.latestTradeAt;
  venue.fresh=venue.fresh&&venue.tradeAgeSeconds<venue.maxTradeAgeSeconds;
  if(!venue.fresh)venue.reason='KrakenStaleTrade';
 }
 const blockers=[...(chain?.blockers??[]),...(venue?.fresh?[]:[venue?.reason??'KrakenUnavailable'])];
 if(clients.length<2)blockers.push('IndependentRpcCorroborationUnavailable');
 if(!chain)blockers.push(code(dex.reason));
 if(exchange.status==='rejected')blockers.push(code(exchange.reason));
 const session=sessionAt(at,manifest.tradingSessionPolicy);
 const comparison={available:false,unitBasisVerified:false,forAdmission:false,
  explanation:'Kraken AAPLx is a different issuer token. Its displayed-token/share basis needs independent confirmation before oracle use.'};
 if(chain?.pool?.spotPriceUsdPerTokenE18&&chain?.token?.multiplier&&venue?.midUsd){
  const equivalent=Number(chain.pool.spotPriceUsdPerTokenE18)/Number(chain.token.multiplier);
  if(Number.isFinite(equivalent)&&equivalent>0){
   comparison.available=true;comparison.robinhoodUsdPerShareEquivalent=equivalent;
   comparison.krakenUsdPerDisplayedToken=venue.midUsd;
   comparison.indicativeDifferenceBps=(equivalent/venue.midUsd-1)*10000;
  }
 }
 // "Complete" means the sample was collected, never that a market is safe to lend.
 const observationComplete=Boolean(chain&&venue&&at-startedAt<=50);
 return {version:1,mode:'observation',symbol:'AAPL',engine:manifest.vault,borrowingEligible:false,
  startedAt,checkedAt:at,observationComplete,code:observationComplete?'observed':'source_unavailable',
  session:{open:session.open,kind:session.kind??'closed',reason:session.reason??null},
  sources:{onchain:{available:Boolean(chain),block:chain?.block??null,providers:clients.length,corroborated:Boolean(chain&&clients.length===2)},
   kraken:{available:Boolean(venue),fresh:venue?.fresh??false,tradeAgeSeconds:venue?.tradeAgeSeconds??null}},
  blockers:[...new Set(blockers)],onchain:chain,kraken:venue,comparison,
  lendingBlockers:['ExistingOracleAndCalendarUnchanged','CrossIssuerUnitBasisUnverified','WeekendHistoryNotYetQualified']};
}
