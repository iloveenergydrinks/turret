import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {createPublicClient,getAddress,http,keccak256,parseAbi} from 'viem';
import {getTransactionEventually} from './transaction-reconciliation.mjs';

const PLAN_FILE='/tmp/dockyard-stock-expansion-plan.json';
const STATE_FILE='../docs/security/evidence/2026-09-03/market-expansion-live-progress.json';
const RPC=process.env.COLLATERAL_RPC_URL??'https://rpc.mainnet.chain.robinhood.com';
const PORT=3037;
const confirmations=2;
const factoryAbi=parseAbi(['function totalCreated() view returns(uint256)','function operator() view returns(address)']);
const engineAbi=parseAbi(['function riskPaused() view returns(bool)','function owner() view returns(address)','function pool() view returns(address)','function collateralToken() view returns(address)']);
const poolAbi=parseAbi(['function creditEngine() view returns(address)','function debtLimit() view returns(uint256)','function totalAssets() view returns(uint256)','function outstandingPrincipal() view returns(uint256)']);
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};

const plan=JSON.parse(await readFile(PLAN_FILE,'utf8'));
const client=createPublicClient({transport:http(RPC,{timeout:30000,retryCount:1}),cacheTime:0,pollingInterval:1000});
let state;
try { state=JSON.parse(await readFile(STATE_FILE,'utf8')); }
catch { state={version:1,factory:null,markets:[],updatedAt:new Date().toISOString()}; }
const steps=[{kind:'factory',label:'Deploy the hash-pinned batch factory',target:plan.factory.address,transaction:plan.factory.transaction},
  ...plan.markets.map(m=>({kind:'market',label:`Deploy paused ${m.symbol} market`,symbol:m.symbol,target:m.addresses.bundle,transaction:m.transaction}))];
const completed=()=>Number(Boolean(state.factory))+state.markets.length;
async function save(){state.updatedAt=new Date().toISOString();await writeFile(STATE_FILE,JSON.stringify(state,null,2));}

async function verifyFactory(hash){
  const receipt=await client.waitForTransactionReceipt({hash,confirmations,timeout:180000});
  const tx=await getTransactionEventually(client,hash);
  assert.equal(receipt.status,'success'); assert.equal(tx.to,null); assert.ok(same(tx.from,plan.owner));
  assert.equal(tx.input,plan.factory.transaction.data); assert.ok(same(receipt.contractAddress,plan.factory.address));
  assert.equal(keccak256(await client.getCode({address:plan.factory.address})),plan.factory.runtimeHash);
  assert.ok(same(await client.readContract({address:plan.factory.address,abi:factoryAbi,functionName:'operator'}),plan.owner));
  assert.equal(await client.readContract({address:plan.factory.address,abi:factoryAbi,functionName:'totalCreated'}),0n);
  state.factory={hash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,address:plan.factory.address,runtimeHash:plan.factory.runtimeHash};delete state.pending;await save();
}

async function verifyMarket(m,hash){
  const receipt=await client.waitForTransactionReceipt({hash,confirmations,timeout:240000});
  const tx=await getTransactionEventually(client,hash);
  assert.equal(receipt.status,'success'); assert.ok(same(tx.from,plan.owner)); assert.ok(same(tx.to,plan.factory.address));
  assert.equal(tx.input,m.transaction.data); assert.equal(tx.value,0n);
  assert.equal(await client.readContract({address:plan.factory.address,abi:factoryAbi,functionName:'totalCreated'}),BigInt(m.start+4));
  const deploymentAddresses=[m.addresses.guard,m.addresses.gate,m.addresses.bundle,m.addresses.exit];
  for(let i=0;i<4;i++)assert.equal(keccak256(await client.getCode({address:deploymentAddresses[i]})),m.runtimeHashes[i]);
  const [paused,owner,pool,collateral,creditEngine,debtLimit,assets,principal]=await Promise.all([
    client.readContract({address:m.addresses.engine,abi:engineAbi,functionName:'riskPaused'}),
    client.readContract({address:m.addresses.engine,abi:engineAbi,functionName:'owner'}),
    client.readContract({address:m.addresses.engine,abi:engineAbi,functionName:'pool'}),
    client.readContract({address:m.addresses.engine,abi:engineAbi,functionName:'collateralToken'}),
    client.readContract({address:m.addresses.pool,abi:poolAbi,functionName:'creditEngine'}),
    client.readContract({address:m.addresses.pool,abi:poolAbi,functionName:'debtLimit'}),
    client.readContract({address:m.addresses.pool,abi:poolAbi,functionName:'totalAssets'}),
    client.readContract({address:m.addresses.pool,abi:poolAbi,functionName:'outstandingPrincipal'})]);
  assert.equal(paused,true); assert.ok(same(owner,plan.owner)); assert.ok(same(pool,m.addresses.pool));
  assert.ok(same(collateral,m.input.credit.collateral)); assert.ok(same(creditEngine,m.addresses.engine));
  assert.equal(debtLimit,10_000_000n); assert.equal(assets,0n); assert.equal(principal,0n);
  state.markets.push({symbol:m.symbol,hash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,addresses:m.addresses,
    roles:m.roles,runtimeHashes:m.runtimeHashes,paused:true,debtLimitUsdg:'10',empty:true}); delete state.pending;await save();
}

async function preflight(index){
  assert.equal(index,completed(),'Unexpected deployment step');
  assert.ok(Date.now()<Date.parse(plan.expiresAt),'Reviewed market configurations expired');
  assert.equal(await client.getChainId(),4663);
  const head=await client.getBlock();assert.ok(BigInt(Math.floor(Date.now()/1000))-head.timestamp<60n,'RPC head stale');
  const step=steps[index],tx=step.transaction;
  if(index===0){
    assert.ok(!(await client.getCode({address:plan.factory.address})),'Factory address already occupied');
    assert.equal(await client.getTransactionCount({address:plan.owner,blockTag:'pending'}),plan.ownerNonce,'Owner nonce changed');
    await client.call({account:plan.owner,data:tx.data});
  } else {
    assert.ok(same(await client.readContract({address:plan.factory.address,abi:factoryAbi,functionName:'operator'}),plan.owner));
    assert.equal(await client.readContract({address:plan.factory.address,abi:factoryAbi,functionName:'totalCreated'}),BigInt(plan.markets[index-1].start));
    await client.call({account:plan.owner,to:plan.factory.address,data:tx.data});
  }
  const request={from:plan.owner,data:tx.data,gas:tx.gas,value:'0x0',...(tx.to?{to:tx.to}:{})};
  return {step:{index,kind:step.kind,label:step.label,symbol:step.symbol,target:step.target},request};
}

const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dockyard market rollout</title><style>
body{font-family:ui-sans-serif,system-ui;background:#08111f;color:#edf4ff;max-width:760px;margin:48px auto;padding:0 20px}main{background:#101d30;border:1px solid #29405f;border-radius:18px;padding:28px}h1{margin:0 0 8px}p{color:#afc1d9;line-height:1.5}.step{padding:14px 0;border-top:1px solid #29405f}button,select{border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:15px}button{background:#2f7df6;color:white;cursor:pointer}select{background:#213552;color:#edf4ff;margin-right:8px}button:disabled{opacity:.45}.ok{color:#60d394}.warn{color:#ffd166}code{word-break:break-all}#status{white-space:pre-wrap}</style></head><body><main><h1>Dockyard market rollout</h1><p>Eight isolated markets. Each transaction atomically deploys a paused engine, empty lender pool, oracle guard, and pinned liquidation executor. ORCL is excluded.</p><div id="progress"></div><div class="step"><strong id="next">Loading…</strong><p id="target"></p><select id="wallet"></select><button id="send" disabled>Prepare wallet request</button></div><p id="status"></p></main><script>
const send=document.querySelector('#send'),status=document.querySelector('#status'),wallet=document.querySelector('#wallet');let snapshot;
const injected=(window.ethereum?.providers??[window.ethereum]).filter(Boolean);
const walletName=p=>p.isRabby?'Rabby':p.isMetaMask?'MetaMask':p.isTrust?'Trust Wallet':p.isCoinbaseWallet?'Coinbase Wallet':'Injected wallet';
const wallets=injected.map((provider,index)=>({provider,index,name:walletName(provider)}));wallets.sort((a,b)=>(a.name==='Rabby'?-1:0)-(b.name==='Rabby'?-1:0));
for(const item of wallets){const option=document.createElement('option');option.value=String(item.index);option.textContent=item.name;wallet.append(option);}if(!wallets.length){const option=document.createElement('option');option.textContent='No injected wallet';wallet.append(option);}
const selectedProvider=()=>injected[Number(wallet.value)];
async function refresh(){snapshot=await (await fetch('/api/status')).json();document.querySelector('#progress').innerHTML='<strong>'+snapshot.completed+' / '+snapshot.total+' deployment steps verified</strong>';
 if(snapshot.done){document.querySelector('#next').textContent='All deployments verified';document.querySelector('#target').textContent='';send.disabled=true;status.className='ok';status.textContent='Paused deployment complete.';return;}
 document.querySelector('#next').textContent=snapshot.next.label;document.querySelector('#target').innerHTML='<code>'+snapshot.next.target+'</code>';send.disabled=false;send.textContent=snapshot.pending?'Verify submitted transaction':'Prepare wallet request';}
send.onclick=async()=>{try{send.disabled=true;status.className='warn';status.textContent='Checking current chain state…';
 if(snapshot.pending){status.textContent='Retrying chain verification for '+snapshot.pending.hash+'…';const result=await (await fetch('/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(snapshot.pending)})).json();if(result.error)throw Error(result.error);status.className='ok';status.textContent='Verified: '+snapshot.pending.hash;await refresh();return;}
 const provider=selectedProvider();if(!provider)throw Error('No injected wallet is available');let accounts=await provider.request({method:'eth_requestAccounts'});if(accounts[0].toLowerCase()!==snapshot.owner.toLowerCase())throw Error('Switch '+walletName(provider)+' to the Dockyard owner wallet');
 if(await provider.request({method:'eth_chainId'})!=='0x1237')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1237'}]});
 const prepared=await (await fetch('/api/preflight',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index:snapshot.completed})})).json();if(prepared.error)throw Error(prepared.error);
 status.textContent='Confirm this deployment in MetaMask. It transfers no ETH or tokens; only gas is spent.';send.textContent='Waiting for MetaMask…';
 const hash=await provider.request({method:'eth_sendTransaction',params:[prepared.request]});status.textContent='Transaction submitted: '+hash+'\\nWaiting for two confirmations and runtime verification…';
 const result=await (await fetch('/api/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index:snapshot.completed,hash})})).json();if(result.error)throw Error(result.error);
 status.className='ok';status.textContent='Verified: '+hash;await refresh();
 }catch(e){status.className='warn';status.textContent=e.message;send.disabled=false;send.textContent='Try again';}};refresh();
</script></body></html>`;

createServer(async(req,res)=>{
  try {
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});return res.end(page);}
    if(req.method==='GET'&&req.url==='/api/status'){
      const index=completed();return json(res,200,{owner:plan.owner,completed:index,total:steps.length,done:index===steps.length,pending:state.pending?.index===index?state.pending:null,next:steps[index]&&{label:steps[index].label,target:steps[index].target}});
    }
    if(req.method==='POST'&&(req.url==='/api/preflight'||req.url==='/api/verify')){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)throw Error('Request too large');}const input=JSON.parse(body||'{}');
      if(req.url==='/api/preflight')return json(res,200,await preflight(input.index));
      assert.equal(input.index,completed());assert.match(input.hash,/^0x[0-9a-fA-F]{64}$/);state.pending={index:input.index,hash:input.hash};await save();
      if(input.index===0)await verifyFactory(input.hash);else await verifyMarket(plan.markets[input.index-1],input.hash);
      return json(res,200,{verified:true});
    }
    json(res,404,{error:'Not found'});
  } catch(error){console.error(error.stack);json(res,400,{error:error.message});}
}).listen(PORT,'127.0.0.1',()=>console.log(`Dockyard expansion console: http://127.0.0.1:${PORT}/`));
