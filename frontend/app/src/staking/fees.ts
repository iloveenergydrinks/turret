import { getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { routerAbi, type StakingDeployment, type StakingReads, type StakingState } from "./client";

export const STAKING_REFRESH_MS = 20_000;
const poolAbi = parseAbi(["function protocolFees() view returns(uint256)"]);

/** Recorded fees at an already verified staking snapshot. Informational only;
 * deliberately separate from transaction preflight reads. */
export async function readPendingFees(client: StakingReads, d: StakingDeployment, snapshot: StakingState) {
  const { blockNumber } = snapshot;
  const [count, reported] = await Promise.all([
    client.readContract({ address: d.router, abi: routerAbi, functionName: "poolCount", blockNumber }) as Promise<bigint>,
    client.readContract({ address: d.router, abi: routerAbi, functionName: "totalTreasuryReported", blockNumber }) as Promise<bigint>,
  ]);
  if (count < 1n || count > 64n) throw Error("Invalid staking pool count");
  const pools = await Promise.all(Array.from({ length: Number(count) }, async (_, index) => getAddress(await client.readContract({
    address: d.router, abi: routerAbi, functionName: "pools", args: [BigInt(index)], blockNumber,
  }) as Address)));
  if (pools.includes(zeroAddress) || new Set(pools).size !== pools.length) throw Error("Invalid staking pools");
  const fees = await Promise.all(pools.map(address => client.readContract({ address, abi: poolAbi, functionName: "protocolFees", blockNumber })));
  if ((await client.getBlock({ blockNumber })).hash !== snapshot.blockHash) throw Error("Fee snapshot changed");
  const gross = fees.reduce((sum, fee) => sum + fee, 0n);
  // Match the router's carried half-base-unit across all eventual collections.
  const remainder = (snapshot.totalCollected + reported) % 2n;
  const forStakers = (gross + remainder) / 2n;
  const estimatedShare = snapshot.totalStaked > 0n ? forStakers * snapshot.staked / snapshot.totalStaked : 0n;
  return { snapshot, gross, forStakers, estimatedShare, poolCount: pools.length };
}
export type PendingFees = Awaited<ReturnType<typeof readPendingFees>>;
