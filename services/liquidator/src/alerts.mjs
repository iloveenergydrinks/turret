import { log } from './chain.mjs';

export const incident = (code, severity, message, details = {}) => ({ code, severity, message, details });
export function rpcConsistencyIncident(chain) {
  if(chain.consistent)return undefined;
  const details=chain.consistency??{status:'unavailable'};
  return details.status==='hash_mismatch'
    ? incident('rpc_disagreement','critical','RPC providers returned different hashes for the same block; execution is blocked.',details)
    : incident('rpc_comparison_unavailable','critical','RPC block comparison could not be completed; execution is blocked.',details);
}
export const hasAlertDestination = config => Boolean(config.alertWebhook || config.alertEmail);
const isTransientInfrastructureAlert=code=>code==='scan_failed'||code==='oracle_blocked'||code.startsWith('oracle_blocked:');
export class Alerts {
  constructor(store, config) { this.store=store; this.config=config; }
  async deliver(event) {
    log(event.severity === 'critical' ? 'error' : 'warn', 'alert', event);
    if (!hasAlertDestination(this.config)) return false;
    try {
      const email=this.config.alertEmail;
      const label=this.config.alertLabel??'Keeper';
      const text=`Turret operations — ${label}: ${event.severity.toUpperCase()} ${event.code}: ${event.message}`;
      const response = await fetch(this.config.alertWebhook || 'https://api.resend.com/emails', {
        method:'POST', redirect:'error', headers:{'Content-Type':'application/json',...(!this.config.alertWebhook?{Authorization:`Bearer ${email.apiKey}`}:{})}, signal:AbortSignal.timeout(10000),
        body:JSON.stringify(this.config.alertWebhook?{text,event}:{from:email.from,to:[email.to],subject:`[Turret ops] ${label}: ${event.code}`,text}, (_, v) => typeof v === 'bigint' ? v.toString() : v),
      });
      if (!response.ok) throw new Error('Webhook rejected');
      return true;
    } catch { log('error','alert_delivery_failed',{ code:event.code }); return false; }
  }
  async update(incidents) {
    const now=Date.now(), previous=this.store.get('alerts') ?? {}, next={};
    // Notification history outlives recovery. Actual health stays separate: a
    // notification cooldown must never delay a safety stop or fabricate a fault.
    const history=this.store.get('alertNotifications') ?? {...previous};
    const unique = new Map(incidents.map(x => [x.code,x]));
    let delivered = true;
    for (const entry of unique.values()) {
      const saved=history[entry.code];
      const active=previous[entry.code];
      // Scheduled watchdogs may not run during the whole healthy interval.
      // A resolved incident becomes new again after a day without recurrence.
      const old=saved&&!previous[entry.code]&&now-saved.lastSeen>Math.max(this.config.alertReminderMs??0,86400000)?undefined:saved;
      const record={ ...entry, firstSeen:active?.firstSeen ?? now, lastSeen:now, lastNotified:old?.lastNotified ?? 0 };
      // This is a static treasury-holding policy, not a new incident. Exposure
      // and failed executable-quote checks have their own actionable alerts.
      const emailEligible=!entry.code.startsWith('liquidity_unknown:');
      const escalation=Boolean(old)&&entry.severity==='critical'&&old.severity!=='critical';
      const reminder=this.config.alertReminderMs>0&&now-record.lastNotified>=this.config.alertReminderMs;
      const debounceMs=isTransientInfrastructureAlert(entry.code)?this.config.alertDebounceMs??0:0;
      const debouncing=debounceMs>0&&now-record.firstSeen<debounceMs;
      const neverNotified=record.lastNotified===0;
      if (emailEligible&&!debouncing&&(!old || neverNotified || old.deliveryPending || escalation || reminder)) {
        const ok=await this.deliver(record);
        // Failed delivery retries next cycle (limited by the worker poll interval).
        if (ok || !hasAlertDestination(this.config)) record.lastNotified=now;
        record.deliveryPending=hasAlertDestination(this.config)&&!ok;
        if (record.deliveryPending) delivered=false;
      }
      history[entry.code]={...record,severity:old?.severity==='critical'?'critical':record.severity};
      next[entry.code]=record;
    }
    for (const old of Object.values(previous)) if (!unique.has(old.code)) {
      log('info','alert_resolved',{code:old.code,resolvedAt:now});
      // Recovery is visible in status/logs, without another inbox notification.
      if(history[old.code])history[old.code].deliveryPending=false;
    }
    for(const [code,record] of Object.entries(history))if(!unique.has(code)&&now-record.lastSeen>Math.max(this.config.alertReminderMs??0,86400000))delete history[code];
    this.store.set('alertNotifications',history);
    this.store.set('alerts',next);
    this.store.set('alertDelivery',{ configured:Boolean(hasAlertDestination(this.config) || this.config.nativeWatchdog), transport:this.config.alertWebhook ? 'webhook' : this.config.alertEmail ? 'resend' : this.config.nativeWatchdog ? 'railway-watchdog' : 'none', delivered: hasAlertDestination(this.config) ? delivered : false, checkedAt:now });
    return Object.values(next);
  }
}
