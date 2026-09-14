"use client";
import { TermLabel } from "../comps/FieldInfo/FieldInfo";
import { EmptyState } from "../comps/EmptyState/EmptyState";
import {useEffect,useState} from "react";
import {BorrowPageHeader} from "./BorrowPageHeader";
import {PoolMarketStatus} from "./PoolMarketStatus";
import {useBorrowWallet} from './useBorrowWallet';
import './wallet-flow.css';
import type {CentralMarket} from "./central-credit";
type Market = {symbol:string;engine:string;admission:string;collateral:string;chainId:number;central?:CentralMarket};
const names:Record<string,string>={AAPL:"Apple",MSFT:"Microsoft",GOOGL:"Alphabet",AMZN:"Amazon",META:"Meta Platforms",NVDA:"Nvidia",AMD:"AMD",MU:"Micron",TSLA:"Tesla",SPY:"S&P 500 ETF",QQQ:"Nasdaq-100 ETF",SLV:"Silver",CASHCAT:"Cash Cat"};
export function PoolLoanDirectory(_props: {overview?:boolean} = {}) {
 const [ownedOnly,setOwnedOnly]=useState(false);
 const [markets,setMarkets]=useState<Market[]>([]),[error,setError]=useState(false),[loading,setLoading]=useState(true),[attempt,retry]=useState(0);
 useEffect(()=>{let alive=true;setError(false);setLoading(true);fetch('/borrow-pools.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(!Array.isArray(data.markets))throw Error();const rows=data.markets.filter((m:Market)=>m.admission==='active');if(rows.some((m:Market)=>!/^0x[0-9a-f]{40}$/i.test(m.engine)||typeof m.symbol!=='string'||!/^0x[0-9a-f]{40}$/i.test(m.collateral)||m.chainId!==4663))throw Error();if(alive)setMarkets(rows);}).catch(()=>{if(alive)setError(true);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[attempt]);
 const wallet=useBorrowWallet(markets);
 useEffect(()=>setOwnedOnly(false),[wallet.address,wallet.connected]);
 const filtered=ownedOnly&&wallet.connected?markets.filter(m=>wallet.facts[m.engine]==null||wallet.facts[m.engine]!.balance>0n):markets;
 const owned=markets.filter(m=>(wallet.facts[m.engine]?.balance??0n)>0n).length;
 const complete=markets.length>0&&markets.every(m=>wallet.facts[m.engine]!=null);
 return <section className="borrow-hub"><BorrowPageHeader active="pools" />
 <div className="borrow-wallet-toolbar"><p>{!wallet.address?'Explore all markets. Connect your wallet to see your balances and borrowing estimates.':wallet.wrongChain?'Switch to Robinhood Chain to see your wallet balances.':complete?`${owned} supported ${owned===1?'asset':'assets'} in your wallet. Explore any market to get started.`:'Checking wallet balances. All markets remain available while checks finish.'}</p>
 <label className="borrow-owned-toggle"><input type="checkbox" checked={ownedOnly} disabled={!wallet.connected} onChange={e=>setOwnedOnly(e.target.checked)} />Only assets I own</label></div>
 {ownedOnly&&complete&&!filtered.length&&<div className="turret-funding-help"><p>No supported assets found in this wallet.</p><button className="p2p-button p2p-secondary" onClick={()=>setOwnedOnly(false)}>Show all markets</button></div>}
 {error?<div role="alert"><p>Pool markets could not be loaded.</p><button className="p2p-button" onClick={()=>retry(x=>x+1)}>Retry markets</button></div>:loading?<p role="status">Loading pool markets…</p>:!markets.length?<EmptyState title="No pool markets are available" description="There are no active pools in this market list. Check again, or explore loans funded by individual lenders." actions={<><button className="p2p-button" onClick={()=>retry(x=>x+1)}>Retry markets</button><a className="p2p-button p2p-secondary" href="/borrow/p2p">Explore P2P loans</a></>} />:<div className="borrow-original-tables">{[
 {title:"Stocks",rows:filtered.filter(m=>!['SPY','QQQ','SLV','CASHCAT'].includes(m.symbol))},
 {title:"ETFs",rows:filtered.filter(m=>['SPY','QQQ'].includes(m.symbol))},
 {title:"Metals",rows:filtered.filter(m=>m.symbol==='SLV')},
 {title:"Memecoins",rows:filtered.filter(m=>m.symbol==='CASHCAT')},
 ].filter(group=>group.rows.length).map(group=><section key={group.title}><h2>{group.title}</h2><table className="rusd-market-table"><caption className="borrow-table-caption">{group.rows.length} collateral {group.rows.length===1?'market':'markets'} · Open means the pool is enabled. Loan availability is checked in the market.</caption><thead><tr><th scope="col">Market</th><th scope="col"><TermLabel topic="poolStatus" helpLabel="pool status">Status</TermLabel></th><th scope="col">Action</th></tr></thead><tbody>{group.rows.map(m=><PoolMarketStatus key={m.engine} market={m} name={names[m.symbol]||m.symbol} walletConnected={wallet.connected} walletFacts={wallet.facts[m.engine]}/>)}</tbody></table></section>)}</div>}

 <p className="borrow-directory-note">Want to agree your own terms? <a href="/borrow/p2p">Explore P2P stock & token loans</a>.</p></section>;
}
