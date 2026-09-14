import { encodeFunctionData, keccak256, type Abi, type Address, type PublicClient, type WalletClient } from "viem";
import { vi } from "vitest";
import { TURRET, USDG, TREASURY, type StakingDeployment } from "./client";
export const account: Address = "0x1111111111111111111111111111111111111111";
export const other: Address = "0x2222222222222222222222222222222222222222";
export const hash = `0x${"ab".repeat(32)}` as const;
export const code = "0x60006000" as const;
export const d: StakingDeployment = { address: "0x3333333333333333333333333333333333333333", router: "0x4444444444444444444444444444444444444444", runtimeHash: keccak256(code), routerRuntimeHash: keccak256(code), tokenRuntimeHash: keccak256(code), usdgRuntimeHash: keccak256(code), startBlock: "1" };
export function fixture() {
  const values = { version: 1n, recoveryTreasury: TREASURY, canUnstake: true, lastStakeBlock: 1n, balance: 100n * 10n ** 18n, allowance: 0n, earned: 5_000_000n, staked: 10n ** 18n, fees: 40_000n };
  let tx = { from: account, to: d.address, input: "0x" as `0x${string}`, value: 0n };
  const receipt = { status: "success", transactionHash: hash, blockNumber: 11n };
  const rpc = {
    getChainId: vi.fn(async () => 4663),
    getBlock: vi.fn(async () => ({ number: 10n, hash, timestamp: 100n })),
    getCode: vi.fn(async () => code),
    readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string }) => {
      const result: Record<string, unknown> = { stakingToken: TURRET, rewardToken: USDG, distributor: d.router, staking: d.address, treasury: address === d.address ? values.recoveryTreasury : TREASURY, STAKER_SHARE_BPS: 5000n,
        STREAM_VERSION: values.version, DAILY_RELEASE_BPS: 100n, RETENTION_PER_SECOND: 999999883676675127810317475n,
        poolCount: 1n, pools: other, totalTreasuryReported: 0n, protocolFees: values.fees,
        decimals: address === TURRET ? 18 : 6, totalStaked: 10n ** 18n, totalFunded: 5_000_000n, totalClaimed: 0n, totalCollected: 10_000_000n,
        canUnstake: values.canUnstake, lastStakeBlock: values.lastStakeBlock, stakedBalance: values.staked, earned: values.earned, balanceOf: values.balance, allowance: values.allowance };
      if (!(functionName in result)) throw Error(`Unexpected RPC read ${functionName}`);
      return result[functionName];
    }),
    simulateContract: vi.fn(async (request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => ({ request })),
    waitForTransactionReceipt: vi.fn(async (_options: unknown) => receipt),
    getTransaction: vi.fn(async () => tx),
  };
  const provider = {
    account: { address: account }, chain: { id: 4663 }, getChainId: vi.fn(async () => 4663),
    getAddresses: vi.fn(async () => [account]),
    writeContract: vi.fn(async (p: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }) => {
      tx = { from: account, to: p.address, input: encodeFunctionData(p), value: 0n };
      if (p.functionName === "approve") values.allowance = p.args[1] as bigint;
      return hash;
    }),
  };
  return { client: rpc as unknown as PublicClient, wallet: provider as unknown as WalletClient, rpc, provider, values, receipt, setTx: (patch: Partial<typeof tx>) => { tx = { ...tx, ...patch }; } };
}
