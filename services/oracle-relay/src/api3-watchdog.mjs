import {pathToFileURL} from 'node:url';
import {watchdogConfig,checkIsolatedOracle,runOracleWatchdog} from './isolated-watchdog.mjs';

export function api3WatchdogConfig(env){
  return {...watchdogConfig({ISOLATED_ORACLE_STATUS_URL:env.API3_ORACLE_STATUS_URL,
    ISOLATED_ORACLE_EXPECTED_IDENTITY_HASH:env.API3_ORACLE_EXPECTED_IDENTITY_HASH,
    ORACLE_STATUS_TOKEN:env.ORACLE_STATUS_TOKEN,WATCHDOG_ALERT_WEBHOOK_URL:env.WATCHDOG_ALERT_WEBHOOK_URL,
    ORACLE_WATCHDOG_DATA_DIR:env.ORACLE_WATCHDOG_DATA_DIR??'./data/api3-oracle-watchdog'}),expectedKind:'stock-api3-usdg'};
}

export async function checkApi3Oracle(args){
  return checkIsolatedOracle({...args,config:{...args.config,expectedKind:'stock-api3-usdg'}});
}

export async function main(env=process.env){
  return runOracleWatchdog(env,{parseConfig:api3WatchdogConfig,check:checkApi3Oracle,
    kind:'api3-oracle-watchdog',prefix:'api3_oracle',transportMessage:'Independent stock USDG oracle watchdog notification transport check.'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
