import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/app/turret-fonts.css';
import '../../src/app/brand.css';
import '../../src/app/controls.css';
import '../../src/screens/P2PLoansScreen/negotiations.css';
import {P2PLoansScreen} from '../../src/screens/P2PLoansScreen/P2PLoansScreen';
import {NegotiationEditor} from '../../src/screens/P2PLoansScreen/NegotiationTerms';
import {P2PAppLayout} from '../../src/p2p/P2PAppLayout';
import {previewMarkets} from './client';
// Deliberately illustrative: no backend or wallet submission is available in this preview.
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>String(input).startsWith('/api/')?new Response(JSON.stringify({error:'Illustrative preview: live services are disabled.'}),{status:503,headers:{'Content-Type':'application/json'}}):originalFetch(input,init);
const original={principal:'1000000000',collateral:'10000000000000000000',interest:'10000000',durationDays:14,expiresAt:Math.floor(Date.now()/1000)+2*86400};
createRoot(document.getElementById('root')!).render(<><aside style={{padding:'12px 24px',background:'#292524',color:'#fff',font:'14px system-ui'}}>Local design preview · illustrative amounts · wallet transactions disabled · <a style={{color:'#fff'}} href="/">Browse loans</a> · <a style={{color:'#fff'}} href="/negotiation">Compare proposed terms</a></aside>{location.pathname==='/negotiation'?<P2PAppLayout network="Local preview" wallet={<span>No wallet connected</span>}><div className="p2p-page p2p-workspace"><h2>Propose different terms</h2><p>The original offer stays available until the lender cancels it.</p><NegotiationEditor market={previewMarkets[0] as any} original={original} initial={{...original,interest:'5000000',durationDays:21}} sourceExpiry={original.expiresAt} disabled={false} onSubmit={async()=>{alert('Review only. No proposal was sent.');}}/></div></P2PAppLayout>:<P2PLoansScreen standalone/>}</>);
