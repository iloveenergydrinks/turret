import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {keccak256,encodeFunctionData,parseAbi} from './deps.mjs';
import {guardAbi,primaryAbi,stockAbi,executionGateAbi} from './abi.mjs';
import {requestSnapshots} from './alpaca.mjs';
import {evaluateMarket,RecoveryTracker,makeProof} from './policy.mjs';
import {calendarStatus,nextSessionOpen,sessionAt} from './calendar.mjs';
import {sessionConfig,feedForSession} from './session-config.mjs';
import {keeperReady,keeperReadyForLiveness} from './keeper-health.mjs';
import {LivenessTracker,makeLivenessProof,combineBorrowProof} from './liveness.mjs';
import {configFromEnv} from '../../liquidator/src/config.mjs';
import {Chain,errorCode,log} from '../../liquidator/src/chain.mjs';
import {Store,publicJson} from '../../liquidator/src/store.mjs';
import {Transactions} from '../../liquidator/src/transactions.mjs';
import {Alerts,incident} from '../../liquidator/src/alerts.mjs';
import {stockPoolConfig,StockRiskChain,stockApproval} from './stock-pool.mjs';
import {makeStockProof} from './stock-policy.mjs';
import {acceptSharedTransportVerification} from '../../liquidator/src/transport-verification.mjs';
import {riskRuntimePolicy} from './runtime-policy.mjs';
import {publishCycle,RiskNotifications} from './publication.mjs';
import {ExtendedSessionAdmission,EXTENDED_LIMITS,verifyExtendedSale,interruptExtendedAdmission} from './extended-sessions.mjs';
import {startWeekendObserver} from './weekend-observer.mjs';
import {weekendHttpResponse} from './weekend-http.mjs';

const env=process.env;
const parseStockQuoteAbi=parseAbi(['function quoteWithChecks(address wallet,bytes health,bytes liveness) returns(uint256,uint256,uint256,uint256,uint256)']);
let manifest,config,chain,store,trading,runtime,startupStage='manifest';
try {
 manifest=JSON.parse(env.RISK_MANIFEST_JSON ?? readFileSync(env.RISK_MANIFEST_PATH));
 startupStage='runtime_policy';
 runtime=riskRuntimePolicy(env,Boolean(manifest.executionGate));
 startupStage='base_config';
 const mappedEnv={...env,KEEPER_MODE:env.RISK_MODE ?? 'observe',KEEPER_PRIVATE_KEY:env.RISK_GUARDIAN_PRIVATE_KEY,
  KEEPER_VAULT_ADDRESS:manifest.vault,KEEPER_START_BLOCK:String(manifest.startBlock ?? 1),KEEPER_VAULT_CODE_HASH:manifest.vaultCodeHash,
  KEEPER_EXECUTION_GATE:manifest.executionGate,KEEPER_LIVENESS_URL:manifest.executionGate?env.RISK_LIVENESS_URL:undefined,
  KEEPER_DATA_DIR:env.RISK_DATA_DIR ?? './data/risk',KEEPER_STATUS_TOKEN:env.RISK_STATUS_TOKEN,
  KEEPER_ALERT_WEBHOOK_URL:env.RISK_ALERT_WEBHOOK_URL,KEEPER_NATIVE_WATCHDOG:'false',KEEPER_CONFIRMATIONS:'2'};
 config=manifest.kind==='stock-pool'?stockPoolConfig(manifest,mappedEnv):configFromEnv(mappedEnv);
 startupStage='trading_config';
 trading=sessionConfig(manifest,config.mode,env.ALPACA_DATA_FEED??'iex');
 startupStage='deployment_config';
 if(manifest.chainId!==4663||!['chainlink-guarded-pilot','stock-pool'].includes(manifest.kind)||!manifest.markets?.length||manifest.markets.length>10
  || !config.statusToken||config.statusToken.length<32||!env.RISK_APP_ORIGIN)throw new Error();
 if(config.mode==='execute'&&(manifest.status!=='receipt-verified'||manifest.marketDataVerified!==true||!env.ALPACA_API_KEY||!env.ALPACA_API_SECRET
  ||!env.RISK_KEEPER_STATUS_URL||!env.RISK_KEEPER_STATUS_TOKEN
  ||(!config.alertWebhook&&!(env.RESEND_API_KEY&&env.RISK_ALERT_EMAIL_FROM&&env.RISK_ALERT_EMAIL_TO))))throw new Error();
 chain=manifest.kind==='stock-pool'?new StockRiskChain(config):new Chain(config);
 startupStage='role_config';
 if(chain.account&&([manifest.owner,manifest.keeper].some(a=>a?.toLowerCase()===chain.account.address.toLowerCase())
  ||chain.account.address.toLowerCase()!==manifest.guardian.toLowerCase()))throw new Error();
 if(env.RISK_LIVENESS_MODE&&!['observe','execute'].includes(env.RISK_LIVENESS_MODE))throw new Error();
 if((env.RISK_LIVENESS_MODE==='execute'||(manifest.executionGate&&config.mode==='execute'))&&(!manifest.executionGate||!manifest.executionGateCodeHash
   ||manifest.status!=='receipt-verified'||!chain.account||config.rpcUrls.length<runtime.requiredHealthyProviders))throw new Error();
 store=new Store(config.dataDir,{role:'risk-monitor',vault:manifest.vault,guardian:manifest.guardian,chainId:4663,
  ...(manifest.kind==='stock-pool'?{kind:manifest.kind,pool:manifest.pool}:{} )});
 startupStage='lease';
 const leaseDeadline=Date.now()+150_000;
 let waitingLogged=false;
 while(true){
  try{store.acquireLease();break;}
  catch(error){
   if(error?.message!=='Another keeper owns this volume'||Date.now()>=leaseDeadline)throw error;
   if(!waitingLogged){log('info','risk_waiting_for_previous_lease');waitingLogged=true;}
   await new Promise(resolve=>setTimeout(resolve,5_000));
  }
 }
}catch(error){log('error','risk_configuration_invalid',{stage:startupStage,code:errorCode(error)});process.exit(1);}

// Operator-only alerts. Market-data prices and credentials are never sent or logged.
class RiskAlerts extends Alerts {
 async deliver(event){
  if(config.alertWebhook)return super.deliver(event);
  log(event.severity==='critical'?'error':'warn','risk_alert',{code:event.code,message:event.message});
  if(!env.RESEND_API_KEY||!env.RISK_ALERT_EMAIL_FROM||!env.RISK_ALERT_EMAIL_TO)return false;
  try{
   const response=await fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:env.RISK_ALERT_EMAIL_FROM,to:[env.RISK_ALERT_EMAIL_TO],subject:`[Turret ops] Risk monitor: ${event.code}`,text:event.message})});
   return response.ok;
  }catch{return false;}
 }
}
const alertsConfig={...config,alertEmail:env.RESEND_API_KEY&&env.RISK_ALERT_EMAIL_FROM&&env.RISK_ALERT_EMAIL_TO?
 {apiKey:env.RESEND_API_KEY,from:env.RISK_ALERT_EMAIL_FROM,to:env.RISK_ALERT_EMAIL_TO}:undefined};
const alerts=new RiskAlerts(store,alertsConfig),txs=new Transactions(chain,store,config),recovery=new RecoveryTracker();
acceptSharedTransportVerification(store,env.KEEPER_ALERT_TRANSPORT_PREVERIFIED_AT,
 Boolean(config.alertWebhook||env.RESEND_API_KEY&&env.RISK_ALERT_EMAIL_FROM&&env.RISK_ALERT_EMAIL_TO));
const notifications=new RiskNotifications(alerts,store,{
 verifyTransport:()=>alerts.deliver(incident('risk_monitor_transport_check','info','Turret risk monitor operator alert check.')),
 onError:()=>log('error','risk_notification_update_failed'),
});
const status={vault:manifest.vault,guardian:manifest.guardian,codeHash:manifest.vaultCodeHash,revision:manifest.revision??'five-minute-v1',softwareRevision:'stock-extended-multimarket-v6',mode:config.mode,lastCycle:0,ready:false,markets:[],incidents:[],lastError:null};
const approvals=new Map();
const extendedAdmission=trading.continuous?new ExtendedSessionAdmission(trading.continuous):null;
const livenessTracker=new LivenessTracker();
const livenessEnabled=Boolean(manifest.executionGate)&&(env.RISK_LIVENESS_MODE??config.mode)==='execute';
let publishedLiveness;
const read=(address,abi,functionName,args=[],blockNumber)=>chain.client.readContract({address,abi,functionName,args,blockNumber});
async function verifyTargets(blockNumber){
 await chain.verifyDeployment(blockNumber);
 if(manifest.kind==='stock-pool')return;
 if((await chain.read('owner',[],blockNumber)).toLowerCase()!==manifest.owner.toLowerCase())throw new Error('OwnerMismatch');
 if(manifest.executionGate){
  const [code,guardian,age,delay,gate]=await Promise.all([
   chain.client.getCode({address:manifest.executionGate,blockNumber}),read(manifest.executionGate,executionGateAbi,'guardian',[],blockNumber),
   read(manifest.executionGate,executionGateAbi,'MAX_LIFETIME',[],blockNumber),read(manifest.executionGate,executionGateAbi,'RECOVERY_DELAY',[],blockNumber),chain.read('executionGate',[],blockNumber)]);
  if(!code||keccak256(code).toLowerCase()!==manifest.executionGateCodeHash.toLowerCase()||guardian.toLowerCase()!==manifest.guardian.toLowerCase()
   ||gate.toLowerCase()!==manifest.executionGate.toLowerCase()||age!==45n||delay!==120n)throw new Error('ExecutionGateMismatch');
 }
 for(const m of manifest.markets){
  const [code,collateral,primary,guardian,market,maxAge]=await Promise.all([
   chain.client.getCode({address:m.adapter,blockNumber}),read(m.adapter,guardAbi,'collateral',[],blockNumber),
   read(m.adapter,guardAbi,'primaryOracle',[],blockNumber),read(m.adapter,guardAbi,'guardian',[],blockNumber),chain.read('markets',[m.collateral],blockNumber),read(m.adapter,guardAbi,'MAX_PRICE_AGE',[],blockNumber)]);
  if(!code||keccak256(code).toLowerCase()!==m.adapterCodeHash.toLowerCase()||collateral.toLowerCase()!==m.collateral.toLowerCase()
   ||primary.toLowerCase()!==m.primaryOracle.toLowerCase()||guardian.toLowerCase()!==manifest.guardian.toLowerCase()
   ||market[0].toLowerCase()!==m.primaryOracle.toLowerCase()||market[1].toLowerCase()!==m.adapter.toLowerCase()
   ||market[2]>50000000n||market[3]>3000||market[4]>4000
   ||maxAge!==BigInt(m.maxPriceAgeSeconds??300))throw new Error('MarketWiringMismatch');
 }
}
const origin=new URL(env.RISK_APP_ORIGIN).origin;
const weekendObserver=startWeekendObserver({manifest,rpcUrls:config.rpcUrls,dataDir:config.dataDir});
const server=createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.headers.origin===origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 else if(req.headers.origin){res.writeHead(403);res.end('{}');return;}
 if(req.method!=='GET'){res.writeHead(405);res.end('{}');return;}
 const now=Math.floor(Date.now()/1000),live=Date.now()-status.lastCycle<60000;
 const path=new URL(req.url,'http://localhost').pathname;
 const weekendResponse=weekendHttpResponse(path,req.headers.authorization,config.statusToken,weekendObserver);
 if(weekendResponse){res.writeHead(weekendResponse.status);res.end(publicJson(weekendResponse.body));return;}
 if(path==='/healthz'){res.writeHead(live?200:503);res.end(publicJson({live,ready:status.ready&&live}));return;}
 if(path==='/liveness'){
  if(!live||!publishedLiveness||publishedLiveness.validUntil-now<10){res.writeHead(503);res.end('{"error":"Execution liveness unavailable"}');return;}
  res.end(publicJson({chainId:4663,vault:manifest.vault,executionGate:manifest.executionGate,...publishedLiveness}));return;
 }
 const match=(manifest.kind==='stock-pool'?/^\/stock\/approvals\/(0x[\da-fA-F]{40})$/:/^\/approvals\/(0x[\da-fA-F]{40})$/).exec(path);
 if(match){
  const p=approvals.get(match[1].toLowerCase());
  if(!live||!p||p.validUntil-now<10){
   const marketClosed=live&&!status.lastError&&status.trading?.open===false&&status.trading?.reason==='market_closed';
   const qualifying=live&&status.admission?.code==='session_qualifying';
   res.writeHead(503);res.end(publicJson({error:'Borrowing temporarily unavailable',code:marketClosed?'market_closed':qualifying?'session_qualifying':'temporarily_unavailable',
    ...(qualifying?{eligibleAt:status.admission.eligibleAt}:{}),
    ...(marketClosed&&Number.isSafeInteger(status.trading.reopensAt)?{reopensAt:status.trading.reopensAt}:{})}));return;
  }
  res.end(publicJson(manifest.kind==='stock-pool'?p:{chainId:4663,vault:manifest.vault,...p}));return;
 }
 const actual=Buffer.from(req.headers.authorization ?? ''),expected=Buffer.from(`Bearer ${config.statusToken}`);
 if(path!=='/status'||actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(401);res.end('{}');return;}
 res.end(publicJson({...status,live,alertDelivery:store.get('alertDelivery')}));
});server.listen(config.port,'::');
let stopped=false,wake,lastStarted=Date.now(),lastVerified=0;
const lease=setInterval(()=>{try{store.renewLease();if(Date.now()-lastStarted>180000)process.exit(1);}catch{process.exit(1);}},10000);lease.unref();
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopped=true;approvals.clear();publishedLiveness=undefined;wake?.();});
while(!stopped){
 // Published certificates retain their original short expiry during a refresh.
 // Clearing before asynchronous reads caused healthy callers to see HTTP 503
 // for seconds every cycle. Known faults still invalidate publication below.
 lastStarted=Date.now();let incidents=[],candidates=[],livenessCandidate,keeperStatus;
 try{
  // Verification and delivery run outside the observation loop. Admission
  // remains closed until verification succeeds, while liquidation stays live.
  if(!store.get('transportVerified'))incidents.push(incident('risk_alert_unavailable','critical','Operator alerts are unavailable. Borrowing approvals are withheld.'));
  const head=await chain.select(),now=Number(head.timestamp);
  status.rpc={consistent:chain.consistent,active:chain.active.name,providers:chain.probeStatus};
  if(!chain.consistent)throw new Error('RPCDisagreement');
  if(Date.now()-lastVerified>runtime.deploymentVerifyIntervalMs){await verifyTargets(head.number);lastVerified=Date.now();}
  if(manifest.executionGate){
   const [epoch,recoveryAt]=await Promise.all([read(manifest.executionGate,executionGateAbi,'epoch',[],head.number),read(manifest.executionGate,executionGateAbi,'recoveryAt',[],head.number)]);
   const result=livenessTracker.observe(head,Math.floor(Date.now()/1000),{consistent:chain.consistent,healthyProviders:chain.probeStatus.filter(p=>!p.error).length,requiredHealthyProviders:runtime.requiredHealthyProviders,recoveryAt});
   status.liveness={...result,gate:manifest.executionGate,mode:livenessEnabled?'execute':'observe',requiredHealthyProviders:runtime.requiredHealthyProviders};
   if(result.ok&&livenessEnabled)livenessCandidate=await makeLivenessProof(chain.account,manifest.executionGate,result,epoch);
   if(!result.ok){publishedLiveness=undefined;approvals.clear();}
   if(!result.ok)incidents.push(incident('risk_liveness_unavailable','critical','Chain liveness is unavailable or recovering. Execution proofs are withheld.'));
  }
  incidents.push(...await txs.recover(head,config.mode==='execute'));
  const balance=chain.account?await chain.client.getBalance({address:chain.account.address,blockNumber:head.number}):0n;
  if(config.mode==='execute'&&balance<config.minEth)incidents.push(incident('risk_gas_low','critical','The risk guardian needs ETH for emergency quarantine transactions.'));
  if(config.mode==='execute'){
   try{
    const response=await fetch(env.RISK_KEEPER_STATUS_URL,{headers:{Authorization:`Bearer ${env.RISK_KEEPER_STATUS_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error();const keeper=await response.json();
    if(!(manifest.executionGate?keeperReadyForLiveness(keeper,manifest):keeperReady(keeper,manifest)))throw new Error();
    keeperStatus=keeper;
   }catch{approvals.clear();incidents.push(incident('risk_keeper_unavailable','critical','The funded liquidation keeper is not ready for this vault. Borrowing approvals are withheld.'));}
  }
  const session=sessionAt(now,trading.policy),sourceFeed=feedForSession(session,trading);
  const extended=Boolean(extendedAdmission&&session.open&&session.kind!=='regular');
  status.admission=extended?{ready:false,code:'checks_unavailable'}:null;
  if(!extended)extendedAdmission?.reset();
  status.calendar=calendarStatus(now);
  if(status.calendar.expired||session.reason==='calendar_expired') {
   incidents.push(incident('risk_calendar_expired','critical','The reviewed trading calendar has expired. Borrowing approvals are withheld.'));
  }else if(status.calendar.expiring){
   incidents.push(incident('risk_calendar_expiring','warning','The reviewed trading calendar expires within 90 days. Review and deploy the next published schedule.'));
  }
  status.trading={policy:trading.policy,open:session.open,reason:session.reason??null,session:session.kind??'closed',tradeDate:session.tradeDate??null,
   sessionOpen:session.sessionOpen??null,sessionClose:session.sessionClose??null,
   reopensAt:session.open?null:nextSessionOpen(now,trading.policy),sourceFeed};
  let snapshots={},dataError;
  if(session.open){try{snapshots=await requestSnapshots({key:env.ALPACA_API_KEY,secret:env.ALPACA_API_SECRET,feed:sourceFeed,recentExecutions:extended,
   corroborationWindowSeconds:extended?trading.continuous.corroborationWindowSeconds??30:30},manifest.markets.map(m=>m.symbol));}catch(error){dataError=errorCode(error);}}
  status.markets=[];
  for(const m of manifest.markets){
   let result,guardState;
   try{
    const [round,decimals,multiplier,effectiveAt,tokenPaused,epoch,recoveryAt,quarantined,cached]=await Promise.all([
     read(m.primaryOracle,primaryAbi,'latestRoundData',[],head.number),read(m.primaryOracle,primaryAbi,'decimals',[],head.number),
     read(m.collateral,stockAbi,'uiMultiplier',[],head.number),read(m.collateral,stockAbi,'effectiveAt',[],head.number),read(m.collateral,stockAbi,'oraclePaused',[],head.number),
     read(m.adapter,guardAbi,'epoch',[],head.number),read(m.adapter,guardAbi,'recoveryAt',[],head.number),read(m.adapter,guardAbi,'liquidationQuarantined',[],head.number),read(m.adapter,guardAbi,'health',[],head.number)]);
    if(decimals>18)throw new Error('InvalidPrimaryDecimals');
    guardState={epoch,recoveryAt,quarantined,cached};
    result=dataError?{ok:false,code:dataError}:evaluateMarket({snapshot:snapshots[m.symbol],primary:[round[0],round[1]*10n**BigInt(18-decimals),...round.slice(2)],multiplier,effectiveAt,tokenPaused,maxPriceAgeSeconds:m.maxPriceAgeSeconds??300,sessionPolicy:trading.policy,sourceFeed,
     ...(extended?{admissionLimits:EXTENDED_LIMITS}:{})},now,Math.floor(Date.now()/1000));
    guardState.primaryAgeSeconds=now-Number(round[3]);
   }catch(error){result={ok:false,code:errorCode(error)};}
   const recovered=recovery.observe(m.collateral,result,now);
   if(extended){
    const operational=Boolean(keeperStatus&&livenessCandidate&&guardState&&!guardState.quarantined
     &&now>=Number(guardState.recoveryAt)&&store.get('transportVerified')&&!store.pendingTx()
     &&!incidents.some(i=>i.severity==='critical'));
    const interruption=interruptExtendedAdmission(extendedAdmission,{result,recovered,operational,now,
     sessionKey:`${session.tradeDate}:${session.kind}:${sourceFeed}`});
    if(interruption)status.admission=interruption;
   }
   if(!result.ok)approvals.delete((manifest.kind==='stock-pool'?manifest.vault:m.collateral).toLowerCase());
   const publicMarket={symbol:m.symbol,collateral:m.collateral,ok:result.ok,recovered,code:result.ok?(recovered?'healthy':'recovering'):result.code,
    primaryAgeSeconds:guardState?.primaryAgeSeconds,maxPriceAgeSeconds:m.maxPriceAgeSeconds??300,session:session.kind??'closed',sourceFeed};
   // Bounded, price-free evidence of real in-session observations. It never grants admission itself.
   const key=`observations:${m.collateral.toLowerCase()}`,previous=store.get(key)??{};
   const sample={...previous,lastCheckedAt:now,lastCode:publicMarket.code};
   if(session.open){
    const sessionKey=`${trading.policy}:${session.tradeDate}:${session.kind}:${sourceFeed}`;
    if(previous.sessionKey!==sessionKey){delete sample.lastHealthyAt;delete sample.lastRecoveredAt;}
    sample.sessionKey=sessionKey;sample.sessionOpen=session.sessionOpen;sample.checks=(previous.sessionKey===sessionKey?previous.checks??0:0)+1;
    sample.passed=(previous.sessionKey===sessionKey?previous.passed??0:0)+(result.ok?1:0);
    if(result.ok)sample.lastHealthyAt=now;if(recovered)sample.lastRecoveredAt=now;}
   store.set(key,sample);publicMarket.observations=sample;
   status.markets.push(publicMarket);
   if(!result.ok&&result.code!=='market_closed')incidents.push(incident(`risk_${m.symbol}_${result.code}`,'critical',`${m.symbol}: ${result.code}. Borrowing approvals withheld.`));
   if(config.mode==='execute'&&guardState&&!store.pendingTx()){
    // Price disagreement must be quarantined even when no recent borrowing approval exists.
    const needsTrip=result.unsafePrice?!guardState.quarantined:!result.ok&&Number(guardState.cached[2])>now;
    if(needsTrip){
     const data=encodeFunctionData({abi:guardAbi,functionName:'trip',args:[Boolean(result.unsafePrice)]});
     incidents.push(...await txs.submit('risk_trip',m.adapter,data,{collateral:m.collateral}));
    }
   }
   if(config.mode==='execute'&&recovered&&guardState&&now>=Number(guardState.recoveryAt)&&(!manifest.executionGate||livenessCandidate)){
    try{
     // A price-quarantine recovery may happen while this pool's keeper is not
     // admitted. Never put an engine admission signature in its public calldata.
     // A fresh signed proof can clear a prior quarantine only after recovery. Never infer receipt success.
     if(guardState.quarantined&&!store.pendingTx()){
      const proof=await makeProof(chain.account,m.adapter,result,guardState,now);
      incidents.push(...await txs.submit('risk_recovery',m.adapter,encodeFunctionData({abi:guardAbi,functionName:'submitHealth',args:[proof.encoded]}),{collateral:m.collateral}));
     }
     if(!guardState.quarantined){
      if(manifest.kind==='stock-pool'){
       if(extended){
        const healthy=Boolean(keeperStatus&&livenessCandidate&&store.get('transportVerified')
         &&!incidents.some(i=>i.severity==='critical'));
        if(!healthy){extendedAdmission.reset();continue;}
        try{
         const sale=await verifyExtendedSale({chain,manifest,config:trading.continuous,head,
          liveness:livenessCandidate.encoded,keeper:keeperStatus});
         const admission=extendedAdmission.observe({sessionKey:result.sessionKey,ok:true,now});
         status.admission={...admission,session:session.kind,sourceFeed,sale};
         publicMarket.admission=status.admission;
         if(!admission.ready){publicMarket.code='session_qualifying';approvals.delete(manifest.vault.toLowerCase());continue;}
         result.admissionValidUntil=sale.validUntil;
         store.set(`extendedQualification:${session.tradeDate}:${session.kind}`,{...admission,sourceFeed,block:sale.block});
        }catch(error){
         extendedAdmission.reset();approvals.delete(manifest.vault.toLowerCase());
         publicMarket.code='extended_sale_unavailable';status.admission={ready:false,code:errorCode(error)};
         incidents.push(incident(`risk_${m.symbol}_extended_sale_unavailable`,'critical',`${m.symbol}: extended-session collateral sale checks failed. Borrowing approvals withheld.`));
         continue;
        }
       }
       const marketProof=await makeStockProof(chain.account,manifest.vault,m.adapter,result,guardState,now);
       // Verify USDG sources and every onchain borrowing check with the same
       // signed certificates before exposing them to borrowers or lenders.
       await chain.client.simulateContract({address:manifest.vault,abi:parseStockQuoteAbi,functionName:'quoteWithChecks',
        args:[manifest.owner,marketProof.encoded,livenessCandidate.encoded],blockNumber:head.number});
       candidates.push([manifest.vault.toLowerCase(),stockApproval(manifest,marketProof,livenessCandidate)]);
      }else{
       const proof=await makeProof(chain.account,m.adapter,result,guardState,now);
       candidates.push([m.collateral.toLowerCase(),{...(manifest.executionGate?combineBorrowProof(proof,livenessCandidate):proof),adapter:m.adapter,collateral:m.collateral}]);
      }
     }
    }catch{approvals.delete((manifest.kind==='stock-pool'?manifest.vault:m.collateral).toLowerCase());publicMarket.code='approval_unavailable';incidents.push(incident(`risk_${m.symbol}_approval_unavailable`,'critical',`${m.symbol}: a borrowing approval could not be issued.`));}
   }
  }
  status.lastError=null;
 }catch(error){
  approvals.clear();
  extendedAdmission?.reset();status.admission=null;
  const code=errorCode(error);status.lastError=code;chain.recordFailure();
  status.rpc={consistent:chain.consistent,active:chain.active.name,providers:chain.probeStatus??[]};
  livenessTracker.reset();livenessCandidate=undefined;publishedLiveness=undefined;
  for(const m of manifest.markets)recovery.reset(m.collateral);
  incidents.push(incident('risk_cycle_failed','critical','The risk monitor could not complete validation. Borrowing approvals are withheld.',{error:code}));
 }
 if(incidents.some(i=>!/^risk_[A-Z]+_/.test(i.code)&&i.severity==='critical'))approvals.clear();
 const currentSession=sessionAt(Math.floor(Date.now()/1000),trading.policy);
 publishCycle({status,notifications,incidents,candidates,livenessCandidate,approvals,isStopped:()=>stopped,
  setLiveness:value=>{publishedLiveness=value;},session:currentSession,mode:config.mode});
 status.lastCycle=Date.now();store.set('lastSnapshot',status);
 if(!stopped)await new Promise(resolve=>{const t=setTimeout(resolve,runtime.pollMs);wake=()=>{clearTimeout(t);resolve();};});
}
server.close();await weekendObserver.close();await notifications.close();clearInterval(lease);store.close();
