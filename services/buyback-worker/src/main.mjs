import {failureResult,workerStatus} from './status.mjs';
import {readFileSync} from 'node:fs';import{createServer}from'node:http';
import{createPublicClient,createWalletClient,http,parseEther}from'viem';import{privateKeyToAccount}from'viem/accounts';
import{Store,publicJson}from'../../liquidator/src/store.mjs';import{BuybackWorker}from'./worker.mjs';import{verifyDeployment}from'./verify.mjs';import{quoteForPolicy}from'./quote.mjs';
const config=JSON.parse(process.env.BUYBACK_DEPLOYMENT_JSON||readFileSync(new URL('../config/deployment.json',import.meta.url),'utf8'));
const mode=process.env.BUYBACK_MODE??'observe';if(!['observe','execute'].includes(mode)||config.chainId!==4663)throw Error('invalid_configuration');
const sizingPolicy=process.env.BUYBACK_SIZING_POLICY??'impact-limited',quote=quoteForPolicy(sizingPolicy);
let status={mode,sizingPolicy,reason:'awaiting_wallet_setup'},lastCompleted=Date.now();
const server=createServer((req,res)=>{if(!['/status','/healthz'].includes(req.url)){res.writeHead(404).end();return;}const alive=Date.now()-lastCompleted<300000;res.writeHead(alive?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(publicJson({...status,alive}));}).listen(Number(process.env.PORT??8080),'::');
if(!config.module){if(mode!=='observe')throw Error('deployment_required');setInterval(()=>{lastCompleted=Date.now();},30000);await new Promise(()=>{});}
const endpoints=[process.env.BUYBACK_RPC_URL,process.env.BUYBACK_PEER_RPC_URL];if(endpoints.some(x=>!x||new URL(x).protocol!=='https:')||new URL(endpoints[0]).hostname===new URL(endpoints[1]).hostname)throw Error('independent_RPC_required');
const chain={id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoints[0]]}}};
const [client,peer]=endpoints.map(url=>createPublicClient({chain,transport:http(url,{timeout:12000,retryCount:0})}));
const account=mode==='execute'?privateKeyToAccount(process.env.BUYBACK_PRIVATE_KEY):{address:config.operator};if(account.address.toLowerCase()!==config.operator.toLowerCase())throw Error('wrong_operator');
const wallet=createWalletClient({chain,account,transport:http(endpoints[0],{timeout:12000,retryCount:0})});
const store=new Store(process.env.BUYBACK_DATA_DIR??'/data',{protocol:'turret-hourly-buyback-v1',chainId:4663,module:config.module,operator:config.operator});
const until=Date.now()+150000;for(;;){try{store.acquireLease();break;}catch(e){if(e.message!=='Another keeper owns this volume'||Date.now()>until)throw e;await new Promise(r=>setTimeout(r,5000));}}
const worker=new BuybackWorker({client,wallet,account,store,config:{...config,mode,sizingPolicy,maxTxFee:parseEther('0.0001'),maxDailyGas:parseEther('0.0024'),minEth:parseEther('0.0002')},quote,verify:()=>verifyDeployment(client,peer,config)});
let stopped=false,wake;const lease=setInterval(()=>{try{store.renewLease();if(Date.now()-lastCompleted>300000)process.exit(1);}catch{process.exit(1);}},10000);lease.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;wake?.();});
while(!stopped){try{const x=await worker.cycle();status={...workerStatus(mode,x),sizingPolicy};}catch(e){status={...workerStatus(mode,failureResult(e)),sizingPolicy};}lastCompleted=Date.now();console.log(publicJson(status));if(!stopped)await new Promise(r=>{const t=setTimeout(r,store.pendingTx()?15000:60000);wake=()=>{clearTimeout(t);r();};});}
clearInterval(lease);server.close();store.close();
