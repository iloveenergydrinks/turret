"use client";
import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { borrowCapacity, freshSnapshot, startingLtv, type BorrowInputs } from './borrow-estimate';
import { LoanCostDetails, type CashbackEstimateState } from './LoanCostDetails';
import './wallet-flow.css';
type Snapshot=BorrowInputs & {timestamp:bigint;proofsValidUntil:bigint|null;aprBps:number;liquidationLtvBps:number;collateralBalance:bigint};
const usd=(x:bigint)=>Number(formatUnits(x,6)).toLocaleString('en-US',{maximumFractionDigits:6});
export function BorrowEstimate({state,extra,amount,deposit,unavailable,days:selectedDays,onDaysChange,cashback}:{state:Snapshot|null;extra:bigint;amount:bigint;deposit:boolean;unavailable:boolean;days?:number;onDaysChange?:(days:number)=>void;cashback?:CashbackEstimateState}) {
 const [localDays,setLocalDays]=useState(30),[now,setNow]=useState(Date.now);
 const days=selectedDays??localDays,setDays=onDaysChange??setLocalDays;
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const fresh=state && freshSnapshot(state.timestamp,now,state.proofsValidUntil);
 const capacity=fresh&&!unavailable?borrowCapacity(state,deposit?extra:0n):null;
 const ltv=fresh&&!unavailable?startingLtv(state,deposit?extra:0n,amount):null;
 return <section className="turret-borrow-estimate" aria-label="Loan estimate">
  <dl className="turret-capacity-facts"><div id="isolated-borrow-limit"><dt>Borrowing capacity</dt><dd>{capacity===null?'—':usd(capacity)+' USDG'}</dd></div>
  <div><dt>Starting LTV</dt><dd>{ltv===null?'—':Number(ltv)/100+'%'}</dd></div>
  <div><dt>Liquidation threshold</dt><dd>{fresh?state.liquidationLtvBps/100+'%':'—'}</dd></div></dl>
  <LoanCostDetails principal={amount} aprBps={fresh?state.aprBps:null} now={Math.floor(now/1000)} days={days} onDaysChange={setDays} {...cashback} />
  {capacity!==null&&capacity>0n&&amount>capacity&&<p role="status">This amount exceeds the estimated capacity. Reduce your loan or add collateral.</p>}
  {state&&!unavailable&&deposit&&extra>state.collateralBalance&&<p role="status">The collateral amount exceeds your wallet balance.</p>}

 </section>;
}
