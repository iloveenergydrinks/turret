import { keccak256 } from "viem";
import { rewardsAbi, type RewardsDeployment, type RewardsReads } from "./client";

export const CAMPAIGN_MAX_AGE_MS = 120000;

/** Public campaign information, independent of wallet balances and approvals. */
export async function readCampaignSummary(client: RewardsReads, deployment: RewardsDeployment, now = Date.now) {
  const [chain, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  const fresh = () => Number(block.timestamp) * 1000 <= now() + 15000
    && now() - Number(block.timestamp) * 1000 < CAMPAIGN_MAX_AGE_MS;
  if (chain !== 4663 || block.number === null || !block.hash || !fresh()) throw Error("Fresh rewards data unavailable");
  const read = (functionName: "startsAt" | "endsAt" | "campaignBudget" | "finalized") =>
    client.readContract({ address: deployment.address, abi: rewardsAbi, functionName, blockNumber: block.number! });
  const [code, start, end, budget, finalized] = await Promise.all([
    client.getCode({ address: deployment.address, blockNumber: block.number }),
    read("startsAt"), read("endsAt"), read("campaignBudget"), read("finalized"),
  ]);
  // Runtime hash includes the immutable pool, reward token, administrator and budget cap.
  if (!code || keccak256(code) !== deployment.runtimeHash || typeof start !== "bigint"
    || typeof end !== "bigint" || typeof budget !== "bigint" || typeof finalized !== "boolean"
    || budget < 0n || budget > BigInt(deployment.budget) || (budget > 0n && end <= start)) {
    throw Error("Rewards campaign does not match this pool");
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash || !fresh()) throw Error("Rewards snapshot changed");
  return { start, end, budget, finalized, expiresAt: Number(block.timestamp) * 1000 + CAMPAIGN_MAX_AGE_MS };
}

export function campaignStatus(data: Awaited<ReturnType<typeof readCampaignSummary>>, now: number) {
  if (data.finalized) return "stopped";
  if (data.budget === 0n) return "unfunded";
  if (now < Number(data.start) * 1000) return "scheduled";
  if (now >= Number(data.end) * 1000) return "ended";
  return "active";
}
