'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {formatUnits,type Hash,type Address} from 'viem';
import {useAccount,usePublicClient,useWalletClient} from 'wagmi';
import {readRewards,rewardsForPool} from './client';
import {rejected,sendReward,settleReward,type RewardAction,type RewardPending} from './transactions';
import manifest from './campaigns.json';
import './rewards.css';
import {recoverWalletClient} from '../../wallet/recoverWalletClient';
type State=Awaited<ReturnType<typeof readRewards>>;
type Review={action:'activate'|'unstake'|'claim';amount:bigint};
const show=(n:bigint,d:number)=>formatUnits(n,d);
export function RewardsPanel({pool,onChanged,depositConfirmed=false,refreshKey,depositBlock,blocked=false,onBusyChange,onActivationChange,onPause}: {
 pool:string;onPause?:()=>void;onChanged?:()=>void;depositConfirmed?:boolean;refreshKey?:string;depositBlock?:bigint;blocked?:boolean;onBusyChange?:(busy:boolean)=>void;onActivationChange?:(status:"checking"|"needed"|"active"|"unavailable")=>void;
}){
 const deployment=rewardsForPool(pool),{address,chainId}=useAccount(),client=usePublicClient({chainId:4663}),{data:wallet,refetch:refreshWallet}=useWalletClient();
 const [state,setState]=useState<State>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[review,setReview]=useState<Review>(),
  [receipt,setReceipt]=useState<Hash>(),[pending,setPending]=useState<RewardPending|null>(null),[recoveryHash,setRecoveryHash]=useState(''),
  [phase,setPhase]=useState<RewardAction>(),[notice,setNotice]=useState('');
 const scope=`${pool.toLowerCase()}:${address?.toLowerCase()}:${chainId}`,scopeRef=useRef(scope),readId=useRef(0),lock=useRef(false),mounted=useRef(true);
 scopeRef.current=scope;
 const journalKey=`turret:rewards:4663:${pool.toLowerCase()}:${address?.toLowerCase()}`;
 const heading=useRef<HTMLHeadingElement>(null);
 const connected=!!address&&chainId===4663;
 const refresh=useCallback(async()=>{
  if(!deployment||!client||!address||chainId!==4663)return;
  const target=scope,id=++readId.current;
  try{const next=await readRewards(client,deployment,address);if(mounted.current&&scopeRef.current===target&&readId.current===id){setState(next);return next;}}
  catch{if(mounted.current&&scopeRef.current===target&&readId.current===id){setState(undefined);setError('Rewards could not be checked. Your USDG deposit is unchanged. Refresh rewards before continuing.');}}
 },[deployment,client,address,chainId,scope]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{
  setState(undefined);setReview(undefined);setReceipt(undefined);setError('');setNotice('');setPending(null);
  const recover=()=>{try{const raw=localStorage.getItem(journalKey);setPending(raw?JSON.parse(raw):null);}catch{setError('Recovery storage is unavailable. Enable site storage before using rewards.');}};
  recover();void refresh();const timer=setInterval(()=>void refresh(),15000);
  const storage=(e:StorageEvent)=>{if(e.key===journalKey)recover();};
  window.addEventListener('storage',storage);window.addEventListener('focus',recover);
  return()=>{clearInterval(timer);window.removeEventListener('storage',storage);window.removeEventListener('focus',recover);};
 },[refresh,journalKey]);
 useEffect(()=>{void refresh();},[refreshKey,refresh]);
 useEffect(()=>{onBusyChange?.(busy||!!pending);},[busy,pending,onBusyChange]);
 useEffect(()=>{if(depositConfirmed)heading.current?.focus();},[depositConfirmed]);
 const current=connected&&state?.account.toLowerCase()===address?.toLowerCase()&&(!depositBlock||state.blockNumber>=depositBlock)?state:undefined;
 const activationStatus = !current ? 'checking' : !current.acceptingStake ? 'unavailable' : current.staked>0n&&current.walletShares===0n ? 'active' : 'needed';
 useEffect(()=>{onActivationChange?.(activationStatus);},[activationStatus,onActivationChange]);
 if(!deployment)return manifest.plannedPools.some(p=>p.toLowerCase()===pool.toLowerCase())?<section className="turret-rewards" aria-label="TURRET lender rewards"><h2>TURRET rewards</h2><p>Planned: 20 million TURRET across participating pools over 14 days.</p><p role="status">Not active yet. Rewards start only after the campaign is funded on-chain.</p><p>Lending USDG does not currently earn TURRET in this pool.</p></section>:null;
 const targetScope=scope;
 const validScope=()=>mounted.current&&scopeRef.current===targetScope;
 // The closure retains the original wallet's journal even after a wallet switch.
 const remember=(value:RewardPending|null)=>{
  if(value)localStorage.setItem(journalKey,JSON.stringify(value));else localStorage.removeItem(journalKey);
  if(validScope())setPending(value);
 };
 const finish=async(action:RewardAction,hash:Hash)=>{
  if(!validScope())return;
  setReceipt(hash);setReview(undefined);setState(undefined);onChanged?.();await refresh();
  if(validScope())setNotice(action==='approve'?'Share approval confirmed. Reward activation still needs one wallet confirmation.':action==='stake'?'Reward activation transaction confirmed. Your status below is checked on-chain.':action==='unstake'?'Shares returned to your wallet. To receive USDG, continue with Withdraw in the pool.':'TURRET claim confirmed.');
 };
 const confirm=async()=>{
  if(lock.current||blocked||pending||!review||!client||!address||!current)return;
  lock.current=true;setBusy(true);setError('');setNotice('');setReceipt(undefined);
  try{
   const signingWallet=await recoverWalletClient(wallet,refreshWallet);
   if(!validScope())return;
   if(localStorage.getItem(journalKey))throw Error('A rewards transaction is unresolved. Check its confirmation first.');
   const send=async(action:RewardAction)=>sendReward({client,wallet:signingWallet,deployment,account:address as Address,action,amount:review.amount,currentScope:validScope,remember,phase:a=>{if(validScope())setPhase(a);}});
   if(review.action==='activate'){
    const fresh=await readRewards(client,deployment,address);
    if(!validScope())return;
    if(fresh.allowance<review.amount){await send('approve');if(!validScope())return;setNotice('Share approval confirmed. Next: activate TURRET rewards in your wallet.');}
    const result=await send('stake');await finish('stake',result.transactionHash);
   }else{const result=await send(review.action);await finish(review.action,result.transactionHash);}
  }catch(e){if(validScope()){setError(rejected(e)?review.action==='activate'?'Cancelled in your wallet. Your USDG stays lent. Reward activation is not complete for shares still in your wallet.':'Cancelled in your wallet. Your pool deposit is unchanged.':e instanceof Error?e.message:'The rewards action could not be confirmed. Check wallet activity.');setReview(undefined);void refresh();}}
  finally{lock.current=false;if(validScope()){setBusy(false);setPhase(undefined);}}
 };
 const recover=async()=>{
  if(lock.current||!client||!pending||!connected)return;
  lock.current=true;setBusy(true);setError('');
  try{
   const result=await settleReward(client,pending.hash?pending:{...pending,hash:recoveryHash as Hash},remember);
   await finish(pending.action,result.transactionHash);
  }catch(e){if(validScope())setError(e instanceof Error?e.message:'Confirmation could not be checked.');}
  finally{lock.current=false;if(validScope())setBusy(false);}
 };
 const needsActivation=!!current&&current.walletShares>0n;
 const complete=!!current&&current.staked>0n&&current.walletShares===0n;
 const status=!current?'Checking your reward activation…':!current.acceptingStake?'Campaign ended or stopped. New rewards are not accruing.':needsActivation
  ?current.staked>0n?'Only part of your position earns TURRET. Activate the shares still in your wallet.':'TURRET rewards are not activated for your position.'
  :complete?current.active?'TURRET rewards activated. Your entire current pool position is included.':`Reward activation complete. Rewards start ${new Date(Number(current.start)*1000).toLocaleString()}.`
  :'Lend USDG, then finish reward activation here.';
 const disabled=busy||blocked||!!pending||!connected;
 return <section className="turret-rewards" aria-label="TURRET lender rewards">
 <h2 ref={heading} tabIndex={-1}>{depositConfirmed&&!complete?'Finish your lending setup':'TURRET rewards'}</h2>
 {!review&&<p>First lend USDG, then activate rewards for your pool shares—the receipt for your deposit. You do not need to buy or stake TURRET.</p>}
 {connected?<>
 <p role="status" className="turret-rewards-status">{status}</p>
 {(depositConfirmed||needsActivation||review?.action==='activate')&&<ol className="turret-rewards-steps" aria-label="Lending progress">
  <li><strong>Lend USDG</strong><span>{depositConfirmed||needsActivation?'Deposit confirmed':'Check pool balance'}</span></li>
  <li aria-current={!complete?'step':undefined}><strong>Activate TURRET rewards</strong><span>{complete?'Confirmed':busy&&phase==='approve'?'Confirm share approval in your wallet':busy&&phase==='stake'?'Confirm activation in your wallet':'Still needs wallet confirmation'}</span></li>
 </ol>}
 {current&&<>
 {!review&&needsActivation&&current.acceptingStake&&<p>Your {show(current.walletShares,12)} shares in this wallet are not earning TURRET. Activation includes these shares from earlier deposits too. Rewards start after activation, not retroactively.</p>}
 {review?<div className="turret-rewards-review">
 <h3>{review.action==='activate'?'Activate rewards for your pool position':review.action==='unstake'?'Return shares before withdrawing USDG':'Claim your TURRET'}</h3>
 <p>{review.action==='activate'?`Move ${show(review.amount,12)} pool shares to the rewards contract. Your shares keep their pool interest and loss exposure. No staking lockup.`:review.action==='unstake'?`Return ${show(review.amount,12)} pool shares to your wallet. This stops future rewards on those shares. It does not withdraw USDG.`:`Claim your earned TURRET. Your pool shares stay activated.`}</p>
 {review.action==='activate'&&<p>{current.allowance<review.amount?'Up to two wallet confirmations: approve this share amount, then activate rewards. We open the next wallet request after approval confirms.':'Share approval is already sufficient. One wallet confirmation activates rewards.'} Approval alone does not activate rewards. Each transaction costs a network fee.</p>}
 <details><summary>Contract details</summary><p>Pool shares: {deployment.pool}</p><p>Rewards contract: {deployment.address}</p><p>Robinhood Chain · 4663</p></details>
 <div className="turret-rewards-actions"><button className="dockyard-primary-action" disabled={disabled} onClick={()=>void confirm()}>{busy?phase==='approve'?'Confirming share approval…':phase==='stake'?'Confirming reward activation…':'Confirming…':review.action==='activate'?'Activate rewards in wallet':'Confirm in wallet'}</button><button className="dockyard-secondary-action" disabled={busy||!!pending} onClick={()=>setReview(undefined)}>Cancel</button></div>
 </div>:<>
 {needsActivation&&current.acceptingStake&&<button className="dockyard-primary-action" disabled={disabled} onClick={()=>{setError('');setReview({action:'activate',amount:current.walletShares});}}>Continue reward activation</button>}
 </>}
 <details className="turret-rewards-manage"><summary>Reward balances and withdrawals</summary>
 <dl><div><dt>Claimable TURRET</dt><dd>{show(current.earned,18)}</dd></div><div><dt>Position value in rewards</dt><dd>{show(current.stakedAssets,6)} USDG</dd></div></dl>
 <p>To withdraw USDG from activated shares, first return them to your wallet, then use Withdraw in the pool. Available USDG still depends on pool cash.</p>
 <div className="turret-rewards-actions"><button className="dockyard-secondary-action" disabled={disabled||current.staked===0n} onClick={()=>setReview({action:'unstake',amount:current.staked})}>Return shares to withdraw</button><button className="dockyard-secondary-action" disabled={disabled||current.earned===0n} onClick={()=>setReview({action:'claim',amount:current.earned})}>Claim TURRET</button></div>
 </details>
 </>}
 {pending&&<div role="status"><p>A rewards wallet request is unresolved. Your USDG deposit is separate and is unchanged. Check this request before submitting another.</p>
 {!pending.hash&&<label>Transaction hash from your wallet<input value={recoveryHash} onChange={e=>setRecoveryHash(e.target.value)} autoComplete="off"/></label>}
 <button className="dockyard-secondary-action" disabled={busy||(!pending.hash&&!/^0x[\da-f]{64}$/i.test(recoveryHash))} onClick={()=>void recover()}>Check rewards transaction</button>
 {pending.hash&&<a href={`https://robinhoodchain.blockscout.com/tx/${pending.hash}`} target="_blank" rel="noreferrer">View pending transaction</a>}
 </div>}
 </>:<p>Connect your wallet on Robinhood Chain to check and activate rewards. A USDG deposit alone does not activate TURRET rewards.</p>}
 {depositConfirmed&&onPause&&!complete&&<button className="dockyard-secondary-action" disabled={busy||!!pending} onClick={onPause}>Finish rewards later · return to pool</button>}
 {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 {connected&&<button className="dockyard-secondary-action" disabled={busy} onClick={()=>{setError('');void refresh();}}>Refresh rewards</button>}
 {receipt&&<p><a href={`https://robinhoodchain.blockscout.com/tx/${receipt}`} target="_blank" rel="noreferrer">View rewards transaction</a></p>}
 <p className="turret-rewards-note">Rewards are shared by activated shares during funded campaigns. TURRET rewards are separate from USDG interest; their value can fall. Pool interest depends on borrowing activity.</p>
 </section>;
}
