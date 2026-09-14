import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StakingView,type Review} from '../../src/staking/StakingView';
import type {StakingDeployment,StakingState} from '../../src/staking/client';
import '../../src/app/turret-fonts.css';
import '../../src/app/brand.css';
import {HeaderNavigation} from '../../src/comps/AppLayout/HeaderNavigation';
const hash=`0x${'ab'.repeat(32)}` as const;
const d:StakingDeployment={address:'0x3333333333333333333333333333333333333333',router:'0x4444444444444444444444444444444444444444',runtimeHash:hash,routerRuntimeHash:hash,tokenRuntimeHash:hash,usdgRuntimeHash:hash,startBlock:'1'};
const sample:StakingState={account:'0x1111111111111111111111111111111111111111',blockNumber:10n,canUnstake:true,lastStakeBlock:1n,walletBalance:25000n*10n**18n,staked:10000n*10n**18n,totalStaked:500000n*10n**18n,earned:12500000n,totalFunded:625000000n,totalClaimed:0n,totalCollected:1250000000n,allowance:0n,treasuryAllowance:1000000n};
const scenario=new URLSearchParams(location.search).get('state')??'active';
function Preview(){
 const [mode,setMode]=useState<'stake'|'unstake'>('stake'),[amount,setAmount]=useState(''),[review,setReview]=useState<Review>(),[notice,setNotice]=useState('');
 return <><div style={{background:'#292524',color:'#fff',textAlign:'center',padding:10,font:'14px system-ui'}}>Local preview · Illustrative balances · No wallet transactions</div>
 <header className="rusd-topbar"><div className="rusd-frame rusd-topbar-inner rusd-topbar-preview" style={{boxSizing:'border-box'}}><a className="rusd-brand-link" href="/"><img src="/brand/turret-mark.svg" width="32" height="32" alt=""/><span style={{font:'24px Georgia'}}>turret.</span></a><HeaderNavigation><a className="rusd-nav-link" href="#">Borrow</a><a className="rusd-nav-link" href="#">Earn</a><a className="rusd-nav-link" data-active="true" href="#" aria-current="page">Stake</a><a className="rusd-nav-link" href="#">Portfolio</a></HeaderNavigation><span className="rusd-account" style={{font:'14px system-ui'}}>Robinhood Chain</span></div></header>
 <StakingView deployment={scenario==='inactive'?null:d} connected={scenario!=='disconnected'} wrongChain={false} state={scenario==='loading'||scenario==='error'?undefined:sample} mode={mode} amount={amount} review={review} busy={false} pending={null} recoveryHash="" storageError={false} error={scenario==='error'?'Balances could not be checked. Refresh to try again.':''} notice={notice} onMode={v=>{setMode(v);setAmount('')}} onAmount={setAmount} onReview={setReview} onConfirm={()=>{setReview(undefined);setNotice('Preview only. No wallet transaction was submitted.')}} onRefresh={()=>setNotice('Preview balances refreshed.')} onRecover={()=>{}} onRecoveryHash={()=>{}} onConnect={()=>setNotice('Preview only. Wallet connections are disabled.')} onSwitchChain={()=>{}}/></>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
