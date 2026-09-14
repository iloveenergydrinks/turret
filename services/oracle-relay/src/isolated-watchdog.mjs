import {pathToFileURL} from 'node:url';
import {Store} from '../../liquidator/src/store.mjs';
import {watchdogNotice} from '../../liquidator/src/watchdog-alerts.mjs';
import {log} from '../../liquidator/src/chain.mjs';
import {Alerts,incident} from '../../liquidator/src/alerts.mjs';
import {keccak256} from './deps.mjs';

const demand=ok=>{if(!ok)throw Error('Invalid isolated watchdog configuration');};
const hash=x=>typeof x==='string'&&/^0x[\da-f]{64}$/i.test(x)&&!/^0x0{64}$/i.test(x);
export function watchdogConfig(env) {
  const url=new URL(env.ISOLATED_ORACLE_STATUS_URL);
  demand(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)));
  demand(!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/status');
  demand(typeof env.ORACLE_STATUS_TOKEN==='string'&&env.ORACLE_STATUS_TOKEN.length>=32);
  demand(hash(env.ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH));
  if(env.WATCHDOG_ALERT_WEBHOOK_URL)demand(new URL(env.WATCHDOG_ALERT_WEBHOOK_URL).protocol==='https:');
  return {url:url.href,token:env.ORACLE_STATUS_TOKEN,identityHash:env.ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH.toLowerCase(),
    dataDir:env.ORACLE_WATCHDOG_DATA_DIR??'./data/isolated-oracle-watchdog',reminderMs:3600000,timeoutMs:10000};
}

export function snapshotProblems(s,config,now) {
  const codes=[];
  if(!s||typeof s!=='object'||Array.isArray(s))return ['oracle_status_invalid'];
  if(s.kind!==(config.expectedKind??'isolated-pyth-ratio')||s.chainId!==4663||typeof s.identityHash!=='string'||s.identityHash.toLowerCase()!==config.identityHash)codes.push('oracle_identity_mismatch');
  const fresh=time=>Number.isSafeInteger(time)&&time>0&&time<=now&&now-time<30000;
  if(s.live!==true||!fresh(s.lastCycle))codes.push('oracle_process_stalled');
  if(s.mode!=='execute')codes.push('oracle_execution_disabled');
  if(s.ready!==true)codes.push('oracle_not_ready');
  if(!Array.isArray(s.incidents))codes.push('oracle_status_invalid');
  else if(s.incidents.some(i=>i?.severity==='critical'))codes.push('oracle_critical_incident');
  const cache=s.cache;
  if(cache?.available!==true||!fresh(cache.checkedAt)||!Number.isSafeInteger(cache.validUntil)
    ||cache.validUntil<=now||cache.validUntil>now+30000)codes.push('oracle_confirmed_cache_stale');
  if(config.expectedKind==='stock-api3-usdg'&&cache?.latestAvailable!==true)codes.push('oracle_latest_cache_unavailable');
  const alerts=s.operatorAlerts;
  if(alerts?.delivered!==true||!fresh(alerts.checkedAt)||!Number.isSafeInteger(alerts.verifiedUntil)
    ||alerts.verifiedUntil<=now||alerts.verifiedUntil>now+300000)codes.push('oracle_operator_alerts_unavailable');
  return [...new Set(codes)].sort();
}

async function boundedJson(response) {
  const reader=response.body?.getReader();if(!reader)throw Error('Missing status body');
  const chunks=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
      if(length>65536)throw Error('Oversized status');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// One shot, suitable for a separately scheduled process/host. Does not run in
// the relay and has no signing or publication capability.
export async function checkIsolatedOracle({config,store,notify,fetchImpl=fetch,now=Date.now}) {
  store.assertLease();let codes;
  try {
    const response=await fetchImpl(config.url,{headers:{Authorization:`Bearer ${config.token}`},redirect:'error',signal:AbortSignal.timeout(config.timeoutMs)});
    if(!response.ok)throw Error('Status unavailable');
    codes=snapshotProblems(await boundedJson(response),config,now());
  }catch{codes=['oracle_unreachable'];}
  const old=store.get('isolatedOracleProblem'),time=now(),signature=JSON.stringify(codes);
  const deliver=async(recovered,probe=false)=>{
    try{
      const result=await notify(codes,recovered,probe);
      if(result?.configured===true&&result?.delivered===true)store.set('watchdogTransportVerifiedAt',now());
      return result;
    }catch{return {configured:true,delivered:false};}
  };
  let notification='unchanged';
  if(codes.length){
    if(old?.signature!==signature||old?.pending||time-(old?.notifiedAt??0)>=config.reminderMs){
      const result=await deliver(false),ok=result?.configured===true&&result?.delivered===true;
      store.set('isolatedOracleProblem',{signature,notifiedAt:ok?time:old?.notifiedAt??0,pending:!ok});
      notification=ok?'delivered':'failed';
    }
    // Dedup notifications, never turn a continuing outage into a successful job.
    return {healthy:false,exitCode:1,codes,notification};
  }
  if(old){
    const result=await deliver(true),ok=result?.configured===true&&result?.delivered===true;
    if(!ok)return {healthy:false,exitCode:1,codes:['oracle_recovery_notification_failed'],notification:'failed'};
    store.set('isolatedOracleProblem',null);notification='recovered';
  }
  const verified=store.get('watchdogTransportVerifiedAt');
  if(!Number.isSafeInteger(verified)||verified>time||time-verified>=config.reminderMs){
    const result=await deliver(false,true);
    if(result?.configured!==true||result?.delivered!==true)return {healthy:false,exitCode:1,codes:['oracle_watchdog_transport_unverified'],notification:'failed'};
    notification='transport-verified';
  }
  return {healthy:true,exitCode:0,codes:[],notification};
}

export async function main(env=process.env) {
  return runOracleWatchdog(env,{parseConfig:watchdogConfig,check:checkIsolatedOracle,
    kind:'isolated-oracle-watchdog',prefix:'isolated_oracle',transportMessage:'Independent isolated oracle watchdog notification transport check.'});
}

// Entrypoints bind the checker and role in code, never to an executable module
// or class supplied through environment variables.
export async function runOracleWatchdog(env,{parseConfig,check,kind,prefix,transportMessage}) {
  let store;
  try {
    const config=parseConfig(env);
    demand(Boolean(env.WATCHDOG_ALERT_WEBHOOK_URL||(env.RESEND_API_KEY&&env.WATCHDOG_EMAIL_FROM&&env.WATCHDOG_EMAIL_TO)));
    store=new Store(config.dataDir,{kind,target:config.url,identityHash:config.identityHash,
      alertTargetHash:keccak256('0x'+Buffer.from(JSON.stringify(env.WATCHDOG_ALERT_WEBHOOK_URL??[env.WATCHDOG_EMAIL_FROM,env.WATCHDOG_EMAIL_TO])).toString('hex'))});store.acquireLease();
    const result=await check({config,store,notify:async(codes,recovered,probe)=>{
      if(!probe)return watchdogNotice(env,prefix,codes,recovered);
      const alerts=new Alerts(undefined,{alertWebhook:env.WATCHDOG_ALERT_WEBHOOK_URL,
        alertEmail:env.RESEND_API_KEY?{apiKey:env.RESEND_API_KEY,from:env.WATCHDOG_EMAIL_FROM,to:env.WATCHDOG_EMAIL_TO}:undefined});
      return {configured:true,delivered:await alerts.deliver(incident(`${prefix}_watchdog_online`,'info',transportMessage))};
    }});
    log(result.healthy?'info':'error',`${prefix}_watchdog`,result);return result.exitCode;
  }catch{log('error',`${prefix}_watchdog_failed`);return 1;}
  finally{store?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
