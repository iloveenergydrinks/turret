import {recoverWalletClient} from '../wallet/recoverWalletClient';
import {useEffect,useMemo,useRef,useState} from 'react';
import {erc20Abi,formatUnits,isAddress,parseAbi,parseUnits,decodeEventLog,type Address,type Hex} from 'viem';
import {usePublicClient,useWalletClient} from 'wagmi';
import {useWalletSession} from '../wallet/useWalletSession';
import {centralStatus,validateCentral,type CentralMarket} from './central-credit';
import {borrowCapacity} from './borrow-estimate';
import {useBorrowWallet} from './useBorrowWallet';
import {PAYMENT_TOKENS,SWAP_ROUTER,minimumReceived,validateSwapRoute,swapNeed} from './collateral-swap.mjs';
import {approveSwap,paymentBalance,paymentAllowance,sendCollateralSwap} from './swap-wallet.mjs';
import './get-collateral.css';
import collateralLogos from '../p2p/collateral-logos.json';

type Market={symbol:string;engine:Address;collateral:Address;admission:string;chainId:number;central:CentralMarket};
type Quote={id:string;routeSummary:any;expiresAt:number};
type Pending={hash:Hex;kind:'approve'|'swap';account:Address;engine:Address;amount:string;payToken:'USDG'|'ETH';minimum:string;before:string;at:number};
const names:Record<string,string>={NVDA:'Nvidia',AAPL:'Apple',MSFT:'Microsoft',GOOGL:'Alphabet',AMZN:'Amazon',META:'Meta Platforms',AMD:'AMD',MU:'Micron',TSLA:'Tesla',SPY:'S&P 500 ETF',QQQ:'Nasdaq-100 ETF',SLV:'Silver',CASHCAT:'Cash Cat'};
const num=(v:bigint,d=18,max=6)=>Number(formatUnits(v,d)).toLocaleString('en-US',{maximumFractionDigits:max});
const pendingKey=(a:string,e:string)=>`turret:collateral-swap:${a.toLowerCase()}:${e.toLowerCase()}`;
function amountOf(s:string,d:number){try{return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)&&(!s.includes('.')||s.split('.')[1]!.length<=d)?parseUnits(s,d):0n;}catch{return 0n;}}
async function api(path:string,body:unknown){
 const response=await fetch('/api/collateral-swap/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(18000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'The swap service is unavailable. Try again.');return result;
}
function marketStatus(market:Market){
 return centralStatus(validateCentral(market.central),()=>fetch('/api/collateral-swap/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engine:market.engine}),cache:'no-store',signal:AbortSignal.timeout(7000)}));
}
export function GetCollateral(){
 const [market,setMarket]=useState<Market>(),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
 const engine=new URLSearchParams(location.search).get('engine');
 useEffect(()=>{let active=true;setFailed(false);fetch('/borrow-pools.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(b=>{
  const m=b.markets.find((m:Market)=>m.engine.toLowerCase()===engine?.toLowerCase()&&m.admission==='active'&&m.chainId===4663&&m.central&&isAddress(m.collateral));
  if(!m)throw Error();if(active)setMarket(m);
 }).catch(()=>{if(active)setFailed(true);});return()=>{active=false;};},[engine,retry]);
 if(!market)return <section className="collateral-workspace"><a href="/borrow">Back to markets</a><h1>Get collateral</h1>{failed?<><p role="alert">This market could not be loaded.</p><button className="p2p-button" onClick={()=>setRetry(v=>v+1)}>Retry market</button></>:<p role="status">Loading market…</p>}</section>;
 return <CollateralWorkspace key={market.engine} market={market}/>;
}
export function CollateralWorkspace({market}:{market:Market}){
 const session=useWalletSession();
 return <ScopedCollateralWorkspace key={`${market.engine}:${session.account}:${session.chainId}`} market={market}/>;
}
function ScopedCollateralWorkspace({market}:{market:Market}){
 const session=useWalletSession(),client=usePublicClient({chainId:4663}),{data:wallet,refetch:refreshWallet}=useWalletClient();
 const account=session.account;
 const [payToken,setPayToken]=useState<'USDG'|'ETH'>('USDG'),[amount,setAmount]=useState(''),[slippage,setSlippage]=useState(50);
 const [summary,setSummary]=useState<Awaited<ReturnType<typeof centralStatus>>>(),[statusError,setStatusError]=useState(false),[ltv,setLtv]=useState<number>();
 const [quote,setQuote]=useState<Quote>(),[quoteBusy,setQuoteBusy]=useState(false),[review,setReview]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [busy,setBusy]=useState(''),[pending,setPending]=useState<Pending>(),[uncertain,setUncertain]=useState(false);
 const [balance,setBalance]=useState<bigint>(),[allowance,setAllowance]=useState<bigint>(),[tick,setTick]=useState(Date.now);
 const [ltvError,setLtvError]=useState(false),[estimateAttempt,setEstimateAttempt]=useState(0);
 const [received,setReceived]=useState<{account:Address;amount:bigint;hash:Hex}>();
 const alive=useRef(true),lock=useRef(false),current=useRef(''),generation=useRef(0),currentAccount=useRef(account),reconcileOperation=useRef(0);currentAccount.current=account;
 const marketList=useMemo(()=>[market],[market,estimateAttempt]);const holdings=useBorrowWallet(marketList);
 const inputAmount=amountOf(amount,PAYMENT_TOKENS[payToken].decimals);
 const request={engine:market.engine,payToken,amountIn:inputAmount.toString(),slippageBps:slippage};
 const identity=[account,session.chainId,payToken,amount,slippage].join(':');current.current=identity;
 const connected=!!account&&session.chainId===4663;
 useEffect(()=>{alive.current=true;const t=setInterval(()=>setTick(Date.now()),1000);return()=>{alive.current=false;clearInterval(t);};},[]);
 useEffect(()=>{generation.current++;setQuote(undefined);setQuoteBusy(false);setReview(false);setBalance(undefined);setAllowance(undefined);setError('');setNotice('');setReceived(undefined);},[identity]);
 useEffect(()=>{setPending(undefined);setUncertain(false);
  if(account)try{const raw=sessionStorage.getItem(pendingKey(account,market.engine));if(raw){const p=JSON.parse(raw);if(p.account.toLowerCase()===account.toLowerCase()&&p.engine.toLowerCase()===market.engine.toLowerCase()&&/^0x[0-9a-f]{64}$/i.test(p.hash)&&['approve','swap'].includes(p.kind))setPending(p);}}
  catch{setError('Saved transaction details could not be read. Check your wallet activity before retrying.');setUncertain(true);}
 },[account,market.engine]);
 useEffect(()=>{let active=true,inFlight=false;
  const refresh=async()=>{if(inFlight||document.visibilityState==='hidden')return;inFlight=true;
   try{const s=await marketStatus(market);if(active){setSummary(s);setStatusError(false);}}
   catch{if(active)setStatusError(true);}finally{inFlight=false;}};
  void refresh();const t=setInterval(refresh,4000);window.addEventListener('focus',refresh);
  return()=>{active=false;clearInterval(t);window.removeEventListener('focus',refresh);};
 },[market]);
 useEffect(()=>{if(!client)return;let active=true,inFlight=false;setLtvError(false);
  const read=async()=>{if(inFlight||document.visibilityState==='hidden')return;inFlight=true;
  await client.readContract({address:market.engine,abi:parseAbi(['function maxLtvBps() view returns(uint16)']),functionName:'maxLtvBps'}).then(v=>{swapNeed(v>0&&v<=10000);if(active){setLtv(v);setLtvError(false);}}).catch(()=>{if(active){setLtv(undefined);setLtvError(true);}}).finally(()=>{inFlight=false;});};
  void read();const timer=setInterval(read,15000);return()=>{active=false;clearInterval(timer);};
 },[client,market,estimateAttempt]);
 async function refreshPayment(){if(!client||!account||!connected)return;
  const id=current.current;try{const [b,a]=await Promise.all([paymentBalance(client,account,payToken),paymentAllowance(client,account,payToken)]);if(alive.current&&id===current.current){setBalance(b);setAllowance(a);}}
  catch{if(alive.current&&id===current.current){setBalance(undefined);setAllowance(undefined);}}
 }
 useEffect(()=>{void refreshPayment();const t=setInterval(refreshPayment,15000);return()=>clearInterval(t);},[client,identity,pending]);
 const ready=!!summary&&!statusError&&summary.ready&&Number(summary.validUntil)*1000>tick&&!!summary.availability&&!summary.availability.paused&&summary.availability.cash>0n&&summary.availability.debtLimit>summary.availability.principal;
 const fresh=!!quote&&quote.expiresAt>tick;
 const facts=holdings.facts[market.engine];
 const expected=quote?BigInt(quote.routeSummary.amountOut):0n;
 const minimum=quote?minimumReceived(quote.routeSummary.amountOut,slippage):0n;
 const maxLtv=facts?.maxLtvBps??ltv;
 const estimated=ready&&summary?.availability&&maxLtv!==undefined&&(!account||facts)?borrowCapacity({...summary.availability,collateral:facts?.collateral??0n,debt:facts?.debt??0n,maxLtvBps:maxLtv,borrowingPrice:summary.borrowingPrice,riskPaused:false},minimum):null;
 const needsApproval=payToken==='USDG'&&allowance!==undefined&&allowance<inputAmount;
 const short=balance!==undefined&&inputAmount>balance;
 const disabled=!!busy||!!pending||uncertain;
 const approvedReceived=received?.account===account?received:undefined;
 const guard=(id:string)=>swapNeed(alive.current&&current.current===id,'The connected wallet or amount changed. Review the swap again.');
 async function verifyReady(){const s=await marketStatus(market);swapNeed(s.ready&&s.availability&&!s.availability.paused&&s.availability.cash>0n&&s.availability.debtLimit>s.availability.principal,'Borrowing is currently unavailable in this market. Try again later.');}
 async function loadQuote(reviewAfter=false){if(lock.current||disabled)return;const id=current.current,g=++generation.current;
  setQuoteBusy(true);setError('');setQuote(undefined);setReview(reviewAfter);setNotice('');
  try{swapNeed(inputAmount>0n,'Enter a valid payment amount.');const q=await api('quote',request);guard(id);if(g!==generation.current)return;
   validateSwapRoute(q.routeSummary,request,market);swapNeed(typeof q.id==='string'&&Number.isSafeInteger(q.expiresAt)&&q.expiresAt>Date.now()&&q.expiresAt<=Date.now()+30000);
   setQuote(q);setReview(reviewAfter);if(reviewAfter)setNotice('Review the amounts before confirming in your wallet.');
  }catch(e:any){if(alive.current&&current.current===id&&g===generation.current)setError(e.message||'The quote could not be loaded. Try again.');}
  finally{if(alive.current&&g===generation.current)setQuoteBusy(false);}
 }
 function reviewQuote(){
  if(!fresh){void loadQuote(true);return;}
  setReview(true);setNotice('Review the amounts before confirming in your wallet.');
 }
 // Preview while editing; freeze a reviewed quote until the user refreshes it.
 useEffect(()=>{
  if(disabled||review||approvedReceived||!ready||inputAmount<=0n||fresh||document.visibilityState==='hidden')return;
  const timer=setTimeout(()=>void loadQuote(false),500);return()=>clearTimeout(timer);
 },[identity,ready,disabled,review,!!approvedReceived,fresh]);
 async function reconcile(p:Pending){
  if(!client||currentAccount.current!==p.account)return;
  const operation=++reconcileOperation.current;
  const canUpdate=()=>alive.current&&currentAccount.current===p.account&&reconcileOperation.current===operation;
  setBusy('Checking transaction…');setError('');
  try{
   let cancelled=false;
   const receipt=await client.waitForTransactionReceipt({hash:p.hash,confirmations:1,timeout:90000,onReplaced:replacement=>{cancelled=replacement.reason==='cancelled';p={...p,hash:replacement.transaction.hash};try{sessionStorage.setItem(pendingKey(p.account,p.engine),JSON.stringify(p));}catch{}if(canUpdate())setPending(p);}});
   if(cancelled)throw Object.assign(Error('Transaction cancelled in your wallet.'),{settled:true});
   if(receipt.status!=='success')throw Object.assign(Error('The transaction reverted. No swap was completed.'),{settled:true});
   if(p.kind==='swap'){
    const tx=await client.getTransaction({hash:receipt.transactionHash});
    swapNeed(tx.from.toLowerCase()===p.account.toLowerCase()&&tx.to?.toLowerCase()===SWAP_ROUTER.toLowerCase(),'The replacement transaction needs review in your wallet.');
    let received=0n;
    for(const log of receipt.logs){if(log.address.toLowerCase()!==market.collateral.toLowerCase())continue;try{const e=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics});if(e.args.to.toLowerCase()===p.account.toLowerCase())received+=e.args.value;if(e.args.from.toLowerCase()===p.account.toLowerCase())received-=e.args.value;}catch{}}
    swapNeed(received>=BigInt(p.minimum),'The transaction confirmed. Check your collateral balance in the market.');
    if(canUpdate())setReceived({account:p.account,amount:received,hash:receipt.transactionHash});
   }
   try{sessionStorage.removeItem(pendingKey(p.account,p.engine));}catch{}if(canUpdate()){setPending(undefined);setQuote(undefined);setReview(false);setNotice(p.kind==='approve'?'USDG approved. Refresh the quote to review current amounts.':'Swap confirmed. Your collateral is available in your wallet.');void refreshPayment();}
  }catch(e:any){if(e.settled){try{sessionStorage.removeItem(pendingKey(p.account,p.engine));}catch{}if(canUpdate())setPending(undefined);}
   if(canUpdate())setError(e.settled?e.message:'Confirmation is not verified yet. Check the transaction below, then check confirmation again.');
  }finally{if(canUpdate())setBusy('');}
 }
 async function transact(){if(lock.current||disabled||!client||!account)return;
  lock.current=true;const id=current.current;setError('');let requested=false;
  try{setBusy('Connecting to your wallet…');const signingWallet=await recoverWalletClient(wallet,refreshWallet);guard(id);
   swapNeed(ready&&fresh&&!!quote&&quote.expiresAt>Date.now(),'This quote expired or the market changed. Refresh the quote.');
   swapNeed(estimated!==null&&estimated>0n,'Check your borrowing capacity before buying collateral.');
   setBusy('Preparing transaction…');const before=await client.readContract({address:market.collateral,abi:erc20Abi,functionName:'balanceOf',args:[account]});
   const kind=needsApproval?'approve':'swap';
   const assertCurrent=()=>{guard(id);requested=true;setBusy('Confirm in your wallet…');};
   let hash:Hex;
   if(needsApproval)hash=await approveSwap({client,wallet:signingWallet,account,amount:inputAmount,assertCurrent});
   else{const built=await api('build',{quoteId:quote!.id,account});guard(id);hash=await sendCollateralSwap({client,wallet:signingWallet,account,input:request,market,quote,built,assertCurrent,ready:verifyReady});}
   const p:Pending={hash,kind,account,engine:market.engine,amount:inputAmount.toString(),payToken,minimum:minimum.toString(),before:before.toString(),at:Date.now()};
   try{sessionStorage.setItem(pendingKey(account,market.engine),JSON.stringify(p));}catch{/* Keep the hash in memory even when storage is unavailable. */}
   if(alive.current&&currentAccount.current===p.account)setPending(p);await reconcile(p);
  }catch(e:any){const rejected=[e?.code,e?.cause?.code,e?.cause?.cause?.code].includes(4001)||/User rejected|User denied/i.test(e?.message||'');
   if(alive.current){setError(rejected?'Request cancelled in your wallet. You can try again.':e.shortMessage||e.message||'The transaction could not be prepared. Try again.');
    if(requested&&!rejected){setUncertain(true);setError('The wallet did not return a transaction hash. Check its activity before sending another transaction.');}}
  }finally{lock.current=false;if(alive.current)setBusy('');}
 }
 const marketURL=`/borrow?engine=${market.engine}`;
 const continueURL=approvedReceived?`${marketURL}&collateralAmount=${formatUnits(approvedReceived.amount,18)}&swapAccount=${account}`:marketURL;
 return <section className="collateral-workspace">
  <nav className="collateral-breadcrumb" aria-label="Breadcrumb"><a href="/borrow">Borrow</a><span aria-hidden="true">/</span><span>{market.symbol}</span></nav>
  <h1>Borrow against {market.symbol}</h1><p className="collateral-intro">Get collateral here, then use it to borrow USDG.</p>
  <div className="collateral-market-row"><div>{(collateralLogos as Record<string,string>)[`4663:${market.collateral.toLowerCase()}`]&&<img width="32" height="32" alt="" src={(collateralLogos as Record<string,string>)[`4663:${market.collateral.toLowerCase()}`]}/>}<strong>{market.symbol}</strong><span>{names[market.symbol]||market.symbol}</span></div><a className="p2p-button p2p-secondary" href={marketURL}>View market</a></div>
  <div className="collateral-columns"><section className="collateral-swap-panel" aria-labelledby="get-collateral-title">
   <h2 id="get-collateral-title">Get {market.symbol}</h2><p>Swap {payToken} for {market.symbol} using KyberSwap.</p>
   {!ready&&<div className="collateral-status" role="status"><strong>{!summary&&!statusError?'Checking borrowing availability…':'Borrowing is currently unavailable'}</strong><p>{!summary&&!statusError?'Checking this market before preparing a swap.':'Quotes will be available when market checks and pool capacity are ready.'}</p></div>}
   <label htmlFor="swap-amount">Pay with</label><div className="collateral-amount-row"><input id="swap-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={disabled} onChange={e=>setAmount(e.target.value)}/><select aria-label="Payment token" value={payToken} disabled={disabled} onChange={e=>{setPayToken(e.target.value as 'USDG'|'ETH');setAmount('');}}><option>USDG</option><option>ETH</option></select></div>
   <div className="collateral-balance">{connected?<><span>Balance: {balance===undefined?'Checking…':`${num(balance,PAYMENT_TOKENS[payToken].decimals)} ${payToken}`}</span>{payToken==='USDG'&&balance!==undefined&&<button className="collateral-text-button" disabled={disabled} onClick={()=>setAmount(formatUnits(balance,6))}>Max</button>}</>:<span>Connect your wallet to see your balance.</span>}</div>
   {short&&<p className="collateral-error" role="alert">The amount exceeds your wallet balance.</p>}
   <label>Receive approximately</label><div className="collateral-receive"><output>{quote?num(expected):quoteBusy?'Getting quote…':'—'}</output><strong>{market.symbol}</strong></div>
   <dl className="collateral-quote-details"><div><dt>Minimum received</dt><dd title={quote?formatUnits(minimum,18):undefined}>{quote?`${num(minimum/10n**12n*10n**12n)} ${market.symbol}`:'—'}</dd></div>
    <div><dt><label htmlFor="swap-slippage">Slippage tolerance</label></dt><dd><select id="swap-slippage" value={slippage} disabled={disabled} onChange={e=>setSlippage(Number(e.target.value))}><option value={10}>0.1%</option><option value={50}>0.5%</option><option value={100}>1%</option></select></dd></div>
    <div><dt>Route</dt><dd>KyberSwap</dd></div><div><dt>Network fee</dt><dd>{quote&&Number.isFinite(Number(quote.routeSummary.gasUsd))?`~$${Number(quote.routeSummary.gasUsd).toFixed(2)} + approval if needed`:'Shown with the quote'}</dd></div>
   </dl>
   {quote&&<p className="collateral-quote-age" aria-live="off">{fresh?`Quote expires in ${Math.max(0,Math.ceil((quote.expiresAt-tick)/1000))}s`:'Quote expired. Refresh before continuing.'}</p>}
   {quote&&<p className="collateral-mobile-estimate">Estimated borrowing limit: {estimated===null?'Checking…':`${num(estimated,6,2)} USDG`}</p>}
   {quote&&!fresh&&<p className="collateral-notice" role="status">Quote expired. Refresh to review current amounts.</p>}
   {(ltvError&&!facts||facts===null)&&<div className="collateral-error" role="status"><p>The borrowing estimate could not be checked.</p><button className="collateral-text-button" disabled={disabled} onClick={()=>setEstimateAttempt(v=>v+1)}>Retry borrowing estimate</button></div>}
   {error&&<p className="collateral-error" role="alert">{error}</p>}{notice&&!error&&<p className="collateral-notice" role="status">{notice}</p>}
   {pending?<div className="collateral-pending"><a href={`https://explorer.robinhood.com/tx/${pending.hash}`} target="_blank" rel="noreferrer">View transaction</a><button className="p2p-button" disabled={!!busy} onClick={()=>void reconcile(pending)}>{busy||'Check confirmation'}</button></div>:approvedReceived?<a className="p2p-button collateral-primary" href={continueURL}>Continue to borrow</a>:<>
    {!review||!fresh?<button className="p2p-button collateral-primary" disabled={disabled||quoteBusy||!ready||inputAmount<=0n} onClick={reviewQuote}>{busy||(quoteBusy?'Getting quote…':quote&&!fresh?'Refresh quote':'Review swap')}</button>:!account?<button className="p2p-button collateral-primary" onClick={()=>void session.connect()}>Connect wallet to swap</button>:!connected?<button className="p2p-button collateral-primary" onClick={()=>void session.connect()}>Switch to Robinhood Chain</button>:<button className="p2p-button collateral-primary" disabled={disabled||!ready||short||estimated===null||estimated===0n||balance===undefined||allowance===undefined} onClick={()=>void transact()}>{busy||(needsApproval?'Approve USDG':`Swap ${amount} ${payToken}`)}</button>}
    {review&&fresh&&!disabled&&<button className="collateral-text-button collateral-edit" onClick={()=>{setReview(false);setNotice('');}}>Edit amounts</button>}
   </>}
   {busy.includes('wallet')&&<p role="status">Open your wallet extension or app to confirm or cancel this request.</p>}
   <p className="collateral-footnote">Buying collateral and borrowing are separate transactions. Availability is checked again before borrowing.</p>
  </section><aside className="collateral-next" aria-labelledby="collateral-next-title"><h2 id="collateral-next-title">Your next step</h2><p>After you receive {market.symbol}, you can use it as collateral for a USDG loan.</p>
   <dl><div><dt>{approvedReceived?'Received in your wallet':'Collateral from this swap'}</dt><dd>{approvedReceived?num(approvedReceived.amount):quote?num(expected):'—'} {market.symbol}</dd></div>
    <div><dt>Estimated borrowing limit</dt><dd>{quote&&estimated!==null?num(estimated,6,2):'—'} USDG</dd><p>Based on minimum received, existing debt and available pool capacity.</p></div></dl>
   {quote&&estimated===0n&&<p className="collateral-error">This amount does not currently support a new loan. Check market limits before buying.</p>}
   <p>Once your swap is confirmed, continue to the loan form to choose how much to borrow.</p><p className="collateral-footnote">Interest applies to the loan. Your collateral can be liquidated if its value falls too far.</p>
   {approvedReceived&&<a className="p2p-button" href={continueURL}>Continue to borrow</a>}
  </aside></div>
  <section className="collateral-terms"><h2>{market.symbol} market terms</h2><p>Review current interest, borrowing limits and liquidation terms before opening a loan.</p><a href={marketURL}>View {market.symbol} market terms</a></section>
 </section>;
}
