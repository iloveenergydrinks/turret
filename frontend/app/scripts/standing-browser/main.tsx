import { createRoot } from 'react-dom/client';
import { useMemo, useRef, useState } from 'react';
import type { EIP1193Provider } from 'viem';
import { StandingMarket } from '../../src/facilities/StandingPage';
import { FacilityPage } from '../../src/facilities/FacilityPage';
import { P2PAppLayout } from '../../src/p2p/P2PAppLayout';
import { validateStandingConfig } from '../../src/facilities/standing-model';
import { TestWalletContext } from './test-wallet';
import '../../src/app/brand.css';
import '../../src/app/turret-fonts.css';
import '../../src/screens/P2PLoansScreen/p2p.css';
const fixture = await fetch('/test-fixture').then(r=>r.json());
const config = validateStandingConfig(fixture.factoryConfig,location.hostname);
if(config.chainId!==31337 || location.hostname!=='127.0.0.1') throw Error('Local test fixture only.');
type Prompt = {method:string; approve:()=>Promise<void>;reject:()=>void};
function TestApp(){
 const [role,setRole]=useState<'lender'|'borrower'>(()=>sessionStorage.getItem('standing-test-role')==='borrower'?'borrower':'lender');
 const [prompt,setPrompt]=useState<Prompt|null>(null),[connected,setConnected]=useState(true);
 const account=fixture.accounts[role],selected=useRef(account);selected.current=account;
 const provider=useMemo(()=>({request:async({method,params}:{method:string;params?:unknown})=>{
  if(['eth_accounts','eth_requestAccounts'].includes(method))return [selected.current];if(method==='eth_chainId')return '0x7a69';
  const signing=['eth_sendTransaction','eth_signTypedData_v4'].includes(method);
  const send=async()=>{const r=await fetch(signing?'/test-wallet-rpc':'/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});const d=await r.json();if(d.error)throw Object.assign(Error(d.error.message??d.error),{code:d.error.code});return d.result;};
  if(!signing)return send();
  return new Promise((resolve,reject)=>setPrompt({method,approve:async()=>{setPrompt(null);try{resolve(await send());}catch(e){reject(e);}},reject:()=>{setPrompt(null);reject(Object.assign(Error('Rejected in local test wallet'),{code:4001}));}}));
 }}) as EIP1193Provider,[]);
 return <TestWalletContext.Provider value={{account:connected?account:null,chainId:31337,provider:connected?provider:null,connect:async()=>setConnected(true),error:null}}><P2PAppLayout activePage="borrow" network="Local chain 31337" wallet={<label>Test wallet <select aria-label="Test wallet" value={role} disabled={!!prompt} onChange={e=>{const value=e.target.value as typeof role;setRole(value);sessionStorage.setItem('standing-test-role',value);}}><option value="lender">Lender</option><option value="borrower">Borrower</option></select></label>}>
  <p className="facility-preview-note">Local chain fixture · test tokens only · <a href="/?standing=1">Standing offers</a> · <a href="/?standing=1&intent=lend">Lender setup</a></p>
  {new URLSearchParams(location.search).has('facility')?<FacilityPage />:<section className="facility-workspace"><StandingMarket config={config}/></section>}
  {prompt&&<dialog open aria-label="Local test wallet" style={{position:'fixed',inset:'15% 16px auto',margin:'auto',zIndex:1000,maxWidth:540,width:'calc(100% - 32px)',padding:24,background:'white',border:'2px solid #292524',borderRadius:12}}><h2>Local test wallet</h2><p>{prompt.method==='eth_signTypedData_v4'?'Sign lending terms':'Confirm test transaction'} · {role}</p><button className="facility-primary" onClick={()=>void prompt.approve()}>Approve in test wallet</button><button className="facility-secondary" onClick={prompt.reject}>Reject in test wallet</button></dialog>}
 </P2PAppLayout></TestWalletContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<TestApp/>);
