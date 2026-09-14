import {sessionAt} from './calendar.mjs';
import {validateSnapshot} from './alpaca.mjs';
import {encodeAbiParameters,keccak256} from './deps.mjs';
export const healthTypes={Health:[{name:'roundId',type:'uint80'},{name:'observedAt',type:'uint64'},{name:'validUntil',type:'uint64'},{name:'sessionOpen',type:'uint64'},{name:'sessionClose',type:'uint64'},{name:'roundHash',type:'bytes32'},{name:'epoch',type:'uint64'}]};
export const proofParameters=[{type:'tuple',components:healthTypes.Health},{type:'bytes'}];
export const roundHash=(id,value,time)=>keccak256(encodeAbiParameters([{type:'uint80'},{type:'uint256'},{type:'uint256'}],[id,value,time]));
export function evaluateMarket({snapshot,primary,multiplier,effectiveAt,tokenPaused,maxPriceAgeSeconds=300,sessionPolicy='regular',sourceFeed='iex',admissionLimits},now,wallSeconds=now) {
 // `now` is the pinned chain snapshot, taken before RPC reads and the HTTP
 // quote request. Validate source freshness against completion wall time;
 // otherwise healthy new quotes can look future-dated after slow RPC reads.
 // Keep the chain freshness budget and fail closed across session boundaries.
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(wallSeconds)||now>wallSeconds+2||wallSeconds-now>15)
  return {ok:false,code:'ObservationClockInvalid'};
 const session=sessionAt(now,sessionPolicy);
 if(!session.open)return {ok:false,code:session.reason};
 const completedSession=sessionAt(wallSeconds,sessionPolicy);
 if(!completedSession.open||completedSession.kind!==session.kind||completedSession.tradeDate!==session.tradeDate)
  return {ok:false,code:'SessionChanged'};
 const allowed=session.kind==='overnight'?['boats']:session.kind==='regular'?['iex','sip']:['sip'];
 if(!allowed.includes(sourceFeed))return {ok:false,code:'SessionFeedMismatch'};
 try{
  const quote=validateSnapshot(snapshot,wallSeconds,admissionLimits);
  if(sessionPolicy==='equities-24x5'&&(quote.sourceTime<session.sessionOpen||(quote.quoteTime??quote.sourceTime)<session.sessionOpen
   ||(quote.tradeTime??quote.sourceTime)<session.sessionOpen))return {ok:false,code:'QuoteOutsideSession'};
  const [round,answer,,timestamp,answered]=primary;
  if(tokenPaused||round===0n||answer<=0n||answered<round)return {ok:false,code:'PrimaryInvalid',unsafePrice:true};
  if(!Number.isSafeInteger(maxPriceAgeSeconds)||maxPriceAgeSeconds<60||maxPriceAgeSeconds>86400)return {ok:false,code:'InvalidHeartbeat'};
  if(timestamp<=0n||timestamp>BigInt(now)||BigInt(wallSeconds)-timestamp>=BigInt(maxPriceAgeSeconds))return {ok:false,code:'PrimaryStale'};
  if(multiplier<=0n||multiplier>10n**30n)return {ok:false,code:'MultiplierInvalid',unsafePrice:true};
  if(effectiveAt<=BigInt(wallSeconds)&&(timestamp<effectiveAt||BigInt(quote.sourceTime)<effectiveAt))return {ok:false,code:'CorporateActionPending',unsafePrice:true};
  // primary[1] has already been normalized to 18 decimals by the caller.
  const independent=quote.price*multiplier/10n**18n,low=answer<independent?answer:independent,diff=answer>independent?answer-independent:independent-answer;
  if(low<=0n||diff*10000n>low*200n)return {ok:false,code:'PriceDisagreement',unsafePrice:true};
  // A stricter admission threshold must not quarantine otherwise valid
  // liquidation prices. The existing 2% unsafe-price threshold remains intact.
  if(admissionLimits&&diff*10000n>low*BigInt(admissionLimits.maxDeviationBps))return {ok:false,code:'ExtendedPriceDisagreement'};
  return {ok:true,roundId:round,roundHash:roundHash(round,answer,timestamp),...session,sourceTime:quote.sourceTime,
   ...(admissionLimits?{quoteMaxAgeSeconds:admissionLimits.maxAgeSeconds,quoteValidUntil:quote.quoteValidUntil}:{}),
   sessionKey:`${session.tradeDate}:${session.kind}:${sourceFeed}`};
 }catch(error){return {ok:false,code:error.name};}
}
export class RecoveryTracker {
 constructor(){this.records=new Map();}
 reset(key){this.records.delete(key);}
 observe(key,result,now){
  if(!result.ok){this.reset(key);return false;}
  const old=this.records.get(key),r=old&&old.sessionKey===result.sessionKey&&now>=old.last&&now-old.last<=30?old:{since:now,sessionKey:result.sessionKey};
  r.last=now;this.records.set(key,r);return now-r.since>=120;
 }
}
export async function makeProof(account,adapter,result,{epoch,recoveryAt},now) {
 if(!result.ok||now<Number(recoveryAt))throw new Error('RecoveryPending');
 // A certificate may never outlive the source quote's age limit or the session.
 const until=Math.min(now+45,result.sourceTime+(result.quoteMaxAgeSeconds??60),result.sessionClose,result.admissionValidUntil??Infinity,result.quoteValidUntil??Infinity);
 if(until-now<15)throw new Error('QuoteTooOldForApproval');
 // The deployed guard limits a signed window to 6.5 hours. Overnight lasts
 // eight: sign a bounded subwindow inside that session, never extend the guard.
 const sessionOpen=result.sessionClose-result.sessionOpen>23400?Math.max(result.sessionOpen,now-120):result.sessionOpen;
 const sessionClose=Math.min(result.sessionClose,sessionOpen+23400);
 const message={roundId:result.roundId,observedAt:BigInt(now),validUntil:BigInt(until),sessionOpen:BigInt(sessionOpen),sessionClose:BigInt(sessionClose),roundHash:result.roundHash,epoch:BigInt(epoch)};
 const signature=await account.signTypedData({domain:{name:'DockyardChainlinkGuard',version:'1',chainId:4663,verifyingContract:adapter},types:healthTypes,primaryType:'Health',message});
 return {encoded:encodeAbiParameters(proofParameters,[message,signature]),validUntil:until};
}
