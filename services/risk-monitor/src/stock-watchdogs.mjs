import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {stockWatchdogTargets,targetEnvironment} from './stock-watchdog-targets.mjs';

// One independent scheduled job; keep each watchdog's lease and deduplication
// journal separate. No signing keys or transaction execution in this process.
const root=process.env.STOCK_WATCHDOG_DATA_DIR??'/data';
const targets=stockWatchdogTargets(process.env.STOCK_WATCHDOG_TARGETS_JSON,process.env);
const roles=[['../../liquidator/src/watchdog.mjs','KEEPER_DATA_DIR','keeper'],['./watchdog.mjs','RISK_DATA_DIR','risk']];
const jobs=targets.flatMap(target=>roles.map(role=>[target,...role]));
const outcomes=await Promise.all(jobs.map(([target,file,key,name])=>new Promise(resolve=>{
  const directory=join(root,target.symbol,name);mkdirSync(directory,{recursive:true});
  const child=spawn(process.execPath,[new URL(file,import.meta.url).pathname],{
    env:{...process.env,...targetEnvironment(target,name),[key]:directory},stdio:'inherit',timeout:45000,
  });
  child.once('error',()=>resolve(1));
  child.once('exit',code=>resolve(code===0?0:1));
})));
process.exitCode=outcomes.some(Boolean)?1:0;
