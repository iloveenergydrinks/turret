import {encodeAbiParameters} from './deps.mjs';

export const livenessTypes={Liveness:[
 {name:'observedAt',type:'uint64'},{name:'healthySince',type:'uint64'},
 {name:'validUntil',type:'uint64'},{name:'epoch',type:'uint64'},
]};
export const livenessParameters=[{type:'tuple',components:livenessTypes.Liveness},{type:'bytes'}];

// Freshness is based on chain timestamps AND wall time. A restart never restores
// a previous healthy interval from disk. Production defaults to two agreeing RPC
// endpoints; a one-provider MVP must opt into the weaker policy explicitly.
export class LivenessTracker {
 reset(){this.previous=undefined;this.since=undefined;}
 observe(head,wallSeconds,{consistent,healthyProviders,requiredHealthyProviders=2,recoveryAt=0}={}){
  const t=Number(head.timestamp),number=BigInt(head.number);
  if(!consistent||healthyProviders<requiredHealthyProviders||!Number.isSafeInteger(t)||!Number.isSafeInteger(wallSeconds)
    ||t>wallSeconds+2||wallSeconds-t>15){this.reset();return {ok:false,code:'chain_unavailable'};}
  const p=this.previous;
  if(!p||wallSeconds<p.wall||wallSeconds-p.wall>30||t<p.time||t-p.time>30
    ||number<p.number||(number===p.number&&head.hash!==p.hash))this.since=t;
  this.since=Math.max(this.since,Number(recoveryAt));
  this.previous={wall:wallSeconds,time:t,number,hash:head.hash};
  return {ok:t-this.since>=120,code:t-this.since>=120?'healthy':'recovering',healthySince:this.since,observedAt:t};
 }
}

export async function makeLivenessProof(account,gate,result,epoch){
 if(!result.ok||result.observedAt-result.healthySince<120)throw new Error('LivenessRecoveryPending');
 const validUntil=result.observedAt+45;
 const message={observedAt:BigInt(result.observedAt),healthySince:BigInt(result.healthySince),validUntil:BigInt(validUntil),epoch:BigInt(epoch)};
 const signature=await account.signTypedData({domain:{name:'DockyardExecutionGate',version:'1',chainId:4663,verifyingContract:gate},types:livenessTypes,primaryType:'Liveness',message});
 return {encoded:encodeAbiParameters(livenessParameters,[message,signature]),validUntil};
}
export function combineBorrowProof(health,liveness){
 return {encoded:encodeAbiParameters([{type:'bytes'},{type:'bytes'}],[health.encoded,liveness.encoded]),validUntil:Math.min(health.validUntil,liveness.validUntil)};
}
