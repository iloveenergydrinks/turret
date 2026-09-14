import type { Hex } from "viem";
import type { Deployment } from "./client";
import { inspectP2PHealth, validateTokenBaseline, type HealthClient, type P2PHealth, type TokenBaseline } from "./health-core.mjs";
export type { P2PHealth } from "./health-core.mjs";
const baselines = new Map<number, {loadedAt: number; pending: Promise<TokenBaseline>}>();
async function loadBaseline(chainId: number) {
  let entry = baselines.get(chainId);
  if (!entry || Date.now() - entry.loadedAt > 60_000) {
    const pending = fetch("/p2p-token-baseline.json", { cache: "no-store", signal: AbortSignal.timeout(10_000) }).then(async response => {
      if (!response.ok) throw new Error("Baseline unavailable");
      return validateTokenBaseline(await response.json(), chainId);
    }).catch(error => { if (baselines.get(chainId)?.pending === pending) baselines.delete(chainId); throw error; });
    entry = {loadedAt: Date.now(), pending};
    baselines.set(chainId, entry);
  }
  return entry.pending;
}
export async function readP2PHealth(client: HealthClient, market: Deployment, block: {number: bigint; hash: Hex; timestamp: bigint}, offerId?: bigint): Promise<P2PHealth> {
  try {
    const baseline = await loadBaseline(market.chainId);
    // Local E2E explicitly advances the chain clock; production always checks wall-clock freshness.
    return await inspectP2PHealth(client, market, baseline, block, market.chainId === 31337 ? Number(block.timestamp) * 1000 : Date.now(), offerId);
  } catch {
    return { status: "unavailable", reasons: ["Current token and escrow checks could not be verified. Refresh before creating or accepting a loan."], blockNumber: String(block.number), blockHash: block.hash, checkedAt: Date.now() };
  }
}
