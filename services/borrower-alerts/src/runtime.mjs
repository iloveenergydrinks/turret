import { nftAlertsDeployment,bindNFTAlertsDeployment } from './nft-deployment.mjs';
import { NFTMonitor } from './nft-monitor.mjs';
import { Monitor } from './monitor.mjs';
import { alertsDeployment,bindDeployment } from './deployment.mjs';
import { isolatedAlertsDeployment,bindIsolatedAlertsDeployment } from './isolated-deployment.mjs';
import { IsolatedMonitor } from './isolated-monitor.mjs';
import { p2pAlertsDeployment,bindP2PAlertsDeployment } from './p2p-deployment.mjs';
import { P2PMonitor } from './p2p-monitor.mjs';

export function resolveAlertsDeployment(env=process.env) {
  const kind=env.ALERTS_PROTOCOL ?? 'stock';
  if (kind==='stock') return {kind,...alertsDeployment(env)};
  if (kind==='isolated') return isolatedAlertsDeployment(env);
  if (kind==='nft') return nftAlertsDeployment(env);
  if (kind==='p2p') return p2pAlertsDeployment(env);
  throw new Error('Unknown alerts protocol');
}
export function bindAlertsRuntime(store,deployment) {
  if (deployment.kind==='nft') return bindNFTAlertsDeployment(store,deployment);
  if (store.get('system','deployment')?.kind==='nft') throw new Error('Cannot reuse NFT alert consent for another protocol');
  if (deployment.kind==='p2p') return bindP2PAlertsDeployment(store,deployment);
  if (store.get('system','deployment')?.kind==='p2p') throw new Error('Cannot reuse P2P alert consent for pooled loans');
  if (deployment.kind==='isolated') return bindIsolatedAlertsDeployment(store,deployment);
  if (store.get('system','deployment')?.kind==='isolated') throw new Error('Cannot reassign isolated alert consent to stock protocol');
  bindDeployment(store,deployment);
}
export function createMonitor(engine,client,deployment) {
  if (deployment.kind==='nft') return new NFTMonitor(engine,client,deployment);
  if (deployment.kind==='p2p') return new P2PMonitor(engine,client,deployment);
  return deployment.kind==='isolated' ? new IsolatedMonitor(engine,client,deployment) : new Monitor(engine,client,deployment);
}
export function alertsLinks(origin,deployment) {
  if (deployment.kind==='nft') return {positionUrl:`${origin}/p2p/nfts`,verificationUrl:`${origin}/p2p/nfts?alerts=verify`};
  if (deployment.kind==='p2p') return {positionUrl:`${origin}/p2p`,verificationUrl:`${origin}/p2p?alerts=verify`};
  const query=deployment.kind==='isolated' ? `?engine=${deployment.vault}` : '';
  return {positionUrl:`${origin}/borrow${query}`,verificationUrl:`${origin}/alerts/verify${query}`};
}
export async function activateAlerts(engine,client,deployment,verification,channel,chat) {
  if (!['isolated','p2p','nft'].includes(deployment.kind)) return engine.activate(verification,channel,chat);
  // Record the latest mined block at consent, not the millisecond wall clock:
  // multiple later blocks may carry the same second-resolution timestamp.
  if (await client.getChainId()!==(deployment.chainId ?? 4663)) throw new Error('Wrong consent chain');
  const block=await client.getBlock();
  if (typeof block.number!=='bigint' || block.number<(['p2p','nft'].includes(deployment.kind)?0n:deployment.startBlock)
    || Math.abs(engine.now()-Number(block.timestamp)*1000)>60000) throw new Error('Invalid consent head');
  if (['p2p','nft'].includes(deployment.kind) && (await client.getBlock({blockNumber:block.number})).hash!==block.hash) throw new Error('P2P consent head changed');
  return engine.activate(verification,channel,chat,block.number);
}
