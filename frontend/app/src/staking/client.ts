import { getAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import manifest from "./deployment.json";
import legacyManifest from "./legacy-deployment.json";

export const STAKING_CHAIN_ID = 4663;
export const TURRET = getAddress(manifest.stakingToken);
export const USDG = getAddress(manifest.rewardToken);
export const TREASURY = getAddress(manifest.treasury);
export type StakingDeployment = {
  legacy?: boolean;
  rewardModel?: "reserve-decay-v1" | "reserve-decay-v2";
  address: Address;
  router: Address;
  runtimeHash: Hex;
  routerRuntimeHash: Hex;
  tokenRuntimeHash: Hex;
  usdgRuntimeHash: Hex;
  startBlock: string;
};
export const deployment = manifest.deployment as StakingDeployment | null;
export const legacyDeployment = { ...legacyManifest.deployment, legacy: true } as StakingDeployment;
export const stakingAbi = parseAbi([
  "function stakingToken() view returns(address)", "function rewardToken() view returns(address)",
  "function distributor() view returns(address)", "function totalStaked() view returns(uint256)",
  "function totalFunded() view returns(uint256)", "function totalClaimed() view returns(uint256)",
  "function canUnstake(address) view returns(bool)",
  "function lastStakeBlock(address) view returns(uint256)", "function stakedBalance(address) view returns(uint256)", "function earned(address) view returns(uint256)",
  "function treasury() view returns(address)", "function recoverableSubsidy() view returns(uint256)",
  "function STREAM_VERSION() view returns(uint256)", "function DAILY_RELEASE_BPS() view returns(uint256)",
  "function RETENTION_PER_SECOND() view returns(uint256)",
  "function stake(uint256)", "function unstake(uint256)", "function claim()",
]);
export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)", "function decimals() view returns(uint8)",
]);
export const routerAbi = parseAbi([
  "function staking() view returns(address)", "function rewardToken() view returns(address)",
  "function treasury() view returns(address)", "function STAKER_SHARE_BPS() view returns(uint256)",
  "function totalCollected() view returns(uint256)", "function totalDistributed() view returns(uint256)",
  "function poolCount() view returns(uint256)", "function pools(uint256) view returns(address)",
  "function poolCodeHash(address) view returns(bytes32)", "function collect(address)",
  "function forwardClaimedFees(uint256)", "function totalTreasuryReported() view returns(uint256)",
]);
export type StakingReads = Pick<PublicClient, "getChainId" | "getBlock" | "getCode" | "readContract">;

export async function readStaking(client: StakingReads, d: StakingDeployment, account?: Address) {
  const block = await client.getBlock();
  if (block.number === null || !block.hash || block.number < BigInt(d.startBlock)) throw Error("A mined staking snapshot is unavailable. Refresh and retry.");
  const blockNumber = block.number;
  const read = <T>(address: Address, abi: typeof stakingAbi | typeof routerAbi | typeof tokenAbi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber } as never) as Promise<T>;
  const codeMatches = async (address: Address, expected: Hex) => {
    const code = await client.getCode({ address, blockNumber });
    return !!code && code !== "0x" && keccak256(code) === expected;
  };
  const [chain, stakingCode, routerCode, tokenCode, usdgCode, token, usdg, distributor, routerStaking, treasury, routerToken, share, tokenDecimals, rewardDecimals] = await Promise.all([
    client.getChainId(), codeMatches(d.address, d.runtimeHash), codeMatches(d.router, d.routerRuntimeHash),
    codeMatches(TURRET, d.tokenRuntimeHash), codeMatches(USDG, d.usdgRuntimeHash),
    read<Address>(d.address, stakingAbi, "stakingToken"), read<Address>(d.address, stakingAbi, "rewardToken"),
    read<Address>(d.address, stakingAbi, "distributor"), read<Address>(d.router, routerAbi, "staking"),
    read<Address>(d.router, routerAbi, "treasury"), read<Address>(d.router, routerAbi, "rewardToken"),
    read<bigint>(d.router, routerAbi, "STAKER_SHARE_BPS"),
    read<number>(TURRET, tokenAbi, "decimals"), read<number>(USDG, tokenAbi, "decimals"),
  ]);
  if (chain !== STAKING_CHAIN_ID || !stakingCode || !routerCode || !tokenCode || !usdgCode
    || getAddress(token) !== TURRET || getAddress(usdg) !== USDG || getAddress(distributor) !== getAddress(d.router)
    || getAddress(routerStaking) !== getAddress(d.address) || getAddress(treasury) !== TREASURY
    || getAddress(routerToken) !== USDG || share !== 5000n || tokenDecimals !== 18 || rewardDecimals !== 6) {
    throw Error("Staking contract verification failed. Do not approve tokens; refresh or check the published deployment.");
  }
  if (d.rewardModel) {
    const [version, daily, retention] = await Promise.all([
      read<bigint>(d.address, stakingAbi, "STREAM_VERSION"), read<bigint>(d.address, stakingAbi, "DAILY_RELEASE_BPS"),
      read<bigint>(d.address, stakingAbi, "RETENTION_PER_SECOND"),
    ]);
    if (version !== (d.rewardModel === "reserve-decay-v2" ? 2n : 1n) || daily !== 100n || retention !== 999999883676675127810317475n) throw Error("Streaming reward configuration verification failed.");
  }
  if (d.rewardModel === "reserve-decay-v2" && getAddress(await read<Address>(d.address, stakingAbi, "treasury")) !== TREASURY) throw Error("Reward recovery treasury verification failed.");
  const who = account ?? zeroAddress;
  const [totalStaked, totalFunded, totalClaimed, staked, earned, walletBalance, allowance, treasuryAllowance, totalCollected, lastStakeBlock, canUnstake] = await Promise.all([
    read<bigint>(d.address, stakingAbi, "totalStaked"), read<bigint>(d.address, stakingAbi, "totalFunded"),
    read<bigint>(d.address, stakingAbi, "totalClaimed"), read<bigint>(d.address, stakingAbi, "stakedBalance", [who]),
    read<bigint>(d.address, stakingAbi, "earned", [who]), read<bigint>(TURRET, tokenAbi, "balanceOf", [who]),
    read<bigint>(TURRET, tokenAbi, "allowance", [who, d.address]), read<bigint>(USDG, tokenAbi, "allowance", [TREASURY, d.router]),
    read<bigint>(d.router, routerAbi, "totalCollected"), read<bigint>(d.address, stakingAbi, "lastStakeBlock", [who]),
    read<boolean>(d.address, stakingAbi, "canUnstake", [who]),
  ]);
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error("The staking snapshot changed. Refresh and retry.");
  return { account, blockNumber, blockHash: block.hash, timestamp: block.timestamp, totalStaked, totalFunded, totalClaimed, staked, earned, walletBalance, allowance, treasuryAllowance, totalCollected, lastStakeBlock, canUnstake };
}
export type StakingState = Awaited<ReturnType<typeof readStaking>>;

/** Lightweight live values, called only after full deployment verification. */
export async function readLiveRewards(client: StakingReads, d: StakingDeployment, account: Address) {
  const block = await client.getBlock();
  if (block.number === null || !block.hash || block.number < BigInt(d.startBlock)) throw Error("Reward snapshot unavailable");
  const blockNumber = block.number;
  const [earned, staked, totalStaked] = await Promise.all([
    client.readContract({ address: d.address, abi: stakingAbi, functionName: "earned", args: [account], blockNumber }) as Promise<bigint>,
    client.readContract({ address: d.address, abi: stakingAbi, functionName: "stakedBalance", args: [account], blockNumber }) as Promise<bigint>,
    client.readContract({ address: d.address, abi: stakingAbi, functionName: "totalStaked", blockNumber }) as Promise<bigint>,
  ]);
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw Error("Reward snapshot changed");
  return { account, earned, staked, totalStaked, blockNumber, timestamp: block.timestamp };
}
export type LiveRewards = Awaited<ReturnType<typeof readLiveRewards>>;
