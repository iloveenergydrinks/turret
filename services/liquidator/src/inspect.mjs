import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv } from './config.mjs';
import { Chain,errorCode } from './chain.mjs';
import { Store,publicJson } from './store.mjs';
import { Transactions } from './transactions.mjs';
import { Engine } from './engine.mjs';

// Always read-only, regardless of the service environment it is run with.
const config=configFromEnv({...process.env,NODE_ENV:'test',KEEPER_MODE:'observe',KEEPER_PRIVATE_KEY:undefined,KEEPER_BACKFILL_CHUNKS:'200'});
const directory=mkdtempSync(join(tmpdir(),'dockyard-inspect-'));
const store=new Store(directory,{chainId:config.chainId,vault:config.vault});store.acquireLease();
const leaseTimer=setInterval(()=>store.renewLease(),10000);
try {
  const chain=new Chain(config),engine=new Engine(chain,store,config,new Transactions(chain,store,config));
  const snapshot=await engine.cycle();
  console.log(publicJson({...snapshot,incidents:snapshot.incidents.map(x=>({code:x.code,severity:x.severity}))}));
} catch(error){console.log(publicJson({error:errorCode(error)}));process.exitCode=1;}
finally{clearInterval(leaseTimer);store.close();rmSync(directory,{recursive:true,force:true});}
