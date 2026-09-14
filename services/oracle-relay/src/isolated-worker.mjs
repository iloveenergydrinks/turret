import {prepareIsolatedPublication} from './isolated-publication.mjs';
import {readIsolatedReadiness} from './isolated-readiness.mjs';
import {incident,hasAlertDestination} from '../../liquidator/src/alerts.mjs';

// Never expose raw provider exceptions, signed payloads or configuration secrets.
const problem=(code,message)=>incident(code,'critical',message);
export class IsolatedOracleWorker {
  constructor({chain,store,txs,alerts,config,now=Date.now,prepare=prepareIsolatedPublication,readiness=readIsolatedReadiness,
    kind='isolated-pyth-ratio',transactionKind='isolated_oracle_update',snapshotKey='isolatedOracleSnapshot',
    transportCode='isolated_oracle_online',transportMessage='Isolated oracle operator notification transport check.',verificationFeeReserve=1000000000n,
    recoverBeforeProvider=false}) {
    Object.assign(this,{chain,store,txs,alerts,config,now,prepare,readiness,transactionKind,snapshotKey,
      transportCode,transportMessage,verificationFeeReserve,recoverBeforeProvider});
    this.transportUntil=0;this.busy=false;
    this.status={kind,chainId:4663,identityHash:config.identityHash,
      mode:config.mode,startedAt:now(),lastCycle:0,ready:false,cache:null,incidents:[],lastPublication:null};
  }
  health() {
    const time=this.now(),live=this.status.lastCycle>0&&time-this.status.lastCycle<this.config.cycleMaxAgeMs;
    return {live,ready:live&&this.status.ready&&time<this.status.cache?.validUntil&&time<this.transportUntil};
  }
  async cycle() {
    if(this.busy)throw Error('Oracle cycle already running');
    this.busy=true;
    // Publish complete snapshots atomically. A watchdog polling during normal
    // RPC work must not see a half-cleared snapshot as an outage. The previous
    // snapshot still expires at its original cache/heartbeat deadlines.
    const next={...this.status,ready:false,cache:null};
    const incidents=[];let prepared=false,head;
    const {chain,store,txs,config}=this;
    try {
      store.assertLease();
      // Reconcile before contacting the provider or alert transport. A provider
      // outage must never prevent accounting for an already-mined publication.
      try {
        head=await chain.select();
        if(!chain.consistent)throw Error();
        incidents.push(...await txs.recover(head,false));
      }catch{incidents.push(problem('oracle_reconciliation_failed','Unable to reconcile oracle transactions against a consistent chain.'));}
      if(hasAlertDestination(config)&&this.now()>=this.transportUntil) {
        try {
          const ok=await this.alerts.deliver(incident(this.transportCode,'info',this.transportMessage));
          if(ok)this.transportUntil=this.now()+config.alertCheckMs;
        }catch{/* Fixed incident below; no provider error details. */}
      }
      const transportOk=hasAlertDestination(config)&&this.now()<this.transportUntil;
      if(!transportOk)incidents.push(problem('oracle_alert_transport_unverified','Operator notification transport has not been verified.'));
      if(head&&chain.consistent&&!incidents.some(i=>i.code==='oracle_reconciliation_failed')) {
        // Read the cache independently of the signed-price API; never substitute
        // the incoming provider quote for a confirmed on-chain snapshot.
        try {next.cache=await this.readiness({client:chain.client,publication:config.publication,confirmations:config.confirmations,now:this.now});}
        catch{incidents.push(problem('oracle_cache_read_failed','Confirmed oracle cache or deployment verification failed.'));}
        let funded=false;
        try {
          funded=await chain.client.getBalance({address:config.relayAddress})>=config.minEth+config.maxTxFee+this.verificationFeeReserve;
          if(!funded)incidents.push(problem('oracle_unfunded','Oracle relay ETH is below the configured publication reserve.'));
        }catch{incidents.push(problem('oracle_balance_unavailable','Unable to verify the oracle relay gas reserve.'));}
        // API3 may need to cancel an expired nonce precisely when fresh reports
        // cannot be fetched. Its recovery independently binds every signed call.
        if(this.recoverBeforeProvider&&transportOk&&funded&&config.mode==='execute'&&store.pendingTx()){
          try{incidents.push(...await txs.recover(head,true));}
          catch{incidents.push(problem('oracle_recovery_failed','Bounded oracle transaction recovery failed; its nonce remains tracked.'));}
        }
        try {
          const plan=await this.prepare({client:chain.client,key:config.key,caller:config.relayAddress,...config.publication,now:this.now});
          prepared=true;
          if(transportOk&&funded&&config.mode==='execute'&&!incidents.some(i=>i.code==='oracle_cache_read_failed')) {
            // Recovery may replace a pending report, but revalidates its age and
            // original intent. It may not silently replace it with a new report.
            if(!this.recoverBeforeProvider&&store.pendingTx())incidents.push(...await txs.recover(head,true));
            if(!store.pendingTx())incidents.push(...await txs.publish(plan));
          }
        }catch{incidents.push(problem('oracle_publication_failed','Authenticated report preparation or bounded publication failed.'));}
      }
      if(!next.cache?.available)incidents.push(problem('oracle_cache_unavailable','Confirmed oracle prices are unavailable; price-sensitive market actions must remain blocked.'));
      const pending=store.pendingTx();
      if(pending?.status==='blocked')incidents.push(problem('oracle_journal_blocked','An oracle transaction requires manual reconciliation.'));
      const confirmed=store.transactions().filter(t=>t.kind===this.transactionKind&&t.status==='confirmed').at(-1);
      next.lastPublication=confirmed?{receipt:confirmed.receipt,result:confirmed.publicationResult}:null;
      next.pending=pending?{id:pending.id,status:pending.status}:null;
      try {
        next.incidents=await this.alerts.update(incidents);
        const delivered=store.get('alertDelivery');
        if(!delivered?.delivered)this.transportUntil=0;
      }catch{
        this.transportUntil=0;
        next.incidents=[...incidents,problem('oracle_alert_delivery_failed','Unable to deliver or persist operator notifications.')];
      }
      next.lastCycle=this.now();
      const delivery=store.get('alertDelivery');
      next.operatorAlerts={verifiedUntil:this.transportUntil,delivered:delivery?.delivered===true,checkedAt:delivery?.checkedAt??null};
      next.ready=config.mode==='execute'&&prepared&&Boolean(next.cache?.available)
        &&this.now()<this.transportUntil&&!next.incidents.some(i=>i.severity==='critical');
      store.set(this.snapshotKey,next);
      this.status=next;
      return {...this.status,...this.health()};
    }catch(error){this.status.ready=false;throw error;}
    finally{this.busy=false;}
  }
}
