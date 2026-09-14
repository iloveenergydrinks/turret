import {parentPort,workerData} from 'node:worker_threads';
import {createPublicClient,http} from './deps.mjs';
import {WeekendStore} from './weekend-store.mjs';
import {collectWeekendObservation} from './weekend-collection.mjs';

const {manifest,rpcUrls,directory}=workerData;
const clients=rpcUrls.map(url=>createPublicClient({transport:http(url,{timeout:5000,retryCount:0}),cacheTime:0}));
let store;
try{
 store=new WeekendStore(directory,manifest.vault);
 for(;;){
  const start=Date.now();
  const sample=await collectWeekendObservation({clients,manifest});
  store.save(sample);
  parentPort.postMessage({type:'sample',sample,history:store.summary(),recent:store.recent()});
  await new Promise(resolve=>setTimeout(resolve,Math.max(1000,60000-(Date.now()-start))));
 }
}catch{
 parentPort.postMessage({type:'fault'});
 process.exitCode=1;
}finally{store?.close();}
