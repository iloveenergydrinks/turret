"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { positiveAmount } from '../dockyard-amount';
import { usdgSwapLink } from './usdg-swap';
import './wallet-flow.css';
export function USDGSwap({direction='get',amount=0n,label,otherToken,onReturn,disabled=false}: {
 direction?:'get'|'swap';amount?:bigint;label?:string;otherToken?:{symbol:string;address:string};onReturn?:()=>void;disabled?:boolean;
}) {
 const dialog=useRef<HTMLDialogElement>(null), trigger=useRef<HTMLButtonElement>(null), id=useId();
 const [value,setValue]=useState(''), [other,setOther]=useState('ETH');
 const returning=useRef(onReturn);returning.current=onReturn;
 useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')returning.current?.();};window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[]);
 const parsed=positiveAmount(value,6);
 const requested=parsed<2n**256n?parsed:0n;
 const href=requested?usdgSwapLink(direction,requested,other):null;
 return <><button ref={trigger} type="button" className="dockyard-secondary-action" disabled={disabled} onClick={()=>{setValue(amount>0n?formatUnits(amount,6):'');setOther('ETH');dialog.current?.showModal();}}>{label??(direction==='get'?'Get USDG':'Swap USDG')}</button>
 <dialog ref={dialog} className="turret-swap-dialog" aria-labelledby={id+'-title'} onClose={()=>{returning.current?.();trigger.current?.focus();}}>
  <div className="turret-swap-heading"><h2 id={id+'-title'}>{direction==='get'?'Get USDG':'Swap your USDG'}</h2><button type="button" className="dockyard-secondary-action" onClick={()=>dialog.current?.close()}>Close</button></div>
  <p>Swap on Robinhood Chain through Uniswap, then return to your loan.</p>
  <label htmlFor={id+'-amount'}>{direction==='get'?'USDG you want to receive':'USDG to swap'}</label>
  <input id={id+'-amount'} inputMode="decimal" maxLength={100} autoComplete="off" value={value} onChange={e=>setValue(e.target.value)} />
  <label htmlFor={id+'-token'}>{direction==='get'?'Pay with':'Receive'}</label>
  <select id={id+'-token'} value={other} onChange={e=>setOther(e.target.value)}><option value="ETH">ETH</option>{otherToken&&<option value={otherToken.address}>{otherToken.symbol}</option>}</select>
  <p className="turret-swap-note">Uniswap opens in a new tab with these tokens and amount selected. Review its live quote, fees and minimum received before signing. A route depends on available liquidity. Keep ETH for gas.</p>
  {href?<a className="dockyard-primary-action" href={href} target="_blank" rel="noopener noreferrer">Continue on Uniswap</a>:<button className="dockyard-primary-action" type="button" disabled>Enter a USDG amount</button>}
  <button className="dockyard-secondary-action" type="button" onClick={()=>dialog.current?.close()}>Back to Turret & refresh balances</button>
 </dialog></>;
}
