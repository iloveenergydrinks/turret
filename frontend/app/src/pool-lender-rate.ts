import { keccak256, type PublicClient } from "viem";
import { ISOLATED_USDG, isolatedPoolAbi, type IsolatedDeployment } from "./isolated-credit";

export function poolUtilizationBps(principal: bigint, totalAssets: bigint): bigint {
  if (principal < 0n || totalAssets < 0n || (principal > 0n && totalAssets === 0n)) throw new Error("Invalid pool accounting");
  if (totalAssets === 0n) return 0n;
  const utilization = principal * 10000n / totalAssets;
  return utilization > 10000n ? 10000n : utilization;
}
export function estimatedLenderAprBps(aprBps: number, feeBps: number, utilizationBps: bigint): bigint {
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > 10000
    || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 2000
    || utilizationBps < 0n || utilizationBps > 10000n) throw new Error("Invalid pool rates");
  return BigInt(aprBps) * utilizationBps * BigInt(10000 - feeBps) / 100000000n;
}
export const formatRateBps = (bps: bigint) => `${bps / 100n}.${(bps % 100n).toString().padStart(2, "0")}%`;
export const POOL_RATE_MAX_AGE_MS = 120000;

// Public rate reads do not require a wallet or an executable oracle proof.
// All inputs are pinned to one fresh block and the reviewed pool identity.
export async function readPoolLenderRate(client: PublicClient, market: IsolatedDeployment, now = Date.now) {
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: "latest" })]);
  const fresh = () => Number(block.timestamp) * 1000 <= now() + 15000
    && now() - Number(block.timestamp) * 1000 < POOL_RATE_MAX_AGE_MS;
  if (chainId !== 4663 || block.number === null || !block.hash || !fresh()) throw new Error("Fresh pool data unavailable");
  const blockNumber = block.number;
  const read = (functionName: "asset" | "creditEngine" | "collateralToken" | "totalAssets" | "outstandingPrincipal" | "borrowAprBps" | "revenueFeeBps") =>
    client.readContract({ address: market.pool, abi: isolatedPoolAbi, functionName, blockNumber });
  const [code, asset, engine, collateral, totalAssets, principal, aprBps, feeBps] = await Promise.all([
    client.getCode({ address: market.pool, blockNumber }), read("asset"), read("creditEngine"), read("collateralToken"),
    read("totalAssets"), read("outstandingPrincipal"), read("borrowAprBps"), read("revenueFeeBps"),
  ]);
  if (!code || keccak256(code).toLowerCase() !== market.hashes.pool.toLowerCase()
    || typeof asset !== "string" || asset.toLowerCase() !== ISOLATED_USDG.toLowerCase()
    || typeof engine !== "string" || engine.toLowerCase() !== market.engine.toLowerCase()
    || typeof collateral !== "string" || collateral.toLowerCase() !== market.collateral.toLowerCase()
    || typeof totalAssets !== "bigint" || typeof principal !== "bigint"
    || typeof aprBps !== "number" || typeof feeBps !== "number") throw new Error("Pool data does not match this market");
  const canonical = await client.getBlock({ blockNumber });
  if (canonical.hash !== block.hash || !fresh()) throw new Error("Fresh pool data unavailable");
  const utilizationBps = poolUtilizationBps(principal, totalAssets);
  return { principal, utilizationBps, borrowerAprBps: BigInt(aprBps), lenderAprBps: estimatedLenderAprBps(aprBps, feeBps, utilizationBps),
    blockNumber, expiresAt: Number(block.timestamp) * 1000 + POOL_RATE_MAX_AGE_MS };
}

// Bound the initial eleven-pool read burst on the shared public RPC.
let activeReads = 0;
const waiting: (() => void)[] = [];
export async function queuedPoolRateRead<T>(read: () => Promise<T>): Promise<T> {
  if (activeReads >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else activeReads++;
  try { return await read(); } finally {
    const next = waiting.shift();
    if (next) next(); else activeReads--;
  }
}
