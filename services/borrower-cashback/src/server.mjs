import { readFileSync } from 'node:fs';
import { startRuntime } from './runtime.mjs';

const config = process.env.CASHBACK_CONFIG ? JSON.parse(readFileSync(process.env.CASHBACK_CONFIG,'utf8')) : null;
if (config && process.env.CASHBACK_RPC_URL) config.rpcUrl = process.env.CASHBACK_RPC_URL;
const runtime = await startRuntime({ config, directory:process.env.CASHBACK_DATA_DIR || './data',
  port:Number(process.env.PORT || '3000'), pollMs:Number(process.env.CASHBACK_POLL_MS || '10000') });
console.log(`Borrower cashback service started (${config ? 'configured campaign' : 'inactive'})`);
let closing = false;
async function close() { if (closing) return; closing = true; await runtime.close(); }
process.on('SIGTERM',close); process.on('SIGINT',close);
