import {pathToFileURL} from 'node:url';
import {runOracleService} from './isolated-main.mjs';
import {api3ConfigFromEnv} from './api3-config.mjs';
import {Api3UsdgTransactions} from './api3-transactions.mjs';
import {Api3UsdgWorker} from './api3-worker.mjs';

export async function main(env=process.env){
  return runOracleService(env,{manifestJson:'API3_ORACLE_MANIFEST_JSON',manifestPath:'API3_ORACLE_MANIFEST_PATH',
    parseConfig:api3ConfigFromEnv,TransactionsType:Api3UsdgTransactions,WorkerType:Api3UsdgWorker,prefix:'api3_usdg_oracle'});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
