import {Store} from '../../liquidator/src/store.mjs';
import {watchdogNotice} from '../../liquidator/src/watchdog-alerts.mjs';
import {log} from '../../liquidator/src/chain.mjs';
const url=process.env.RISK_STATUS_URL,token=process.env.RISK_STATUS_TOKEN;
if(!url||!token){log('error','risk_watchdog_configuration_missing');process.exit(1);}
const expectedMode=process.env.RISK_EXPECTED_MODE??'execute';
if(!['observe','execute'].includes(expectedMode)){log('error','risk_watchdog_configuration_invalid');process.exit(1);}
const store=new Store(process.env.RISK_DATA_DIR??'/data',{role:'risk-watchdog',target:new URL(url).host});store.acquireLease();
let codes=[],workerReported=[];
try{
 const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error();
 const s=await response.json();
 codes=(s.incidents??[]).filter(i=>i.severity==='critical').map(i=>i.code);
 if(s.alertDelivery?.delivered)workerReported=[...codes];
 if(!s.live||Date.now()-s.lastCycle>60000)codes.push('monitor_stalled');
 if(s.lastError)codes.push('monitor_cycle_failed');
 if(s.mode!==expectedMode)codes.push('monitor_mode_mismatch');
 if(process.env.RISK_EXPECTED_VAULT&&s.vault?.toLowerCase()!==process.env.RISK_EXPECTED_VAULT.toLowerCase())codes.push('monitor_vault_mismatch');
 if(!s.alertDelivery?.delivered)codes.push('operator_alerts_unavailable');
}catch{codes=['risk_monitor_unreachable'];}
const old=store.get('problem'),signature=JSON.stringify(codes.sort()),now=Date.now(),same=old?.signature===signature;
if(codes.length){
 const notify=!same||!old?.at||now-old.at>=3600000;
 log('error','risk_watchdog_attention',{codes,notify});
 const independentCodes=codes.filter(code=>!workerReported.includes(code));
 let reported=independentCodes.length===0||(!notify&&same&&old.at>0);
 let nativeSignaled=same&&old?.nativeSignaled===true;
 if(notify){
  const delivery=independentCodes.length
   ?await watchdogNotice(process.env,'risk',independentCodes,false,store)
   :{configured:true,delivered:true};
  reported=delivery.configured&&delivery.delivered;
  const needsRailwaySignal=!reported&&!nativeSignaled;
  nativeSignaled||=needsRailwaySignal;
  store.set('problem',{signature,at:reported?now:old?.at??0,nativeSignaled});
  if(needsRailwaySignal)process.exitCode=1;
 }
}else{
 if(old){log('info','risk_monitor_recovered');const delivery=await watchdogNotice(process.env,'risk',[],true,store);
  if(delivery.configured&&!delivery.delivered)process.exitCode=1;else store.set('problem',null);
 }else store.set('problem',null);
 log('info','risk_watchdog_healthy',{expectedMode});
}
store.close();
