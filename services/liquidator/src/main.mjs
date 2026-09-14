import { configFromEnv } from './config.mjs';
import { Store } from './store.mjs';
import { Chain,errorCode,log } from './chain.mjs';
import { Alerts,incident,hasAlertDestination } from './alerts.mjs';
import { Transactions } from './transactions.mjs';
import { Engine } from './engine.mjs';
import { createStatusServer } from './http.mjs';
import {acceptSharedTransportVerification} from './transport-verification.mjs';

let config;
try { config=configFromEnv(); }
catch { log('error','invalid_configuration'); process.exit(1); }
let chain,store;
try {
  chain=new Chain(config);
  store=new Store(config.dataDir,{chainId:config.chainId,vault:config.vault.toLowerCase(),account:chain.account?.address.toLowerCase() ?? null});
  store.acquireLease();
} catch {log('error','keeper_startup_failed');process.exit(1);}
const alerts=new Alerts(store,config);
acceptSharedTransportVerification(store,process.env.KEEPER_ALERT_TRANSPORT_PREVERIFIED_AT,hasAlertDestination(config));
const transactions=new Transactions(chain,store,config);
const engine=new Engine(chain,store,config,transactions);
const status={startedAt:Date.now(),lastProgress:Date.now(),snapshot:undefined,lastError:null};
const server=createStatusServer(config,()=>({...status,alertDelivery:store.get('alertDelivery')}));
server.listen(config.port,'::',()=>log('info','keeper_started',{mode:config.mode,chainId:config.chainId,vault:config.vault,account:chain.account?.address,port:config.port}));
let stopped=false;
let delay;
const leaseTimer=setInterval(()=>{
  try {store.renewLease();}
  catch {log('error','lease_lost');process.exit(1);}
},10000);
leaseTimer.unref();
// Exit a live-but-stuck process so Railway ALWAYS can recover it. The external
// watchdog remains necessary for host outages, container death and event-loop hangs.
const stallTimer=setInterval(()=>{
  if (Date.now()-status.lastProgress > config.heartbeatMaxAgeMs*2) {log('error','worker_stalled');process.exit(1);}
},10000);
stallTimer.unref();
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stopped=true;delay?.();});
let lastSummary=0,lastTransport=0;
while (!stopped) {
  try {
    // Bootstrap once; real incident deliveries and the independent watchdog
    // detect transport failure. Do not send hourly test messages to the inbox.
    if(hasAlertDestination(config)&&!store.get('transportVerified')&&Date.now()-lastTransport>300000){
      lastTransport=Date.now();
      const delivered=await alerts.deliver(incident('keeper_transport_check','info','Turret keeper operator alert check.'));
      store.set('transportVerified',delivered);if(delivered)lastTransport=Date.now();
    }
    const snapshot=await engine.cycle();
    if(hasAlertDestination(config)&&!store.get('transportVerified'))snapshot.incidents.push(incident('alert_transport_failed','critical','The operator alert transport check failed.'));
    const activeAlerts=await alerts.update(snapshot.incidents);
    snapshot.incidents=activeAlerts;
    status.snapshot=snapshot;status.lastError=null;status.lastProgress=Date.now();
    store.set('lastSnapshot',snapshot);
    if (Date.now()-lastSummary > 60000) {
      log('info','scan_complete',{head:snapshot.head,indexedTo:snapshot.index.cursor,reconciled:snapshot.reconciled,positions:snapshot.openPositions,unhealthy:snapshot.unhealthyPositions,critical:activeAlerts.filter(x=>x.severity === 'critical').length});
      lastSummary=Date.now();
    }
  } catch (error) {
    chain.recordFailure();
    status.lastError={code:errorCode(error),at:Date.now()};
    log('error','scan_failed',status.lastError);
    // Retain existing unresolved incidents when a complete scan cannot be obtained.
    const previous=Object.values(store.get('alerts') ?? {});
    await alerts.update([...previous,incident('scan_failed','critical','The keeper could not complete a reconciled scan. New transactions are blocked.',status.lastError)]);
  }
  if (!stopped) await new Promise(resolve=>{const timer=setTimeout(resolve,config.pollMs);delay=()=>{clearTimeout(timer);resolve();};});
}
clearInterval(leaseTimer);clearInterval(stallTimer);
server.close();store.close();log('info','keeper_stopped');
