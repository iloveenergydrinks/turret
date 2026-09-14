const incidentKey=incidents=>JSON.stringify(incidents.map(i=>[i.code,i.severity]).sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1])));

// Serialize notification attempts and retain only the latest waiting snapshot.
// RPC observations and proof refresh must never await an email/webhook request.
// Admission still requires successful delivery for the current incident set.
export class RiskNotifications {
 constructor(alerts,store,{verifyTransport,now=Date.now,onError=()=>{}}={}){
  Object.assign(this,{alerts,store,verifyTransport,now,onError});
  this.lastTransport=-Infinity;
 }
 request(incidents){
  if(this.closed)return false;
  const key=incidentKey(incidents);
  this.pending={key,incidents:incidents.map(i=>({...i}))};
  this.start();
  return this.result?.key===key&&this.result.delivered&&this.store.get('transportVerified')===true;
 }
 start(){
  if(this.running||this.closed)return;
  this.running=this.drain().finally(()=>{
   this.running=undefined;
   if(this.pending&&!this.closed)this.start();
  });
 }
 async drain(){
  while(this.pending&&!this.closed){
   const current=this.pending;this.pending=undefined;
   try{
    if(this.verifyTransport&&!this.store.get('transportVerified')&&this.now()-this.lastTransport>=300000){
     this.lastTransport=this.now();
     this.store.set('transportVerified',Boolean(await this.verifyTransport()));
    }
    if(this.closed)break;
    await this.alerts.update(current.incidents);
    this.result={key:current.key,delivered:this.store.get('alertDelivery')?.delivered===true};
   }catch{
    this.result={key:current.key,delivered:false};
    this.onError();
   }
  }
 }
 async flush(){while(this.running)await this.running;}
 async close(){this.closed=true;this.pending=undefined;await this.flush();}
}

// A candidate is produced only after the existing chain/recovery validation.
// Notification health affects new admission, never execution liveness itself.
export function publishCycle({status,notifications,incidents,candidates,livenessCandidate,approvals,isStopped,setLiveness,session,mode}) {
 status.incidents=incidents;
 if(status.lastError&&status.liveness){
  status.liveness={...status.liveness,ok:false,code:'cycle_failed',healthySince:undefined,observedAt:undefined};
 }
 setLiveness(!isStopped()&&!status.lastError?livenessCandidate:undefined);
 const delivered=notifications.request(incidents);
 const globalFault=status.lastError||status.incidents.some(i=>!/^risk_[A-Z]+_/.test(i.code)&&i.severity==='critical');
 approvals.clear();
 if(!isStopped()&&!globalFault&&delivered)for(const [key,proof] of candidates)approvals.set(key,proof);
 status.ready=!isStopped()&&mode==='execute'&&!globalFault&&Boolean(delivered)
  &&(approvals.size>0||(!session.open&&session.reason==='market_closed'));
}
