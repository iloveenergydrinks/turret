import { hashTypedData, isAddress } from "viem";

export const UINT_MAX = (1n << 256n) - 1n;
export const MAX_TIME = 8_640_000_000_000n;
export const FRESH_MS = 30_000;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const quoteFields = ["epoch", "nonce", "borrower", "capacity", "minDraw", "collateralForCapacity", "interestForCapacity", "duration", "validAfter", "expiresAt"];
export const quoteTypes = { Quote: quoteFields.map(name => ({ name, type: name === "borrower" ? "address" : "uint256" })) };
export const same = (a,b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const isAccount = value => typeof value === "string" && isAddress(value,{strict:false}) && !same(value,ZERO_ADDRESS);
export function exactKeys(value,keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Unexpected or missing quote fields.");
}
export function uint(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT_MAX) throw new Error("Use canonical unsigned token amounts.");
  return BigInt(value);
}
export function quoteValues(quote) {
  exactKeys(quote,quoteFields);
  if (typeof quote.borrower !== "string" || !isAddress(quote.borrower,{strict:false})) throw new Error("Invalid quote borrower.");
  const q=Object.fromEntries(quoteFields.map(key=>[key,key === "borrower" ? quote[key].toLowerCase() : uint(quote[key])]));
  if (q.epoch===0n || q.capacity===0n || q.minDraw===0n || q.minDraw>q.capacity || q.collateralForCapacity===0n
    || q.capacity+q.interestForCapacity>UINT_MAX || q.duration===0n || q.duration%86400n!==0n
    || q.expiresAt<=q.validAfter || q.expiresAt+q.duration+86400n>MAX_TIME) throw new Error("Invalid quote terms.");
  return q;
}
export function parseSignedQuote(value) {
  exactKeys(value,["schemaVersion","chainId","facility","quote","signature"]);
  if(value.schemaVersion!==1 || !Number.isSafeInteger(value.chainId) || value.chainId<=0 || !isAccount(value.facility)
    || typeof value.signature!=="string" || !/^0x(?:[0-9a-f]{2}){0,4096}$/i.test(value.signature)) throw new Error("Invalid signed quote envelope.");
  const q=quoteValues(value.quote);
  if(same(q.borrower,value.facility)) throw new Error("A facility cannot borrow from itself.");
  return {schemaVersion:1,chainId:value.chainId,facility:value.facility.toLowerCase(),
    quote:Object.fromEntries(quoteFields.map(key=>[key,typeof q[key]==="bigint"?q[key].toString():q[key]])),signature:value.signature.toLowerCase()};
}
/** Signing this authorizes draws of deposited capital; it is not just a listing message. */
export function quoteTypedData(value) {
  const envelope=parseSignedQuote(value);
  return {domain:{name:"TurretLenderFacility",version:"1",chainId:envelope.chainId,verifyingContract:envelope.facility},
    types:quoteTypes,primaryType:"Quote",message:quoteValues(envelope.quote)};
}
export const quoteDigest = value => hashTypedData(quoteTypedData(value));
const min = (...values) => values.reduce((a,b)=>a<b?a:b);
const max = (...values) => values.reduce((a,b)=>a>b?a:b);
export const ceilDiv = (a,b) => (a+b-1n)/b;
export function drawAmounts(value,principal,feeBps) {
  const q=quoteValues(value.quote);
  if(typeof principal!=="bigint" || principal<=0n || principal>q.capacity || typeof feeBps!=="bigint" || feeBps<0n || feeBps>10_000n) throw new Error("Invalid draw amount or fee rate.");
  const collateral=ceilDiv(principal*q.collateralForCapacity,q.capacity);
  const interest=ceilDiv(principal*q.interestForCapacity,q.capacity);
  const fee=interest*feeBps/10_000n;
  return {principal,collateral,interest,repayment:principal+interest,fee,lenderRepayment:principal+interest-fee};
}

export function validObservation(s,now) {
  const amounts=[s?.epoch,s?.idleCash,s?.cashBalance,s?.activePrincipal,s?.unresolvedDefaultPrincipal,s?.feeBps,
    ...Object.values(s?.limits??{}),s?.use?.filled,s?.block?.number,s?.block?.timestamp];
  const keys=["maxExposure","minDraw","maxDraw","minDuration","maxDuration","maxQuoteLifetime","minCollateralPerPrincipalWad","minInterestBps"];
  if(!s || s.healthy!==true || typeof s.signatureValid!=="boolean" || !isAccount(s.lender) || !isAccount(s.facility)
    || !Number.isSafeInteger(s.chainId) || s.chainId<=0 || typeof s.paused!=="boolean" || typeof s.use?.cancelled!=="boolean"
    || !/^0x[0-9a-f]{64}$/i.test(s.use?.digest) || !/^0x[0-9a-f]{64}$/i.test(s.block?.hash)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(s.checkedAt) || s.checkedAt>now || now-s.checkedAt>=FRESH_MS
    || amounts.some(value=>typeof value!=="bigint"||value<0n||value>UINT_MAX)
    || Math.abs(now-Number(s.block.timestamp)*1000)>=FRESH_MS || s.feeBps>10_000n || s.epoch===0n) return false;
  try {exactKeys(s.limits,keys);}catch{return false;}
  const p=s.limits;
  return p.minDraw>0n && p.maxDraw>=p.minDraw && p.maxExposure>=p.maxDraw && p.minDuration>0n
    && p.minDuration%86400n===0n && p.maxDuration>=p.minDuration && p.maxDuration%86400n===0n
    && p.maxDuration<=MAX_TIME-86400n && p.maxQuoteLifetime>0n && p.minCollateralPerPrincipalWad>0n && p.minInterestBps<=10_000n;
}

/** Public quote discovery. Acceptance must freshly re-read state and simulate the exact draw. */
export function assessQuote(value,s,{now=Date.now(),account}={}) {
  const result={status:"unavailable",reason:"Fresh facility and signature checks are required.",capacity:0n,maxDraw:0n,minDraw:0n,borrowerEligible:false};
  let envelope,q,digest;
  try{envelope=parseSignedQuote(value);q=quoteValues(envelope.quote);digest=quoteDigest(envelope);}catch{return {...result,status:"invalid",reason:"Invalid signed quote."};}
  if(!validObservation(s,now) || !same(s.facility,envelope.facility) || s.chainId!==envelope.chainId) return result;
  const stop=(status,reason)=>({...result,status,reason});
  if(!s.signatureValid) return stop("revoked","The lender signature is no longer valid.");
  if(q.epoch!==s.epoch || s.use.cancelled || (s.use.filled>0n&&!same(s.use.digest,digest))) return stop("revoked","This quote was replaced, revoked or cancelled.");
  const p=s.limits;
  if(q.expiresAt-q.validAfter>p.maxQuoteLifetime || q.duration<p.minDuration || q.duration>p.maxDuration
    || q.collateralForCapacity*10n**18n<q.capacity*p.minCollateralPerPrincipalWad
    || q.interestForCapacity*10_000n<q.capacity*p.minInterestBps || same(q.borrower,s.lender)) return stop("invalid","Quote rates or duration do not meet the current lender policy.");
  const time=BigInt(Math.floor(now/1000));
  if(time>=q.expiresAt || s.block.timestamp>=q.expiresAt) return stop("expired","This quote expired.");
  if(time<q.validAfter || s.block.timestamp<q.validAfter) return stop("scheduled","This quote is not active yet.");
  if(s.paused) return stop("paused","The lender paused new loans.");
  if(s.use.filled>q.capacity || s.cashBalance<s.idleCash) return stop("unavailable","Recorded capital or quote fills are not fully backed.");
  const exposure=s.activePrincipal+s.unresolvedDefaultPrincipal;
  const room=exposure>=p.maxExposure?0n:p.maxExposure-exposure;
  const remaining=q.capacity-s.use.filled;
  const minimum=max(q.minDraw,p.minDraw);
  const capacity=min(remaining,s.idleCash,room);
  const maximum=min(capacity,p.maxDraw);
  if(maximum<minimum) return {...stop(remaining<minimum?"filled":"unfunded","There is not enough remaining capacity for the minimum draw."),minDraw:minimum};
  const eligible=account ? isAccount(account)&&!same(account,s.lender)&&!same(account,s.facility)&&(same(q.borrower,ZERO_ADDRESS)||same(q.borrower,account)) : same(q.borrower,ZERO_ADDRESS);
  return {status:"available",reason:null,capacity,maxDraw:maximum,minDraw:minimum,borrowerEligible:eligible};
}

/** Each facility has one cash balance, regardless of how many signed quotes describe it. */
export function summarizeFacilities(rows,options={}) {
  const now=options.now??Date.now();
  const groups=new Map();
  for(const row of rows){
    const e=parseSignedQuote(row.envelope),key=`${e.chainId}:${e.facility}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...row,envelope:e});
  }
  return [...groups].map(([key,items])=>{
    const first=items[0].observation;
    // Different blocks or capital/policy observations cannot establish a combined funded figure.
    const stateKey=s=>JSON.stringify([s.block.number,s.block.hash.toLowerCase(),s.block.timestamp,s.epoch,s.idleCash,s.cashBalance,s.activePrincipal,s.unresolvedDefaultPrincipal,Object.entries(s.limits).sort(),s.paused,s.healthy,s.lender.toLowerCase(),s.facility.toLowerCase(),s.chainId,s.feeBps],(_,v)=>typeof v==="bigint"?v.toString():v);
    if(items.some(row=>!validObservation(row.observation,now)))return {key,status:"unavailable",capacity:0n,quotes:[]};
    if(items.some(row=>stateKey(row.observation)!==stateKey(first)))return {key,status:"unavailable",capacity:0n,quotes:[]};
    const nonces=new Map(),quotes=[];let sum=0n;
    for(const row of items){
      const id=quoteDigest(row.envelope),nonce=`${row.envelope.quote.epoch}:${row.envelope.quote.nonce}`;
      if(nonces.has(nonce)){
        const previous=nonces.get(nonce);
        if(previous.id!==id || previous.filled!==row.observation.use.filled || previous.cancelled!==row.observation.use.cancelled
          || !same(previous.digest,row.observation.use.digest))return {key,status:"unavailable",capacity:0n,quotes:[]};
        continue;
      }
      nonces.set(nonce,{id,...row.observation.use});
      const availability=assessQuote(row.envelope,row.observation,{...options,now});
      quotes.push({id,envelope:row.envelope,availability});
      if(availability.status==="available"&&availability.borrowerEligible)sum+=availability.capacity;
    }
    if(quotes.some(q=>q.availability.status==="unavailable"))return {key,status:"unavailable",capacity:0n,quotes};
    const exposure=first.activePrincipal+first.unresolvedDefaultPrincipal;
    const room=first.limits.maxExposure>exposure?first.limits.maxExposure-exposure:0n;
    const capacity=sum>0n?min(sum,first.idleCash,room):0n;
    return {key,status:"checked",capacity,quotes};
  });
}
