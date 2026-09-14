import { log } from './chain.mjs';
import { Store } from './store.mjs';
import {watchdogNotice} from './watchdog-alerts.mjs';

// Run separately from the keeper. A detected incident is a successful watchdog
// run once the worker or watchdog has delivered it. Exit nonzero only when the
// incident could not be reported, so Railway remains the delivery fallback
// without labelling handled protocol incidents as process crashes.
const url=process.env.KEEPER_STATUS_URL;
const token=process.env.KEEPER_STATUS_TOKEN;
if (!url || !token) {log('error','watchdog_configuration_missing');process.exit(1);}
const stock=process.env.KEEPER_EXPECTED_KIND==='stock';
const expectedMode=process.env.KEEPER_EXPECTED_MODE??'execute';
if(!['observe','execute'].includes(expectedMode)){log('error','watchdog_mode_invalid');process.exit(1);}
const stockBindings={engine:'KEEPER_EXPECTED_VAULT',pool:'KEEPER_EXPECTED_POOL',executionGate:'KEEPER_EXPECTED_GATE',
  collateral:'KEEPER_EXPECTED_COLLATERAL',account:'KEEPER_EXPECTED_ACCOUNT',codeHash:'KEEPER_EXPECTED_CODE_HASH',poolCodeHash:'KEEPER_EXPECTED_POOL_CODE_HASH'};
if(process.env.KEEPER_EXPECTED_KIND&&!['stock','pilot'].includes(process.env.KEEPER_EXPECTED_KIND)
  ||stock&&Object.entries(stockBindings).some(([key,name])=>!(key.endsWith('Hash')?/^0x[0-9a-fA-F]{64}$/:/^0x[0-9a-fA-F]{40}$/).test(process.env[name]??''))){
  log('error','watchdog_stock_configuration_invalid');process.exit(1);
}
const store=new Store(process.env.KEEPER_DATA_DIR ?? '/data',{role:'watchdog',target:new URL(url).host});
store.acquireLease();
let problem,workerReported=[];
try {
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error('Status unavailable');
  const status=await response.json();
  const critical=status.snapshot?.incidents?.filter(x=>x.severity === 'critical') ?? [];
  if(status.alertDelivery?.delivered)workerReported=critical.map(x=>x.code);
  if(status.snapshot?.mode!==expectedMode)critical.push({code:'keeper_mode_mismatch'});
  if(!status.alertDelivery?.delivered)critical.push({code:'operator_alerts_unavailable'});
  if(stock){
    const s=status.snapshot;
    if(s?.marketKind!=='stock'||s.chainId!==4663
      ||Object.entries(stockBindings).some(([key,name])=>s?.[key]?.toLowerCase()!==process.env[name].toLowerCase()))critical.push({code:'keeper_stock_binding_mismatch'});
    // A worker-reported outage is already actionable. Do not relabel it as
    // wrong deployment wiring or send a duplicate independent notification.
    if(expectedMode==='execute'&&!status.operational&&!critical.length)critical.push({code:'keeper_not_operational'});
  }else if(process.env.KEEPER_EXPECTED_VAULT&&status.snapshot?.vault?.toLowerCase()!==process.env.KEEPER_EXPECTED_VAULT.toLowerCase())critical.push({code:'keeper_vault_mismatch'});
  if(!Number.isSafeInteger(status.snapshot?.checkedAt)||status.snapshot.checkedAt>Date.now()+30000)critical.push({code:'keeper_snapshot_invalid'});
  if (!status.alive || !status.snapshot?.reconciled || status.lastError || critical.length || Date.now()-status.snapshot.checkedAt > 180000) {
    if(!status.alive||!status.snapshot?.reconciled||status.lastError||Date.now()-status.snapshot.checkedAt>180000)critical.push({code:'keeper_scan_unhealthy'});
    problem={codes:critical.map(x=>x.code).sort(),alive:status.alive,reconciled:status.snapshot?.reconciled,lastError:status.lastError?.code};
  } else log('info','keeper_watchdog_ok',{head:status.snapshot.head});
} catch {problem={codes:['keeper_unreachable']};}
const previous=store.get('lastProblem');
if (problem) {
  const signature=JSON.stringify(problem),now=Date.now(),same=previous?.signature===signature;
  const notify=!same||!previous?.notifiedAt||now-previous.notifiedAt>=3600000;
  log('error','keeper_attention_required',{...problem,notify});
  const independentCodes=problem.codes.filter(code=>!workerReported.includes(code));
  let reported=independentCodes.length===0||(!notify&&same&&previous.notifiedAt>0);
  let nativeSignaled=same&&previous?.nativeSignaled===true;
  if (notify) {
    const delivery=independentCodes.length
      ?await watchdogNotice(process.env,'keeper',independentCodes,false,store)
      :{configured:true,delivered:true};
    reported=delivery.configured&&delivery.delivered;
    const needsRailwaySignal=!reported&&!nativeSignaled;
    nativeSignaled||=needsRailwaySignal;
    store.set('lastProblem',{signature,notifiedAt:reported?now:previous?.notifiedAt??0,nativeSignaled});
    if(needsRailwaySignal)process.exitCode=1;
  }
  // An unchanged failure that already reached Railway must not create a failed
  // cron deployment every five minutes. Direct delivery keeps retrying above.
} else {
  if (previous) {
    log('info','keeper_recovered');
    const delivery=await watchdogNotice(process.env,'keeper',[],true,store);
    if(delivery.configured&&!delivery.delivered)process.exitCode=1;else store.set('lastProblem',null);
  } else store.set('lastProblem',null);
}
store.close();
