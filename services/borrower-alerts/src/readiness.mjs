const REASONS=new Set(['ready','price_unavailable','liveness_unavailable','positions_unavailable','catching_up','unavailable']);
const fresh=(timestamp,now)=>Number.isSafeInteger(timestamp)&&timestamp>0&&timestamp<=now&&now-timestamp<90000;

// Expiry is applied when responding, so a stalled scan cannot leave either
// risk readiness or partial monitoring advertised indefinitely.
export function monitorReadiness(monitor,now=Date.now()){
 const monitorReady=fresh(monitor.healthyAt,now);
 const monitorOperational=fresh(monitor.operationalAt??monitor.healthyAt,now);
 return {
  monitorReady,monitorOperational,
  monitorReason:monitorReady?'ready':monitorOperational&&REASONS.has(monitor.monitorReason)?monitor.monitorReason:'unavailable',
  lastMonitorCheckAt:monitorOperational?(monitor.operationalAt??monitor.healthyAt):null,
  lastRiskCheckAt:monitorReady?monitor.healthyAt:null,
 };
}
