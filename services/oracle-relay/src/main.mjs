import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {encodeFunctionData,keccak256,parseEther} from './deps.mjs';
import {requestPrices,priceIssues,PYTH_VERIFIER} from './pyth.mjs';
import {relayAbi,hubAbi,verifierAbi,adapterAbi} from './abi.mjs';
import {configFromEnv} from '../../liquidator/src/config.mjs';
import {Store,publicJson} from '../../liquidator/src/store.mjs';
import {Chain,errorCode,log} from '../../liquidator/src/chain.mjs';
import {Transactions} from '../../liquidator/src/transactions.mjs';
import {Alerts,incident} from '../../liquidator/src/alerts.mjs';

let config,manifest,chain,store;
try {
 manifest=JSON.parse(process.env.ORACLE_MANIFEST_JSON ?? readFileSync(process.env.ORACLE_MANIFEST_PATH));
 const env={...process.env,KEEPER_MODE:process.env.ORACLE_RELAY_MODE ?? 'observe',KEEPER_PRIVATE_KEY:process.env.ORACLE_RELAY_PRIVATE_KEY,
  KEEPER_VAULT_CODE_HASH:manifest.relayCodeHash,KEEPER_DATA_DIR:process.env.ORACLE_DATA_DIR ?? './data/oracle',
  KEEPER_STATUS_TOKEN:process.env.ORACLE_STATUS_TOKEN,KEEPER_NATIVE_WATCHDOG:'false',KEEPER_ALERT_WEBHOOK_URL:process.env.ORACLE_ALERT_WEBHOOK_URL,
  KEEPER_POLL_MS:'10000',KEEPER_REPLACE_AFTER_MS:'10000',KEEPER_CONFIRMATIONS:'2'};
 config={...configFromEnv(env),vault:manifest.vault,codeHash:manifest.vaultCodeHash};
 if(manifest.chainId!==4663 || !manifest.markets?.length || manifest.markets.length>32 || !process.env.PYTH_API_KEY
  || !/^0x[\da-f]{64}$/i.test(manifest.relayCodeHash ?? '') || !/^0x[\da-f]{64}$/i.test(manifest.verifierCodeHash ?? '')
  || manifest.verifier.toLowerCase()!==PYTH_VERIFIER.toLowerCase())throw new Error('Invalid relay configuration');
 if(!config.statusToken || config.statusToken.length<32)throw new Error('Status authentication required');
 if(config.mode==='execute' && (manifest.equityAccessVerified!==true || !config.alertWebhook || !process.env.ORACLE_RELAY_PRIVATE_KEY))throw new Error('Execution requires alert delivery and dedicated signer');
 chain=new Chain(config);
 if(chain.account && [manifest.owner,manifest.keeper].filter(Boolean).some(a=>a.toLowerCase()===chain.account.address.toLowerCase()))throw new Error('Use a dedicated relay signer');
 store=new Store(config.dataDir,{kind:'oracle-relay',chainId:4663,relay:manifest.relay,account:chain.account?.address ?? null});store.acquireLease();
} catch {log('error','oracle_relay_configuration_failed');process.exit(1);}
const txs=new Transactions(chain,store,config), alerts=new Alerts(store,config);
const status={mode:config.mode,startedAt:Date.now(),lastCycle:0,lastPublication:null,markets:[],incidents:[],ready:false};
const read=(address,abi,functionName,args=[])=>chain.client.readContract({address,abi,functionName,args});
async function verifyTargets(){
 await chain.verifyDeployment();
 for(const [address,expected] of [[manifest.relay,manifest.relayCodeHash],[manifest.hub,manifest.hubCodeHash],[manifest.verifier,manifest.verifierCodeHash],...manifest.markets.map(m=>[m.adapter,m.adapterCodeHash])]){
  const code=await chain.client.getCode({address});if(!code||keccak256(code).toLowerCase()!==expected?.toLowerCase())throw new Error('Runtime mismatch');
 }
 if((await read(manifest.relay,relayAbi,'hub')).toLowerCase()!==manifest.hub.toLowerCase()
  || (await read(manifest.hub,hubAbi,'verifier')).toLowerCase()!==manifest.verifier.toLowerCase()
  || Number(await read(manifest.relay,relayAbi,'oracleCount'))!==manifest.markets.length)throw new Error('Oracle wiring mismatch');
 for(let i=0;i<manifest.markets.length;i++){
  const m=manifest.markets[i];const [address,id,collateral,primary,hub]=await Promise.all([
   read(manifest.relay,relayAbi,'oracles',[BigInt(i)]),read(m.adapter,adapterAbi,'feedId'),read(m.adapter,adapterAbi,'collateral'),
   read(m.adapter,adapterAbi,'primaryOracle'),read(m.adapter,adapterAbi,'pyth')]);
  if(address.toLowerCase()!==m.adapter.toLowerCase()||id!==m.feedId||collateral.toLowerCase()!==m.collateral.toLowerCase()
   ||primary.toLowerCase()!==m.primaryOracle.toLowerCase()||hub.toLowerCase()!==manifest.hub.toLowerCase())throw new Error('Market identity mismatch');
 }
}
let lastVerification=0,stopped=false,wake;
const server=createServer((req,res)=>{
 const live=Date.now()-status.lastCycle<60000;
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 if(req.url==='/health'){res.statusCode=live?200:503;res.end(publicJson({live,ready:status.ready}));return;}
 const actual=Buffer.from(req.headers.authorization ?? ''),expected=Buffer.from(`Bearer ${config.statusToken}`);
 if(req.url!=='/status'||actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.statusCode=401;res.end('{}');return;}
 res.end(publicJson({...status,live,alertDelivery:store.get('alertDelivery')}));
});server.listen(config.port,'::');
const lease=setInterval(()=>{try{store.renewLease();}catch{process.exit(1);}},10000);lease.unref();
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{stopped=true;wake?.();});
let lastCycleStarted=Date.now();
const stall=setInterval(()=>{if(Date.now()-lastCycleStarted>180000){log('error','oracle_relay_stalled');process.exit(1);}},10000);stall.unref();
while(!stopped){
 lastCycleStarted=Date.now();let incidents=[];
 try{
  if(config.alertWebhook && !store.get('transportVerified')) {
   const delivered=await alerts.deliver(incident('oracle_relay_online','info','Turret oracle relay alert transport check.'));
   if(delivered)store.set('transportVerified',true);
   else incidents.push(incident('alert_transport_unverified','critical','Oracle relay alert transport is unavailable.'));
  }
  const head=await chain.select();
  if(!chain.consistent)throw new Error('RPC disagreement');
  if(Date.now()-lastVerification>60000){await verifyTargets();lastVerification=Date.now();}
  incidents.push(...await txs.recover(head,true));
  const report=await requestPrices(process.env.PYTH_API_KEY,manifest.markets.map(m=>m.feedId));
  for(const feed of report.feeds)for(const problem of priceIssues(feed)){
   incidents.push(incident(`${problem}:${feed.id}`,problem==='market_closed'?'info':'critical',`Oracle ${feed.id}: ${problem}.`));
  }
  // Closed or carried-forward signed reports are also published: they invalidate cached good reports.
  if(!store.pendingTx()){
   const fee=await read(manifest.verifier,verifierAbi,'verification_fee');
   if(fee>parseEther('0.000000001'))throw new Error('Verification fee ceiling exceeded');
   await chain.client.simulateContract({address:manifest.relay,abi:relayAbi,functionName:'update',args:[report.signed],value:fee,account:chain.account ?? manifest.owner});
   if(config.mode==='execute')incidents.push(...await txs.submit('oracle_update',manifest.relay,encodeFunctionData({abi:relayAbi,functionName:'update',args:[report.signed]}),{},fee));
  }
  status.markets=await Promise.all(manifest.markets.map(async m=>{
   const result={symbol:m.symbol,feedId:m.feedId,liquidationReady:false,borrowingReady:false};
   for(const [borrowing,key] of [[false,'liquidationReady'],[true,'borrowingReady']]){
    try{await read(m.adapter,adapterAbi,'validatedPrice',[borrowing]);result[key]=true;}
    catch(error){result[`${key}Error`]=errorCode(error);}
   }
   if(!result.liquidationReady && result.liquidationReadyError!=='MarketClosed')incidents.push(incident(`oracle_unavailable:${m.feedId}`,'critical',`Validated oracle unavailable for ${m.symbol}.`,{error:result.liquidationReadyError}));
   return result;
  }));
  const confirmed=store.transactions().filter(t=>t.kind==='oracle_update'&&t.status==='confirmed').at(-1);
  status.lastPublication=confirmed?.receipt ?? null;
  status.lastCycle=Date.now();
 }catch(error){
  const code=errorCode(error);chain.recordFailure();status.ready=false;
  incidents.push(incident('oracle_cycle_failed','critical','Oracle relay failed; price-sensitive actions expire automatically.',{error:code}));
  log('error','oracle_cycle_failed',{error:code});
 }
 status.incidents=await alerts.update(incidents);
 status.ready=config.mode==='execute'&&Date.now()-status.lastCycle<60000&&status.markets.length===manifest.markets.length
  &&status.markets.every(m=>m.liquidationReady)&&status.incidents.every(i=>i.severity!=='critical')&&Boolean(store.get('transportVerified'))&&Boolean(store.get('alertDelivery')?.delivered);
 store.set('lastSnapshot',status);
 if(!stopped)await new Promise(resolve=>{const timer=setTimeout(resolve,10000);wake=()=>{clearTimeout(timer);resolve();};});
}
clearInterval(lease);clearInterval(stall);server.close();store.close();
