import {Worker} from 'node:worker_threads';
import {join} from 'node:path';

export const WEEKEND_REVISION='aapl-weekend-observer-v1';
export function publicWeekendSnapshot(state,now=Math.floor(Date.now()/1000)){
 const s=state?.latest,live=Boolean(s&&!state.error&&now>=s.checkedAt&&now-s.checkedAt<=150);
 const sources=s?.sources?structuredClone(s.sources):null;
 if(sources?.kraken&&s.kraken){
  sources.kraken.tradeAgeSeconds=now-s.kraken.latestTradeAt;
  sources.kraken.fresh=live&&sources.kraken.tradeAgeSeconds>=-2&&sources.kraken.tradeAgeSeconds<s.kraken.maxTradeAgeSeconds;
 }
 return {revision:WEEKEND_REVISION,mode:'observation',symbol:'AAPL',borrowingEnabled:false,
  enabled:state?.enabled===true,live,checkedAt:s?.checkedAt??null,
  observationComplete:live&&s.observationComplete===true,
  code:!state?.enabled?'disabled':state.error??(!live?'observation_unavailable':s.code),
  sources,history:state?.history??null,
  limitations:['Observation data does not authorize borrowing.','Kraken xStocks are a different token from Robinhood collateral.','Pool sales are simulations, not executed trades.','The current market retains its existing oracle and trading schedule.']};
}

export function startWeekendObserver({manifest,rpcUrls,dataDir}, {WorkerClass=Worker}={}){
 // The pilot is deliberately restricted to the one reviewed AAPL route.
 const enabled=manifest.kind==='stock-pool'&&manifest.chainId===4663&&manifest.markets?.length===1
  &&manifest.markets[0].symbol==='AAPL'&&Boolean(manifest.continuousSessionAdmission?.route);
 const state={enabled};let worker,restart,closed=false,lastActivity=Date.now();
 const boot=()=>{
  if(closed||!enabled)return;
  try{
   lastActivity=Date.now();
   worker=new WorkerClass(new URL('./weekend-worker.mjs',import.meta.url),{
    workerData:{manifest,rpcUrls:rpcUrls.slice(0,2),directory:join(dataDir,'weekend-observer')},
    // No guardian, keeper, notification or status credentials in this worker.
    env:{NODE_ENV:'production'},resourceLimits:{maxOldGenerationSizeMb:128},
   });
   worker.on('message',message=>{
    if(message?.type==='sample'){lastActivity=Date.now();state.latest=message.sample;state.history=message.history;state.recent=message.recent;delete state.error;}
    else if(message?.type==='fault')state.error='observer_storage_unavailable';
   });
   worker.on('error',()=>{state.error='observer_worker_unavailable';});
   worker.on('exit',()=>{if(!closed){state.error='observer_worker_unavailable';restart=setTimeout(boot,60000);restart.unref();}});
   worker.unref();
  }catch{state.error='observer_worker_unavailable';restart=setTimeout(boot,60000);restart.unref();}
 };
 boot();
 const watchdog=setInterval(()=>{
  if(enabled&&!closed&&worker&&Date.now()-lastActivity>180000){
   state.error='observer_worker_stalled';lastActivity=Date.now();void worker.terminate();
  }
 },30000);watchdog.unref();
 return {publicSnapshot:()=>publicWeekendSnapshot(state),
  snapshot:()=>({...publicWeekendSnapshot(state),latest:state.latest??null,recent:state.recent??[]}),
  close:async()=>{closed=true;clearTimeout(restart);clearInterval(watchdog);await worker?.terminate();}};
}
