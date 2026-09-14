import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createPublicClient,createWalletClient,http,parseEther} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {Store,publicJson} from '../../liquidator/src/store.mjs';
import {Collector} from './collector.mjs';
import {verifyDeployment} from './verify.mjs';

const load=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const manifest=load('../config/deployment.json'),pools=load('../config/pools.json');
const d=manifest.deployment;
const mode=process.env.COLLECTOR_MODE??'observe';
if(!['observe','execute'].includes(mode))throw Error('invalid_mode');
if(manifest.chainId!==4663||manifest.stakerShareBps!==5000||pools.pools.length!==13)throw Error('verified_deployment_required');
if(!d){
  if(mode!=='observe')throw Error('verified_deployment_required');
  const status={alive:true,mode,reason:'awaiting_verified_deployment'};
  const server=createServer((req,res)=>{
    if(!['/healthz','/status'].includes(req.url)){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(status));
  }).listen(Number(process.env.PORT??8080),'::');
  console.log(JSON.stringify(status));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
  // Standby does not load the signing key, use RPC, or submit transactions.
  await new Promise(()=>{});
}
const endpoints=[process.env.COLLECTOR_RPC_URL,process.env.COLLECTOR_PEER_RPC_URL];
if(endpoints.some(x=>!x||new URL(x).protocol!=='https:')||new URL(endpoints[0]).hostname===new URL(endpoints[1]).hostname)throw Error('independent_https_rpc_required');
const chain={id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoints[0]]}}};
const [client,peer]=endpoints.map(url=>createPublicClient({chain,transport:http(url,{timeout:12000,retryCount:0})}));
const account=privateKeyToAccount(process.env.COLLECTOR_PRIVATE_KEY);
const wallet=createWalletClient({chain,account,transport:http(endpoints[0],{timeout:12000,retryCount:0})});
const config={mode,router:d.router,staking:d.address,usdg:manifest.rewardToken,treasury:manifest.treasury,pools:pools.pools,
  minFees:10000n,maxTxFee:parseEther('0.00001'),maxDailyGas:parseEther('0.0001'),minEth:parseEther('0.00002')};
const store=new Store(process.env.COLLECTOR_DATA_DIR??'/data',{protocol:'turret-staking-collector-v1',chainId:4663,router:d.router.toLowerCase(),account:account.address.toLowerCase()});
// A rolling deployment may overlap the old process while it exits. No writer
// starts until the persisted lease is free or expired.
const deadline=Date.now()+150000;
for(;;){try{store.acquireLease();break;}catch(e){if(e.message!=='Another keeper owns this volume'||Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,5000));}}
const collector=new Collector({client,wallet,account,store,config,verify:()=>verifyDeployment(client,peer,manifest,pools)});
let status={reason:'starting',mode,account:account.address,router:d.router,staking:d.address},lastCompleted=Date.now(),stopped=false,wake;
const server=createServer((req,res)=>{
  if(req.url!=='/healthz'&&req.url!=='/status'){res.writeHead(404).end();return;}
  const alive=Date.now()-lastCompleted<600000;
  res.writeHead(alive?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(publicJson({...status,alive}));
}).listen(Number(process.env.PORT??8080),'::');
const lease=setInterval(()=>{try{store.renewLease();if(Date.now()-lastCompleted>600000)process.exit(1);}catch{process.exit(1);}},10000);lease.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;wake?.();});
while(!stopped){
  try{status={...status,...await collector.cycle(),error:null,checkedAt:new Date().toISOString()};}
  catch{status={...status,reason:'verification_or_rpc_failed',error:'execution_paused',checkedAt:new Date().toISOString()};}
  lastCompleted=Date.now();console.log(publicJson(status));
  if(!stopped)await new Promise(r=>{const timer=setTimeout(r,store.pendingTx()?15000:300000);wake=()=>{clearTimeout(timer);r();};});
}
clearInterval(lease);server.close();store.close();
