import {createRequire} from 'node:module';
import {Transactions,ReceiptValidationError} from '../../liquidator/src/transactions.mjs';
import {parseEnvelope,PYTH_VERIFIER} from './pyth.mjs';
import {isolatedHubAbi} from './isolated-publication.mjs';
import {incident} from '../../liquidator/src/alerts.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {decodeFunctionData,decodeEventLog,keccak256}=require('viem');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,message)=>{if(!ok)throw new ReceiptValidationError(message);};

// Value is separate from gas. Pending/blocked intents stay reserved regardless
// of age; multiple same-nonce attempts can only pay this value once.
export function verificationValueReserved(transactions,now) {
  demand(Number.isSafeInteger(now)&&now>0,'Invalid verification budget clock');
  return transactions.filter(t=>t.kind==='isolated_oracle_update').reduce((sum,t)=>{
    demand(['pending','blocked','confirmed','reverted'].includes(t.status),'Unknown publication status');
    const value=t.request?.value;
    demand(typeof value==='bigint'&&value>=0n&&value<=1000000000n,'Invalid journal verification value');
    if(t.status==='reverted')return sum;
    if(t.status==='confirmed') {
      // Legacy records lacking a confirmation timestamp remain reserved. Never
      // age a delayed confirmation out using its original submission time.
      const at=t.verificationFeeConfirmedAt;
      if(at!==undefined){
        demand(Number.isSafeInteger(at)&&at>0,'Invalid verification confirmation time');
        if(at<=now-86400000)return sum;
      }
    }
    return sum+value;
  },0n);
}

export function publicationIntent(request,publication) {
  demand(same(request.to,publication.hub),'Unexpected publication target');
  demand(typeof request.value==='bigint'&&request.value>=0n&&request.value<=1000000000n,'Publication fee outside ceiling');
  const decoded=decodeFunctionData({abi:isolatedHubAbi,data:request.data});
  demand(decoded.functionName==='update','Unexpected publication call');
  const signed=decoded.args[0],report=parseEnvelope(signed);
  const ids=[publication.policy.collateralFeedId,publication.policy.usdgFeedId];
  demand(report.feeds.length===2&&new Set(report.feeds.map(f=>f.id)).size===2&&report.feeds.every(f=>ids.includes(f.id)),'Unexpected publication feeds');
  return {signed,report};
}

export async function confirmedPublication(receipt,tx,{publication,account,client}) {
  demand(tx.kind==='isolated_oracle_update','Unexpected journal operation');
  demand(same(receipt.from,account)&&same(receipt.to,publication.hub),'Publication receipt identity mismatch');
  demand(tx.attempts.some(a=>same(a.hash,receipt.transactionHash)),'Untracked publication receipt');
  let report;
  try {({report}=publicationIntent(tx.request,publication));}
  catch {throw new ReceiptValidationError('Invalid persisted publication intent');}
  const events=[];
  for(const log of receipt.logs) {
    if(!same(log.address,publication.hub))continue;
    demand(!log.removed,'Removed publication log');
    let event;
    try{event=decodeEventLog({abi:isolatedHubAbi,data:log.data,topics:log.topics});}
    catch{throw new ReceiptValidationError('Malformed hub publication log');}
    demand(event.eventName==='ReportUpdated','Unexpected hub publication log');
    events.push(event.args);
  }
  demand(new Set(events.map(e=>e.feedId)).size===events.length&&events.every(e=>report.feeds.some(f=>f.id===e.feedId)),'Unexpected or duplicate publication event');
  const updated=[],superseded=[];
  for(const feed of report.feeds) {
    const event=events.find(e=>e.feedId===feed.id);
    if(event)demand(event.timestampUs===feed.timestampUs&&event.feedUpdateTimestampUs===feed.sourceUs&&event.session===feed.session,'Publication event content mismatch');
    const cached=await client.readContract({address:publication.hub,abi:isolatedHubAbi,functionName:'report',args:[feed.id],blockNumber:receipt.blockNumber});
    demand(typeof cached?.timestampUs==='bigint'&&cached.timestampUs>=feed.timestampUs,'Publication did not reach cache');
    if(cached.timestampUs===feed.timestampUs) {
      for(const [key,value] of Object.entries({feedUpdateTimestampUs:feed.sourceUs,price:feed.price,confidence:feed.confidence,
        publishers:feed.publishers,exponent:feed.exponent,session:feed.session}))demand(BigInt(cached[key])===BigInt(value),'Cached publication content mismatch');
    }
    // Another permissionless publisher can win the race. Do not claim we updated
    // a feed when the successful transaction was a no-op for that feed.
    (event?updated:superseded).push(feed.id);
  }
  return {publicationResult:{reportTimestampUs:report.timestampUs,updatedFeedIds:updated,supersededFeedIds:superseded}};
}

export class IsolatedOracleTransactions extends Transactions {
  constructor(chain,store,config,{now=Date.now}={}) { super(chain,store,config); this.now=now; }
  async makeAttempt(request) {
    const p=this.config.publication;
    const {signed,report}=publicationIntent(request,p);
    const head=await this.chain.client.getBlock(),wall=BigInt(Math.floor(this.now()/1000));
    demand(head.hash&&head.timestamp<=wall+15n&&wall-head.timestamp<30n,'Publication signing head stale');
    demand(report.timestampUs<=head.timestamp*1000000n&&head.timestamp*1000000n-report.timestampUs<30000000n,'Publication expired before signing');
    for(const [address,expected] of [[p.hub,p.hubCodeHash],[PYTH_VERIFIER,p.verifierCodeHash]]) {
      const code=await this.chain.client.getCode({address,blockNumber:head.number});
      demand(code&&same(keccak256(code),expected),'Publication signing runtime changed');
    }
    await this.chain.client.simulateContract({address:p.hub,abi:isolatedHubAbi,functionName:'update',args:[signed],value:request.value,
      account:this.chain.account.address,blockNumber:head.number});
    const canonical=await this.chain.client.getBlock({blockNumber:head.number});
    demand(canonical.hash===head.hash&&BigInt(Math.floor(this.now()/1000))*1000000n-report.timestampUs<30000000n,'Publication signing snapshot changed or expired');
    const pending=this.store.pendingTx();
    if(pending)demand(pending.kind==='isolated_oracle_update'&&pending.status==='pending'
      &&pending.request.nonce===request.nonce&&same(pending.request.to,request.to)
      &&same(pending.request.data,request.data)&&pending.request.value===request.value,'Replacement changed publication intent');
    demand(this.withinValueBudget(pending?0n:request.value),'Daily oracle verification value budget exceeded');
    return super.makeAttempt(request);
  }
  withinValueBudget(additional) {
    const limit=this.config.maxDailyVerificationValue;
    demand(typeof limit==='bigint'&&limit>0n,'Explicit verification value budget required');
    return verificationValueReserved(this.store.transactions(),this.now())+additional<=limit;
  }
  async publish(plan) {
    if(this.config.mode!=='execute'||this.store.pendingTx()||!plan.shouldSubmit)return [];
    demand(same(plan.hub,this.config.publication.hub)&&plan.signatureVerified===true,'Unverified publication plan');
    publicationIntent({to:plan.to,data:plan.data,value:plan.value},this.config.publication);
    if(!this.withinValueBudget(plan.value))return [incident('oracle_verification_budget','critical','Daily oracle verification-value budget is exhausted; no new publication was signed.')];
    return this.submit('isolated_oracle_update',plan.to,plan.data,{},plan.value);
  }
  async confirmationDetails(receipt,tx) {
    const result=await confirmedPublication(receipt,tx,{publication:this.config.publication,account:this.chain.account.address,client:this.chain.client});
    return {...result,verificationFeeConfirmedAt:this.now()};
  }
}
