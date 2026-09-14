import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isolatedConfigFromEnv} from './isolated-config.mjs';
import {IsolatedOracleWorker} from './isolated-worker.mjs';
import {IsolatedOracleTransactions} from './isolated-transactions.mjs';
import {Store,publicJson} from '../../liquidator/src/store.mjs';
import {Chain,log} from '../../liquidator/src/chain.mjs';
import {Alerts} from '../../liquidator/src/alerts.mjs';

export function isolatedHandler(worker,token) {
  return (req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const health=worker.health();
    if(req.method==='GET'&&req.url==='/health'){
      res.statusCode=health.live?200:503;res.end(publicJson(health));return;
    }
    if(req.method==='GET'&&req.url==='/ready'){
      res.statusCode=health.ready?200:503;res.end(publicJson(health));return;
    }
    const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);
    if(req.method!=='GET'||req.url!=='/status'||actual.length!==expected.length||!timingSafeEqual(actual,expected)){
      res.statusCode=401;res.end('{}');return;
    }
    res.end(publicJson({...worker.status,...health}));
  };
}

export async function main(env=process.env) {
  return runOracleService(env,{manifestJson:'ISOLATED_ORACLE_MANIFEST_JSON',manifestPath:'ISOLATED_ORACLE_MANIFEST_PATH',
    parseConfig:isolatedConfigFromEnv,TransactionsType:IsolatedOracleTransactions,WorkerType:IsolatedOracleWorker,prefix:'isolated_oracle'});
}

// Shared process lifecycle; providers supply fixed code/configuration adapters,
// never executable class names or module paths from environment variables.
export async function runOracleService(env,{manifestJson,manifestPath,parseConfig,TransactionsType,WorkerType,prefix}) {
  let store,server,lease,stall,wake,stopped=false,worker;
  const stop=()=>{stopped=true;wake?.();};
  try {
    const manifest=JSON.parse(env[manifestJson]??readFileSync(env[manifestPath],'utf8'));
    const config=parseConfig(env,manifest),chain=new Chain(config);
    if(chain.account&&chain.account.address.toLowerCase()!==config.relayAddress.toLowerCase())throw Error('Signer mismatch');
    // Watch-only account permits journal recovery without loading signing keys.
    if(!chain.account)chain.account={address:config.relayAddress};
    store=new Store(config.dataDir,config.identity);store.acquireLease();
    const txs=new TransactionsType(chain,store,config),alerts=new Alerts(store,config);
    worker=new WorkerType({chain,store,txs,alerts,config});
    server=createServer(isolatedHandler(worker,config.statusToken));
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'::',resolve);});
    let started=Date.now();
    lease=setInterval(()=>{try{store.renewLease();}catch{log('error',`${prefix}_lease_lost`);process.exit(1);}},10000);
    stall=setInterval(()=>{if(Date.now()-started>120000){log('error',`${prefix}_stalled`);process.exit(1);}},10000);
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,stop);
    while(!stopped){
      started=Date.now();
      await worker.cycle();
      if(!stopped)await new Promise(resolve=>{const timer=setTimeout(resolve,config.pollMs);wake=()=>{clearTimeout(timer);resolve();};});
    }
    return 0;
  }catch{log('error',`${prefix}_service_failed`);return 1;}
  finally{
    if(worker)worker.status.ready=false;
    clearInterval(lease);clearInterval(stall);
    for(const signal of ['SIGINT','SIGTERM'])process.off(signal,stop);
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    store?.close();
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
