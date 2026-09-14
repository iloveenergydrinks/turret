import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {createPublicClient,createWalletClient,encodeFunctionData,formatUnits,http,parseAbi,toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

const OWNER='0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086';
const CONFIG='/tmp/dockyard-stock-expansion-railway.json';
const EVIDENCE='../docs/security/evidence/2026-09-03/market-expansion-live-progress.json';
const configured=JSON.parse(await readFile(CONFIG,'utf8'));
const evidence=JSON.parse(await readFile(EVIDENCE,'utf8'));
const keeperRuntime=Object.fromEntries(JSON.parse(await readFile('/tmp/dockyard-expansion-keeper-rows-prod.json','utf8')).map(x=>[x.symbol,x.env]));
const riskRuntime=Object.fromEntries(JSON.parse(await readFile('/tmp/dockyard-expansion-risk-rows-prod.json','utf8')).map(x=>[x.symbol,x.env]));
const services=configured.services;
const symbols=Object.keys(services);
const alertsBase='https://dockyard-msft-alerts-production.up.railway.app';
const rpc=services[symbols[0]].risk.ALCHEMY_RPC_URL;
const transport=http(rpc,{timeout:20_000,retryCount:1});
const client=createPublicClient({transport,cacheTime:0});
const engineAbi=parseAbi(['function owner() view returns(address)','function riskPaused() view returns(bool)','function activeDebtPositions() view returns(uint256)','function setRiskPaused(bool)']);
const poolAbi=parseAbi(['function totalAssets() view returns(uint256)','function outstandingPrincipal() view returns(uint256)','function debtLimit() view returns(uint256)']);
const erc20Abi=parseAbi(['function balanceOf(address) view returns(uint256)']);
const gateAbi=parseAbi(['function submitLiveness(bytes)']);
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
const timeout=()=>AbortSignal.timeout(12_000);

async function get(url,token){const response=await fetch(url,{headers:token?{authorization:`Bearer ${token}`}:{},redirect:'error',signal:timeout()});if(!response.ok)throw Error(`Readiness HTTP ${response.status}`);return response.json();}
function market(symbol){const service=services[symbol],record=evidence.markets.find(x=>x.symbol===symbol);assert.ok(service&&record,'Unknown market');return {service,record};}
async function readiness(symbol){
 const {service,record}=market(symbol),{keeper,risk}=service;
 const liveKeeper=keeperRuntime[symbol],liveRisk=riskRuntime[symbol];
 const [k,r,a,paused,positions,assets,debt,limit,keeperUsdg]=await Promise.all([
  get(liveRisk.RISK_KEEPER_STATUS_URL,liveRisk.RISK_KEEPER_STATUS_TOKEN),get(liveRisk.RISK_LIVENESS_URL.replace(/\/liveness$/,'/status'),liveRisk.RISK_STATUS_TOKEN),get(`${alertsBase}/${symbol}/healthz`),
  client.readContract({address:record.addresses.engine,abi:engineAbi,functionName:'riskPaused'}),
  client.readContract({address:record.addresses.engine,abi:engineAbi,functionName:'activeDebtPositions'}),
  client.readContract({address:record.addresses.pool,abi:poolAbi,functionName:'totalAssets'}),
  client.readContract({address:record.addresses.pool,abi:poolAbi,functionName:'outstandingPrincipal'}),
  client.readContract({address:record.addresses.pool,abi:poolAbi,functionName:'debtLimit'}),
  client.readContract({address:service.manifest.usdg,abi:erc20Abi,functionName:'balanceOf',args:[service.manifest.keeper]}),
 ]);
 const critical=(k.snapshot?.incidents??[]).filter(x=>x.severity==='critical').map(x=>x.code);
 const riskCritical=(r.incidents??[]).filter(x=>x.severity==='critical').map(x=>x.code);
 const ready=k.operational===true&&k.snapshot?.mode==='execute'&&k.snapshot?.reconciled===true&&!k.lastError&&!critical.length
  &&r.ready===true&&r.mode==='execute'&&!r.lastError&&!riskCritical.length&&a.monitorReady===true&&a.deliveryReady===true
  &&positions===0n&&debt===0n&&assets===20_000_000n&&limit===10_000_000n&&keeperUsdg>=limit;
 return {symbol,ready,paused,keeperOperational:k.operational===true,riskReady:r.ready===true,alertsReady:a.monitorReady===true&&a.deliveryReady===true,
  positions:String(positions),poolAssets:formatUnits(assets,6),debtLimit:formatUnits(limit,6),keeperUsdg:formatUnits(keeperUsdg,6),critical:[...critical,...riskCritical]};
}
async function allReadiness(){return Promise.all(symbols.map(readiness));}
async function publishLivenessAndPrepare(symbol){
 const rows=await allReadiness();assert.ok(rows.every(x=>x.ready||!x.paused),'Every still-paused market must be operational before launch');
 const {service,record}=market(symbol),row=rows.find(x=>x.symbol===symbol);if(!row.paused)return {done:true,row};assert.ok(row.ready,'Market is not ready');
 assert.ok(same(await client.readContract({address:record.addresses.engine,abi:engineAbi,functionName:'owner'}),OWNER),'Owner mismatch');
 const proof=await get(riskRuntime[symbol].RISK_LIVENESS_URL);assert.ok(proof.executionGate&&same(proof.executionGate,record.addresses.gate)&&/^0x[0-9a-f]+$/i.test(proof.encoded),'Invalid liveness proof');
 const now=Math.floor(Date.now()/1000);assert.ok(proof.validUntil-now>=20,'Liveness proof too close to expiry');
 const account=privateKeyToAccount(service.risk.RISK_GUARDIAN_PRIVATE_KEY);assert.ok(same(account.address,record.roles.guardian),'Guardian key mismatch');
 const wallet=createWalletClient({account,transport});
 const livenessHash=await wallet.writeContract({address:record.addresses.gate,abi:gateAbi,functionName:'submitLiveness',args:[proof.encoded]});
 const livenessReceipt=await client.waitForTransactionReceipt({hash:livenessHash,confirmations:1,timeout:45_000});assert.equal(livenessReceipt.status,'success');
 const data=encodeFunctionData({abi:engineAbi,functionName:'setRiskPaused',args:[false]});
 const gas=await client.estimateGas({account:OWNER,to:record.addresses.engine,data});
 return {done:false,symbol,expiresAt:proof.validUntil,request:{from:OWNER,to:record.addresses.engine,data,value:'0x0',gas:toHex(gas*130n/100n)}};
}
async function verify(symbol,hash){
 const {record}=market(symbol);assert.match(hash,/^0x[0-9a-fA-F]{64}$/);
 const receipt=await client.waitForTransactionReceipt({hash,confirmations:2,timeout:120_000});assert.equal(receipt.status,'success');
 const tx=await client.getTransaction({hash});assert.ok(same(tx.from,OWNER)&&same(tx.to,record.addresses.engine),'Unexpected unpause transaction');
 assert.equal(tx.input,encodeFunctionData({abi:engineAbi,functionName:'setRiskPaused',args:[false]}));
 assert.equal(await client.readContract({address:record.addresses.engine,abi:engineAbi,functionName:'riskPaused'}),false);
 record.paused=false;record.unpause={hash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,verifiedAt:new Date().toISOString()};
 evidence.updatedAt=new Date().toISOString();await writeFile(EVIDENCE,JSON.stringify(evidence,null,2));return {verified:true};
}

const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dockyard launch</title><style>body{font-family:ui-sans-serif,system-ui;background:#08111f;color:#edf4ff;max-width:820px;margin:40px auto;padding:0 20px}main{background:#101d30;border:1px solid #29405f;border-radius:18px;padding:28px}p{color:#afc1d9;line-height:1.5}button,select{border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:15px}button{background:#2f7df6;color:#fff;cursor:pointer;margin:5px}button:disabled{opacity:.45}select{background:#213552;color:#fff}.ok{color:#60d394}.warn{color:#ffd166}pre{white-space:pre-wrap;background:#08111f;padding:14px;border-radius:10px}</style></head><body><main><h1>Dockyard MVP launch</h1><p>Each step publishes a fresh liveness proof from the market guardian, then asks MetaMask to unpause that market. No USDG or collateral is transferred.</p><select id="wallet"></select><button id="launch" disabled>Loading…</button><pre id="state"></pre><p id="status"></p></main><script>
const providers=[],wallet=document.querySelector('#wallet'),button=document.querySelector('#launch'),state=document.querySelector('#state'),status=document.querySelector('#status');let rows=[];
const add=(p,label,key)=>{if(!p||providers.some(x=>x.p===p||x.key===key))return;providers.push({p,label,key});const o=document.createElement('option');o.value=providers.length-1;o.textContent=label;wallet.append(o)};
window.addEventListener('eip6963:announceProvider',e=>add(e.detail?.provider,e.detail?.info?.name??'Injected wallet',e.detail?.info?.uuid));for(const p of(window.ethereum?.providers??[window.ethereum]).filter(Boolean))add(p,p.isMetaMask?'MetaMask':'Injected wallet',p.isMetaMask?'legacy-metamask':undefined);window.dispatchEvent(new Event('eip6963:requestProvider'));
async function provider(){const p=providers[Number(wallet.value)]?.p;if(!p)throw Error('MetaMask is not available');const a=await p.request({method:'eth_requestAccounts'});if(a[0].toLowerCase()!=='${OWNER.toLowerCase()}')throw Error('Switch MetaMask to the Dockyard owner wallet');if(await p.request({method:'eth_chainId'})!=='0x1237')await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1237'}]});return p;}
async function refresh(){rows=await(await fetch('/api/status')).json();state.textContent=rows.map(x=>x.symbol+': '+(x.paused?(x.ready?'READY':'BLOCKED'):'LIVE')+' · pool '+x.poolAssets+' · keeper '+x.keeperUsdg+' USDG').join('\\n');const next=rows.find(x=>x.paused);button.disabled=!next||!rows.every(x=>x.ready||!x.paused);button.textContent=next?'Unpause '+next.symbol:'All eight markets are live';}
button.onclick=async()=>{try{button.disabled=true;const next=rows.find(x=>x.paused);const p=await provider();status.className='warn';status.textContent='Publishing a fresh '+next.symbol+' liveness proof…';const prepared=await(await fetch('/api/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:next.symbol})})).json();if(prepared.error)throw Error(prepared.error);if(prepared.done){await refresh();return;}status.textContent='Confirm in MetaMask now. The liveness proof expires quickly.';const hash=await p.request({method:'eth_sendTransaction',params:[prepared.request]});status.textContent='Submitted '+hash+'; verifying two confirmations…';const checked=await(await fetch('/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol:next.symbol,hash})})).json();if(checked.error)throw Error(checked.error);status.className='ok';status.textContent=next.symbol+' is live.';await refresh();}catch(e){status.className='warn';status.textContent=e.message;await refresh();}};refresh();
</script></body></html>`;
createServer(async(req,res)=>{try{if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});return res.end(page)}if(req.method==='GET'&&req.url==='/api/status')return json(res,200,await allReadiness());if(req.method==='POST'&&['/api/prepare','/api/verify'].includes(req.url)){let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)throw Error('Request too large')}const x=JSON.parse(body||'{}');return json(res,200,req.url==='/api/prepare'?await publishLivenessAndPrepare(x.symbol):await verify(x.symbol,x.hash))}return json(res,404,{error:'Not found'})}catch(error){console.error(error.message);return json(res,400,{error:error.message})}}).listen(3039,'127.0.0.1',()=>console.log('Dockyard launch console: http://127.0.0.1:3039/'));
