import { isolatedConfigFromEnv } from './config.mjs';
import { IsolatedChain } from './chain.mjs';
import { IsolatedTransactions } from './transactions.mjs';
import { IsolatedEngine } from './engine.mjs';
import { Store } from '../store.mjs';
import { Alerts,incident } from '../alerts.mjs';
import { errorCode,log } from '../chain.mjs';
import { createStatusServer } from '../http.mjs';
import { acceptSharedTransportVerification } from '../transport-verification.mjs';

let config,chain,store,startupStage='config';
try {
  config=isolatedConfigFromEnv();
  startupStage='chain';
  chain=new IsolatedChain(config);
  startupStage='store';
  store=new Store(config.dataDir,{protocol:config.stock?'stock-isolated-v1':'isolated-v1',chainId:config.chainId,vault:config.vault.toLowerCase(),pool:config.pool.toLowerCase(),executor:config.executor?.toLowerCase() ?? null,account:chain.account?.address.toLowerCase() ?? null});
  startupStage='lease';
  const leaseDeadline=Date.now()+150_000;
  let waitingLogged=false;
  while (true) {
    try {store.acquireLease();break;}
    catch (error) {
      if(error?.message!=='Another keeper owns this volume'||Date.now()>=leaseDeadline)throw error;
      if(!waitingLogged){log('info','isolated_waiting_for_previous_lease');waitingLogged=true;}
      await new Promise(resolve=>setTimeout(resolve,5_000));
    }
  }
} catch (error) {
  const reason=error?.message==='State identity mismatch; use the correct volume'?'state_identity_mismatch':error?.message==='Another keeper owns this volume'?'lease_owned':errorCode(error);
  log('error','isolated_startup_failed',{stage:startupStage,code:reason});process.exit(1);
}
const alerts=new Alerts(store,config);
acceptSharedTransportVerification(store,process.env.KEEPER_ALERT_TRANSPORT_PREVERIFIED_AT,Boolean(config.alertWebhook||config.alertEmail));
const engine=new IsolatedEngine(chain,store,config,new IsolatedTransactions(chain,store,config));
const status={startedAt:Date.now(),lastProgress:Date.now(),snapshot:undefined,lastError:null};
const server=createStatusServer(config,()=>({...status,alertDelivery:store.get('alertDelivery')}));
server.listen(config.port,'::',()=>log('info','isolated_keeper_started',{mode:config.mode,engine:config.vault,pool:config.pool,account:chain.account?.address}));
let stopped=false,delay,lastSummary=0;
// Readiness still requires a successful scan. Restart only when attempts stop
// completing, including their error and alert handling.
let lastAttemptCompletedAt=Date.now();
const timer=setInterval(()=>{
  try {store.renewLease();} catch {log('error','lease_lost');process.exit(1);}
  if (Date.now()-lastAttemptCompletedAt>config.heartbeatMaxAgeMs*2) {log('error','isolated_worker_stalled');process.exit(1);}
},10000);
timer.unref();
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{stopped=true;delay?.();});
while (!stopped) {
  try {
    const snapshot=await engine.cycle();
    snapshot.incidents=await alerts.update(snapshot.incidents);
    status.snapshot=snapshot;status.lastError=null;status.lastProgress=Date.now();
    store.set('lastSnapshot',snapshot);
    if (Date.now()-lastSummary>60000) {
      log('info','isolated_scan_complete',{head:snapshot.head,reconciled:snapshot.reconciled,open:snapshot.openPositions,unhealthy:snapshot.unhealthyPositions});
      lastSummary=Date.now();
    }
  } catch (error) {
    chain.recordFailure();
    status.lastError={code:errorCode(error),at:Date.now()};
    log('error','isolated_scan_failed',status.lastError);
    await alerts.update([...Object.values(store.get('alerts') ?? {}),incident('scan_failed','critical','Isolated market scan failed. Fresh transactions are blocked.',status.lastError)]);
  }
  lastAttemptCompletedAt=Date.now();
  if (!stopped) await new Promise(resolve=>{const t=setTimeout(resolve,config.pollMs);delay=()=>{clearTimeout(t);resolve();};});
}
clearInterval(timer);server.close();store.close();log('info','isolated_keeper_stopped');
