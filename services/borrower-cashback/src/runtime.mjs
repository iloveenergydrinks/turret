import { createRewardsServer } from './http.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, http } from 'viem';
import { CashbackLedger } from './ledger.mjs';
import { syncLedger } from './chain.mjs';
import { verifyRuntimeConfig } from './config.mjs';
import { readAllocations } from './archive.mjs';

export async function startRuntime({ config = null, port = 3000, host = '0.0.0.0', directory = './data', pollMs = 10000 } = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new Error('Invalid polling interval');
  let client, ledger, timer, work, stopped = false;
  const allocations = [];
  const state = { error:null, replaying:!!config, lastSyncedAt:null };
  if (config) {
    const url = new URL(config.rpcUrl);
    if (!['http:','https:'].includes(url.protocol)) throw new Error('Invalid configured RPC URL');
    client = createPublicClient({transport:http(url.href,{timeout:15000,retryCount:1}),cacheTime:0});
    await verifyRuntimeConfig(client,config);
    mkdirSync(directory,{recursive:true,mode:0o700});
    ledger = new CashbackLedger({path:join(directory,'ledger.sqlite'),policy:config.policy,startBlock:config.startBlock});
    try { allocations.push(...readAllocations(join(directory,'allocations'))); }
    catch (error) { ledger.close(); throw error; }
  }
  const server = createRewardsServer({ config,client,ledger,allocations, health:() => ({
    ready:!state.error && !state.replaying, active:!!config, replaying:state.replaying,
    lastSyncedAt:state.lastSyncedAt, error:state.error ? 'indexing_unavailable' : null,
  }) });
  try {
    await new Promise((resolve,reject) => {
      const failed = error => reject(error);
      server.once('error',failed);
      server.listen(port,host,() => {server.off('error',failed);resolve();});
    });
  } catch (error) { ledger?.close(); throw error; }
  const sync = () => {
    if (!config || stopped) return Promise.resolve();
    if (work) return work;
    work = (async () => {
      try {
        const result = await syncLedger({client,ledger,startBlock:config.startBlock,campaign:config.distributor,
          engines:Object.keys(config.policy.engines),confirmations:config.confirmations,historicalRange:config.historicalRange ?? 0});
        const loaded = readAllocations(join(directory,'allocations'));
        allocations.splice(0,allocations.length,...loaded);
        state.error = null; state.replaying = result.more; state.lastSyncedAt = Date.now();
        return result;
      } catch (error) { state.error = error.message; throw error; }
      finally { work = null; }
    })();
    return work;
  };
  const poll = async () => {
    let more = false;
    try { more = (await sync())?.more ?? false; } catch { /* API fails closed on stale/noncanonical data. */ }
    if (!stopped) timer = setTimeout(poll, more ? 10 : pollMs);
  };
  if (config) timer = setTimeout(poll,0);
  return { url:`http://${host}:${server.address().port}`, sync, status:() => ({...state,head:ledger?.head() ?? null}),
    close:async () => {
      stopped = true; clearTimeout(timer);
      if (work) await work.catch(()=>{});
      await new Promise(resolve => server.close(resolve)); ledger?.close();
    } };
}
