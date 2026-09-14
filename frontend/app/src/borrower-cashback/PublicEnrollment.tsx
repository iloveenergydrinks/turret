"use client";
import {useEffect,useRef,useState} from 'react';
import {useAccount,usePublicClient,useWalletClient} from 'wagmi';
import {getAddress,type Address,type Hash,type PublicClient,type WalletClient} from 'viem';
import manifest from './deployment.json';
import {recoverWalletClient,type RefreshWalletClient} from '../wallet/recoverWalletClient';
import type {CashbackConfig} from './client';
import {readPublicEnrollment,submitPublicEnrollment,verifyPublicEnrollment} from './enrollment';

type Props={account:Address;engine:Address;chainId:number;config:CashbackConfig;client:PublicClient;wallet?:WalletClient;refreshWallet?:RefreshWalletClient;onJoined:()=>void;onBusyChange:(busy:boolean)=>void};
export function PublicCashbackEnrollment({engine,onJoined,onBusyChange}:{engine:string;onJoined:()=>void;onBusyChange:(busy:boolean)=>void}) {
 const {address,chainId}=useAccount(),client=usePublicClient({chainId:manifest.chainId}),{data:wallet,refetch:refreshWallet}=useWalletClient();
 const config:CashbackConfig=manifest;
 if(!config.deployment?.publicEnrollment)return null;
 if(!address||!chainId||!client)return <p className="turret-public-cashback">Public campaign: 50% interest cashback, up to 25 USDG per wallet. Connect to check availability.</p>;
 return <EnrollmentControl key={`${address}:${chainId}:${engine}`} account={address} engine={getAddress(engine)} chainId={chainId} client={client} wallet={wallet} refreshWallet={refreshWallet} config={config} onJoined={onJoined} onBusyChange={onBusyChange}/>;
}
export function EnrollmentControl({account,engine,chainId,config,client,wallet,refreshWallet,onJoined,onBusyChange}:Props) {
 const [state,setState]=useState<Awaited<ReturnType<typeof readPublicEnrollment>>|null>(null);
 const [review,setReview]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[pending,setPending]=useState<Hash|null>(null);
 const mounted=useRef(true),locked=useRef(false),scope=`turret-cashback-join:${config.chainId}:${config.deployment?.address}:${account}`;
 const input={account,engine,config,client};
 useEffect(()=>{mounted.current=true;let stopped=false;
  try{const saved=localStorage.getItem(scope);if(saved&&/^0x[\da-f]{64}$/i.test(saved))setPending(saved as Hash);}catch{}
  const check=async()=>{try{const next=await readPublicEnrollment({account,engine,config,client});if(!stopped)setState(next);}catch{if(!stopped)setNotice('Cashback availability could not be checked. Borrowing remains available.');}};
  void check();const timer=setInterval(check,15000);return()=>{stopped=true;mounted.current=false;clearInterval(timer);onBusyChange(false);};
 },[scope,engine,client,config,account,onBusyChange]);
 useEffect(()=>{onBusyChange(busy || (!!pending && !state?.joined));return()=>onBusyChange(false);},[busy,pending,state?.joined,onBusyChange]);
 async function confirm(hash:Hash){const next=await verifyPublicEnrollment({...input,hash});try{localStorage.removeItem(scope);}catch{}if(mounted.current){setState(next);setPending(null);setReview(false);setNotice('25 USDG reserved across all campaign markets.');onJoined();}}
 async function join(){if(locked.current||!ready||pending)return;locked.current=true;setBusy(true);onBusyChange(true);setNotice('');
  try{const signingWallet=await recoverWalletClient(wallet,refreshWallet);if(!mounted.current)return;
   if(localStorage.getItem(scope))throw Error('An enrollment transaction is unresolved. Check its confirmation first.');
   const hash=await submitPublicEnrollment({...input,wallet:signingWallet});if(mounted.current)setPending(hash);try{localStorage.setItem(scope,hash);}catch{}
   await client.waitForTransactionReceipt({hash});await confirm(hash);
  }catch(e){if(mounted.current)setNotice(e instanceof Error?e.message:'Check your wallet, then check enrollment before retrying.');}
  finally{locked.current=false;if(mounted.current){setBusy(false);}}
 }
 const ready=chainId===config.chainId&&state?.eligible&&!state.excluded&&!state.paused&&state.slots>0&&state.now>=state.startsAt&&state.now<state.endsAt;
 return <aside className="turret-public-cashback" aria-label="Public borrower cashback">
  <div><strong>50% interest cashback</strong><span>{state?.joined?'Enrolled · 25 USDG wallet cap':'Up to 25 USDG per wallet'}</span>
   {!state?.joined&&!pending&&<button type="button" disabled={!ready||busy} onClick={()=>setReview(!review)}>{chainId!==config.chainId?'Switch network':state?.excluded?'Operator wallet excluded':state&&!state.eligible?'Market not eligible':state?.paused?'Enrollment paused':state&&state.now<state.startsAt?`Opens ${new Date(state.startsAt*1000).toLocaleString()}`:state&&state.now>=state.endsAt?'Enrollment closed':state&&state.slots===0?'Fully reserved':'Join campaign'}</button>}
  </div>
  {review&&!state?.joined&&<div className="turret-enrollment-review">
   <p>Reserve a shared 25 USDG cashback cap across all supported markets. Only new borrowing after enrollment qualifies. Repay gross interest first; 50% of eligible paid interest is returned separately.</p>
   <p>Accrual ends {state&&new Date(state.endsAt*1000).toLocaleString()}. Your wallet pays the enrollment network fee. Reservations are first come, first served; borrowing is optional.</p>
   <a href="/borrow/cashback-terms">Campaign terms</a>
   <button type="button" disabled={busy||!ready||!!pending} onClick={()=>void join()}>{busy?'Confirm enrollment in wallet…':'Confirm enrollment'}</button>
  </div>}
  {pending&&!state?.joined&&<p>Enrollment pending. Wait for confirmation before borrowing. <button type="button" onClick={()=>void confirm(pending).catch(()=>setNotice('Not confirmed yet. Check your wallet or retry confirmation.'))}>Check enrollment</button></p>}
  {notice&&<p role="status">{notice}</p>}
 </aside>;
}
