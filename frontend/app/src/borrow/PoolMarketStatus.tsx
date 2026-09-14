"use client";
import {useEffect,useState} from 'react';
import {formatUnits} from 'viem';
import {centralRefreshInterval,centralStatus,validateCentral,type CentralMarket} from './central-credit';
import './PoolMarketStatus.css';
import './get-collateral.css';
import {borrowCapacity} from './borrow-estimate';
import type {WalletFacts} from './useBorrowWallet';
import {CollateralLogo} from '../screens/P2PLoansScreen/CollateralLogo';
type Summary=Awaited<ReturnType<typeof centralStatus>>;
type DirectoryFacts={
 borrowingPrice:bigint|null;availability:Summary["availability"];
 value:bigint|null;valueAt:bigint|null;valueUntil:bigint;reference:boolean;
 closed:boolean|null;statusAt:bigint|null;statusUntil:bigint;closedReason:string;
 code:string;ready:boolean;checkedAt:bigint;checkUntil:bigint;sessionUntil:bigint;
};
export function directoryFacts(previous:DirectoryFacts|undefined,s:Summary):DirectoryFacts {
 const value=s.marketPrice??s.price??s.displayReferencePrice??null;
 const marketClosed=!!s.closedSession||s.code==='MarketClosed';
 const poolPaused=s.availability?.paused===true||s.code==='MarketPaused';
 // Cash and pause fields can survive a failed trading check. Only a ready
 // response can establish Open; failures must not reopen a closed market or
 // renew the timestamp of its last confirmed status.
 const hasStatus=s.ready||marketClosed||poolPaused;
 return {
  borrowingPrice:s.borrowingPrice,availability:s.availability,
  value:value??previous?.value??null,
  valueAt:value!==null?(s.marketPrice!==null?s.marketUpdatedAt:s.referenceUpdatedAt??s.displayReferenceAt):previous?.valueAt??null,
  valueUntil:value!==null?(s.marketValidUntil!==null&&s.marketPrice!==null&&s.marketValidUntil<s.validUntil?s.marketValidUntil:s.validUntil):previous?.valueUntil??0n,
  reference:value!==null?s.marketPrice===null:previous?.reference??true,
  closed:hasStatus?(poolPaused||marketClosed):previous?.closed??null,
  statusAt:hasStatus?s.checkedAt:previous?.statusAt??null,
  statusUntil:hasStatus?s.validUntil:previous?.statusUntil??0n,
  closedReason:hasStatus?(poolPaused?'Pool paused':marketClosed?'Trading market is closed':''):previous?.closedReason??'',
  code:s.code,ready:s.ready,checkedAt:s.checkedAt,checkUntil:s.validUntil,sessionUntil:s.closedSession?.validUntil??0n,
 };
}
export function borrowingReason(code:string){
 switch(code){
  case 'CorporateActionChanged':return 'The token’s conversion rate changed. Updated pricing is being reviewed.';
  case 'CorporateActionPending':return 'Waiting for fresh pricing after a token adjustment.';
  case 'MarketClosed':return 'Trading market is closed';
  case 'MarketPaused':return 'Pool paused';
  case 'QuoteStale':case 'EvidenceExpired':return 'Waiting for fresh price checks';
  case 'RpcUnavailable':return 'Network checks are unavailable';
  case 'KeeperUnavailable':return 'Liquidation service is unavailable';
  default:return 'Borrowing checks are unavailable';
 }
}
function AvailabilityIcon({state}:{state:'open'|'closed'|'checking'}){
 return <span aria-hidden="true" className="rusd-market-status-icon"><svg fill="none" viewBox="0 0 18 18" focusable="false">
  {state==='open'?<path d="m5 9.2 2.45 2.45L13.2 6"/>:state==='closed'?<><circle cx="9" cy="9" r="5.25"/><path d="M5.3 12.7 12.7 5.3"/></>:<><path d="M14.25 9A5.25 5.25 0 1 1 9 3.75"/><path d="M9 3.75h3.35v3.3"/></>}
 </svg></span>;
}
const amount=(value:bigint)=>Number(formatUnits(value,18)).toLocaleString('en-US',{maximumFractionDigits:4});
function UpdatedAt({at,label}:{at:bigint;label:string}){
 const date=new Date(Number(at)*1000);
 return <span>{label} <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></span>;
}
export function PoolMarketStatus({market,name,walletConnected=false,walletFacts}:{walletConnected?:boolean;walletFacts?:WalletFacts|null;market:{symbol:string;engine:string;collateral?:string;chainId?:number;central?:CentralMarket};name:string}){
 const [facts,setFacts]=useState<DirectoryFacts>();
 const [failed,setFailed]=useState(false),[now,setNow]=useState(Date.now),[attempt,retry]=useState(0);
 useEffect(()=>{setFacts(undefined);setFailed(false);},[market.engine,market.central?.id,market.central?.apiUrl,market.central?.policyHash]);
 useEffect(()=>{
  let alive=true,inFlight=false,timer:ReturnType<typeof setTimeout>;
  const refresh=async()=>{
   if(!alive||inFlight)return;
   clearTimeout(timer);
   let next=5000;
   if(document.visibilityState!=='hidden'){
    inFlight=true;
    try{
     if(!market.central)throw Error();
     const s=await centralStatus(validateCentral(market.central));
     if(alive){setFacts(previous=>directoryFacts(previous,s));setFailed(false);next=centralRefreshInterval(s);}
    }catch{if(alive)setFailed(true);}
    finally{inFlight=false;if(alive)setNow(Date.now());}
   }
   if(alive)timer=setTimeout(refresh,next);
  };
  const visible=()=>{setNow(Date.now());if(document.visibilityState!=='hidden')void refresh();};
  const clock=setInterval(()=>setNow(Date.now()),1000);
  document.addEventListener('visibilitychange',visible);
  void refresh();
  return()=>{alive=false;clearTimeout(timer);clearInterval(clock);document.removeEventListener('visibilitychange',visible);};
 },[market.engine,market.central?.id,market.central?.apiUrl,market.central?.policyHash,attempt]);
 const expired=(until:bigint)=>now>=Number(until)*1000;
 const sessionClosed=!!facts&&!expired(facts.sessionUntil);
 const statusOld=!!facts&&!sessionClosed&&(failed||expired(facts.statusUntil));
 const valueOld=facts?.value!=null&&!sessionClosed&&(failed||expired(facts.valueUntil));
 const checkOld=!!facts&&(failed||expired(facts.checkUntil));
 const tokenAdjustment=!sessionClosed&&!!facts&&!facts.ready&&!checkOld&&['CorporateActionChanged','CorporateActionPending'].includes(facts.code);
 const needsRefresh=!sessionClosed&&(failed||checkOld||(statusOld&&!tokenAdjustment));
 const status=tokenAdjustment?'closed':!facts||facts.closed===null||statusOld?'checking':facts.closed?'closed':'open';
 const label=tokenAdjustment?'Unavailable':facts?.closed!=null?`${statusOld?'Last known: ':''}${facts.closed?'Closed':'Open'}`:failed||facts?'Not confirmed':'Checking…';
 const reason=sessionClosed?'Trading market is closed':!checkOld&&facts?(facts.closed&&!statusOld?facts.closedReason:!facts.ready?borrowingReason(facts.code):''):'';
 const capacity=walletFacts&&facts&&!checkOld&&!failed&&facts.ready&&facts.availability?borrowCapacity({
  ...walletFacts,borrowingPrice:facts.borrowingPrice,riskPaused:facts.availability.paused,...facts.availability
 },walletFacts.balance):null;
 return <tr className="borrow-directory-row"><td>
  <div className="borrow-directory-identity"><CollateralLogo market={{chainId:market.chainId??4663,collateralToken:market.collateral??'',collateralSymbol:market.symbol}}/><div className="borrow-table-identity"><strong>{market.symbol}</strong><span>{name}</span></div></div>
  <div className="borrow-directory-value"><span>{valueOld?'Last known value':facts?.reference?'Reference value':'Indicative value'}</span><span>{facts?.value!=null?`${amount(facts.value)} USDG`:'—'}</span></div>
  {facts?.valueAt!=null&&<div className="pool-status-detail"><UpdatedAt at={facts.valueAt} label="Price as of"/>{valueOld&&<span className="pool-status-warning">Price needs refresh</span>}</div>}
 {walletConnected&&<div className="borrow-wallet-facts"><span>In your wallet <strong>{walletFacts?Number(formatUnits(walletFacts.balance,18)).toLocaleString('en-US',{maximumFractionDigits:6})+' '+market.symbol:walletFacts===null?'Unavailable':'Checking…'}</strong></span>
 <span>Estimated borrowable <strong>{capacity===null?'—':Number(formatUnits(capacity,6)).toLocaleString('en-US',{maximumFractionDigits:2})+' USDG'}</strong></span>
 {capacity===null&&<span>Needs current wallet and market checks</span>}</div>}
 </td><td>
  <span className="borrow-directory-status rusd-market-status" data-state={status}><AvailabilityIcon state={status}/><span>{label}</span></span>
  <div className="pool-status-detail">
   {tokenAdjustment?<><span>New {market.symbol} loans are temporarily unavailable.</span><details><summary>Why?</summary><span>{borrowingReason(facts!.code)}</span></details></>:reason&&<span>{reason}</span>}
   {needsRefresh&&<span className="pool-status-warning">{failed?'Refresh failed':checkOld?'Checks need refresh':'Pool status needs refresh'}</span>}
   {needsRefresh&&facts&&<UpdatedAt at={facts.statusAt??facts.checkedAt} label="Last checked"/>}
   {needsRefresh&&<button type="button" className="pool-status-retry" aria-label={`Retry ${market.symbol} status`} onClick={()=>retry(x=>x+1)}>Retry</button>}
  </div>
 </td><td><div className="borrow-directory-actions"><a className="rusd-action" href={`/borrow?engine=${market.engine}`} aria-label={`View ${market.symbol} market`}>View market</a><a className="dockyard-secondary-action borrow-get-collateral" href={`/borrow/get?engine=${market.engine}`}>Get {market.symbol}</a></div></td></tr>;
}
