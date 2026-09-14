import './p2p-alerts.css';
import { useEffect, useId, useRef, useState } from 'react';
import { toHex, type Address, type EIP1193Provider } from 'viem';
import type { Deployment } from './client';
import { checkP2PAlertCapabilities, p2pAlertScope, p2pAlertsRequest, type AlertCapabilities, type P2PAlertScope } from './alerts-api';

type Props={account?:Address|null;provider?:EIP1193Provider|null;markets:readonly Deployment[];scopeOverride?:P2PAlertScope;serviceUrl?:string};
type Subscription={channel:'email'|'telegram';delivered:number|null;failed:boolean};
const errorMessage=(error:unknown)=>error instanceof Error && error.message.length<180 && !error.message.includes('\n')?error.message:'The alert request could not complete. Retry.';

/** Registry-bound opt-in consent. Sessions stay in memory and reset on wallet changes. */
export function P2PAlerts({account,provider,markets,scopeOverride,serviceUrl='/api/p2p-alerts'}:Props) {
  const scope=scopeOverride??p2pAlertScope(markets);
  const [verification,setVerification]=useState(()=>{
    const params=new URLSearchParams(window.location.search);
    return params.getAll('alerts').length===1&&params.get('alerts')==='verify'?window.location.hash.slice(1):null;
  });
  useEffect(()=>{
    if(verification===null)return;
    const url=new URL(window.location.href);url.hash='';window.history.replaceState(null,'',url);
  },[verification]);
  return <>
    {verification!==null&&<VerifyEmail scope={scope} serviceUrl={serviceUrl} token={verification} done={()=>setVerification(null)}/>}
    <Settings key={`${account??'disconnected'}:${scope?.scope??'unavailable'}:${serviceUrl}`} account={account} provider={provider} scope={scope} serviceUrl={serviceUrl}/>
  </>;
}
function VerifyEmail({scope,serviceUrl,token,done}:{scope:P2PAlertScope|null;serviceUrl:string;token:string;done():void}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const pending=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const valid=/^[a-f0-9]{64}$/.test(token);
  async function confirm(){
    if(!scope||!valid||pending.current)return;pending.current=true;setBusy(true);setMessage('');
    try {
      checkP2PAlertCapabilities(await p2pAlertsRequest(serviceUrl,'/capabilities'),scope);
      if(!alive.current)return;
      await p2pAlertsRequest(serviceUrl,'/verify','',{token});
      if(alive.current)setMessage('Email confirmed. P2P loan reminders and updates are enabled.');
    }catch{if(alive.current)setMessage('This link expired, was already used, or the service is unavailable. Request another confirmation from P2P alert settings.');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  return <section className="p2p-controls" aria-label="Confirm P2P email alerts">
    <h2>Confirm P2P email alerts</h2><p>Enable deadline reminders and loan updates for the wallet shown in your email.</p>
    {!valid&&<p role="alert">The confirmation link is incomplete. Request a new email from your P2P alert settings.</p>}
    {message.startsWith('Email confirmed')?<button className="p2p-button p2p-secondary" onClick={done}>Done</button>:<button className="p2p-button" disabled={busy||!valid||!scope} onClick={()=>void confirm()}>{busy?'Confirming…':'Confirm P2P email'}</button>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
function Settings({account,provider,scope,serviceUrl}:{account?:Address|null;provider?:EIP1193Provider|null;scope:P2PAlertScope|null;serviceUrl:string}) {
  const id=useId(),active=useRef(true),pending=useRef(false),providerRef=useRef(provider);providerRef.current=provider;
  const [capabilities,setCapabilities]=useState<AlertCapabilities|null>(null),[session,setSession]=useState('');
  const [subscriptions,setSubscriptions]=useState<Subscription[]>([]),[email,setEmail]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[telegram,setTelegram]=useState('');
  const request=(path:string,body?:object,method?:string)=>p2pAlertsRequest(serviceUrl,path,session,body,method);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{
    if(!scope)return;let cancelled=false;
    const refresh=async()=>{try{const value=checkP2PAlertCapabilities(await p2pAlertsRequest(serviceUrl,'/capabilities'),scope);if(!cancelled)setCapabilities(value);}catch{if(!cancelled)setCapabilities(null);}};
    void refresh();const timer=setInterval(()=>void refresh(),30000);return()=>{cancelled=true;clearInterval(timer);};
  },[scope?.scope,serviceUrl]);
  useEffect(()=>{
    if(!session)return;let cancelled=false;
    const refresh=async()=>{try{const value=await p2pAlertsRequest(serviceUrl,'/subscriptions',session);if(!Array.isArray(value)||value.some(row=>!['email','telegram'].includes(row.channel)))throw new Error();if(!cancelled){
      setSubscriptions(value as Subscription[]);
      const telegramConnected=value.some(row=>row.channel==='telegram'),emailConnected=value.some(row=>row.channel==='email');
      if(telegramConnected)setTelegram('');
      setMessage(previous=>(telegramConnected&&previous.startsWith('Open Telegram'))||(emailConnected&&previous.startsWith('Confirmation email queued'))?'':previous);
    }}catch{if(!cancelled){setSession('');setSubscriptions([]);setError('Verify your wallet again to manage P2P alerts.');}}};
    void refresh();const timer=setInterval(()=>void refresh(),10000);return()=>{cancelled=true;clearInterval(timer);};
  },[session,serviceUrl]);
  async function act(action:()=>Promise<void>){if(pending.current||!active.current)return;pending.current=true;setBusy(true);setError('');setMessage('');
    try{await action();}catch(error){if(active.current)setError(errorMessage(error));}finally{pending.current=false;if(active.current)setBusy(false);}}
  async function walletMatches(selected:EIP1193Provider){
    const [accounts,chain]=await Promise.all([selected.request({method:'eth_accounts'}),selected.request({method:'eth_chainId'})]);
    if(!active.current||providerRef.current!==selected||!Array.isArray(accounts)||accounts[0]?.toLowerCase()!==account?.toLowerCase()||Number(chain)!==scope?.chainId)throw new Error('Wallet or network changed. Reopen P2P alerts for the connected wallet.');
  }
  async function verify(){
    if(!account||!provider||!scope)return;const selected=provider;
    checkP2PAlertCapabilities(await p2pAlertsRequest(serviceUrl,'/capabilities'),scope);await walletMatches(selected);
    const challenge=await p2pAlertsRequest(serviceUrl,'/challenge','',{wallet:account}) as {id:string;message:string};
    const prefix=`${window.location.origin} requests ${scope.protocol==='nft'?'Turret NFT P2P':'Turret P2P'} alert access.\nWallet: ${account.toLowerCase()}\nChain ID: ${scope.chainId}\nMarket scope: ${scope.scope}\nNonce: ${challenge.id}\nExpires: `;
    const suffix='\nThis signature only manages notifications. It authorizes no token approvals or transactions.';
    const expiry=typeof challenge.message==='string'?challenge.message.slice(prefix.length,-suffix.length):'';
    if(!/^[a-f0-9]{64}$/.test(challenge.id)||challenge.message!==prefix+expiry+suffix||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now()||Date.parse(expiry)>Date.now()+360000)throw new Error('The P2P consent request does not match this site and market scope.');
    await walletMatches(selected);
    const signature=await selected.request({method:'personal_sign',params:[toHex(challenge.message),account]});
    await walletMatches(selected);
    const result=await p2pAlertsRequest(serviceUrl,'/session','',{id:challenge.id,signature}) as {session:string};
    if(!/^[a-f0-9]{64}$/.test(result.session))throw new Error('Invalid P2P alert session.');
    if(active.current)setSession(result.session);
  }
  async function subscribe(channel:'email'|'telegram'){
    const result=await request('/subscriptions',{channel,...(channel==='email'?{email}:{})}) as {url?:string};
    if(!active.current)return;
    if(channel==='telegram'){
      if(!/^https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=[a-f0-9]{64}$/.test(result.url??''))throw new Error('Invalid Telegram confirmation link.');
      setTelegram(result.url!);setMessage('Open Telegram and press Start to confirm P2P alerts. The link expires in 15 minutes.');
    }else setMessage('Confirmation email queued. Follow its link to enable P2P alerts.');
  }
  async function remove(channel:string){await request('/subscriptions',{channel},'DELETE');if(active.current){setSubscriptions(rows=>rows.filter(row=>row.channel!==channel));setMessage(`${channel==='email'?'Email':'Telegram'} P2P alerts disabled.`);}}
  const available=capabilities?.monitorOperational&&(capabilities.email||capabilities.telegram);
  return <section className="p2p-controls p2p-alerts" aria-labelledby={`${id}-title`}>
    <header className="p2p-alerts-heading">
      <h2 id={`${id}-title`}>{scope?.protocol==='nft'?'NFT loan alerts':'P2P alerts'}</h2>
      <p>Deadline reminders and loan updates, by email or Telegram. Alerts do not repay loans, move funds, or extend deadlines. You must take those actions yourself.</p>
    </header>
    {!capabilities?<p className="p2p-alerts-notice" role="status">Automatic P2P alerts are currently unavailable. Keep your calendar reminders and check your loans here.</p>:!capabilities.monitorReady?<p className="p2p-alerts-notice" role="status">{capabilities.monitorOperational?'Earlier loans are still being checked. Notifications for verified loans continue while discovery catches up.':'The P2P alert monitor is unavailable. Check your loans directly.'}</p>:null}
    {!account||!provider?<p className="p2p-alerts-notice">Connect your wallet to manage P2P alerts.</p>:!session?<div className="p2p-alerts-verification">
      <button className="p2p-button" disabled={busy||!scope||!capabilities} aria-busy={busy} onClick={()=>void act(verify)}>{busy?'Verifying…':'Verify wallet for P2P alerts'}</button>
      <p>Sign a message to manage notifications. No transaction or spending approval.</p>
    </div>:<>
      <p className="p2p-alerts-verified">Wallet verified</p>
      <div className="p2p-alerts-channels">
        {subscriptions.map(sub=><section key={sub.channel} className="p2p-alerts-channel" aria-label={`${sub.channel==='email'?'Email':'Telegram'} alerts`}>
          <div className="p2p-alerts-channel-heading"><h3>{sub.channel==='email'?'Email':'Telegram'}</h3><p>Connected</p></div>
          <div className="p2p-alerts-channel-content">
            <p className="p2p-alerts-delivery">{sub.failed?'Delivery failed; retries are queued. Check the loan directly.':sub.delivered?`Last accepted by provider: ${new Date(sub.delivered).toLocaleString()}`:'No loan notification delivered yet.'}</p>
            <button type="button" className="p2p-button p2p-secondary" disabled={busy} onClick={()=>void act(()=>remove(sub.channel))}>Disable {sub.channel} P2P alerts</button>
          </div>
        </section>)}
        {capabilities?.email&&!subscriptions.some(s=>s.channel==='email')&&<section className="p2p-alerts-channel" aria-label="Email alerts">
          <div className="p2p-alerts-channel-heading"><h3>Email</h3><p>Confirm your address to enable alerts.</p></div>
          <form className="p2p-alerts-email" onSubmit={event=>{event.preventDefault();void act(()=>subscribe('email'));}}>
            <label htmlFor={`${id}-email`}>Email address</label>
            <div className="p2p-alerts-email-controls">
              <input id={`${id}-email`} type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/>
              <button type="submit" className="p2p-button" disabled={busy||!available}>Send confirmation</button>
            </div>
          </form>
        </section>}
        {capabilities?.telegram&&!subscriptions.some(s=>s.channel==='telegram')&&<section className="p2p-alerts-channel" aria-label="Telegram alerts">
          <div className="p2p-alerts-channel-heading"><h3>Telegram</h3><p>Confirm in Telegram to enable alerts.</p></div>
          <div className="p2p-alerts-channel-content">
            {telegram?<a className="p2p-button p2p-secondary" href={telegram} target="_blank" rel="noopener noreferrer">Confirm P2P alerts in Telegram</a>:<button type="button" className="p2p-button p2p-secondary" disabled={busy||!available} onClick={()=>void act(()=>subscribe('telegram'))}>Connect Telegram</button>}
          </div>
        </section>}
        {capabilities&&!capabilities.email&&!capabilities.telegram&&<p className="p2p-alerts-notice">No P2P delivery channels are configured.</p>}
      </div>
    </>}
    {message&&<p className="p2p-alerts-notice" role="status">{message}</p>}
    {error&&<p className="p2p-alerts-notice p2p-alerts-error" role="alert">{error}</p>}
    <details className="p2p-alerts-details">
      <summary>About these alerts</summary>
      <div>
        <p>{scope?.protocol==='nft'?'Reminders are scheduled one day and one hour before the final deadline, including the 24-hour grace period. Updates cover acceptance, repayment and default. NFT loans do not support deadline extensions.':'Reminders are scheduled one day and one hour before the final deadline. Updates cover acceptance, repayment, default and agreed extensions. Extension requests notify the other party.'}</p>
        <p>Opt-in only. Your wallet is linked to your chosen contact for these notifications. Disable a channel to delete its subscription. {scope?.protocol==='nft'?'Settlement cancels outstanding reminders. NFT alerts are separate from token P2P alerts.':'Reminders update after settlement or an agreed extension.'}</p>
        {session&&<p>{scope?.protocol==='nft'?'This consent covers all NFT loans on this lending contract, including collections enabled later.':`This consent covers ${scope?.markets.length} registered P2P markets.`} Chain {scope?.chainId}.</p>}
      </div>
    </details>
    <p className="p2p-alerts-disclaimer">Delivery can be delayed or missed; deadlines still apply.</p>
  </section>;
}
