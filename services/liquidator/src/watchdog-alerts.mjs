import {Alerts,incident} from './alerts.mjs';

// This transport runs in the separate watchdog job, so a dead worker cannot
// suppress its own outage notification. Railway failure status remains a backup.
export async function watchdogNotice(env,role,codes,resolved=false,store){
 const alertEmail=env.RESEND_API_KEY&&env.WATCHDOG_EMAIL_FROM&&env.WATCHDOG_EMAIL_TO?
  {apiKey:env.RESEND_API_KEY,from:env.WATCHDOG_EMAIL_FROM,to:env.WATCHDOG_EMAIL_TO}:undefined;
 const config={alertEmail,alertWebhook:env.WATCHDOG_ALERT_WEBHOOK_URL,alertReminderMs:0,alertLabel:`${role} watchdog`};
 if(!alertEmail&&!config.alertWebhook)return {configured:false,delivered:false};
 // Worker incidents are already emailed by the worker. Callers supply only
 // independent watchdog failures. Recovery remains a log/status event.
 const alerts=new Alerts(store,config);
 if(resolved||!codes.length){
  if(store)await alerts.update([]);
  return {configured:true,delivered:true};
 }
 const event=incident(`${role}_watchdog_outage`,'critical',`${role} needs attention: ${codes.join(', ')}.`);
 let delivered;
 if(store){await alerts.update([event]);delivered=store.get('alertDelivery')?.delivered===true;}
 else delivered=await alerts.deliver(event);
 return {configured:true,delivered};
}
