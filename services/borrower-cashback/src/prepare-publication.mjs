import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { CashbackLedger } from './ledger.mjs';
import { preparePublication } from './publication.mjs';

if (!process.env.CASHBACK_CONFIG) throw new Error('Set CASHBACK_CONFIG to the reviewed campaign configuration');
const config = JSON.parse(readFileSync(process.env.CASHBACK_CONFIG,'utf8'));
if (process.env.CASHBACK_RPC_URL) config.rpcUrl = process.env.CASHBACK_RPC_URL;
const directory = process.env.CASHBACK_DATA_DIR || './data';
const ledger = new CashbackLedger({path:join(directory,'ledger.sqlite'),policy:config.policy,startBlock:config.startBlock});
try {
  const client = createPublicClient({transport:http(config.rpcUrl,{timeout:15000,retryCount:1}),cacheTime:0});
  const result = await preparePublication({client,ledger,config,directory:join(directory,'allocations')});
  console.log(JSON.stringify({archive:result.path,operator:result.operator,chainId:result.chainId,
    transaction:result.transaction,root:result.allocation.root,accounts:result.allocation.claims.length},null,2));
} finally { ledger.close(); }
