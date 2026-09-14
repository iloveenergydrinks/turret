import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { readStaking, stakingAbi } from "./client";
import { parsePending, sendStaking, settleStaking, type StakingPending, type StakingAction } from "./transactions";
import { account, other, d, fixture, hash } from "./fixtures.test-support";

describe("verified staking wallet boundary", () => {
  const pending = (): StakingPending => ({ action: "stake", account, to: d.address, data: encodeFunctionData({ abi: stakingAbi, functionName: "stake", args: [10n ** 18n] }), afterBlock: "10", chainId: 4663, staking: d.address, hash });
  it("approves the exact amount, then stakes only after a fresh allowance read", async () => {
    const f = fixture(), remember = vi.fn();
    const send = (action: StakingAction) => sendStaking({ ...f, deployment: d, account, action, amount: 10n ** 18n, currentScope: () => true, remember });
    await expect(send("stake")).rejects.toThrow(/Approve/);
    await send("approve"); await send("stake");
    expect(f.provider.writeContract.mock.calls.map(([p]) => p.functionName)).toEqual(["approve", "stake"]);
    expect(f.provider.writeContract.mock.calls[0]?.[0].args).toEqual([d.address, 10n ** 18n]);
    expect(remember).toHaveBeenLastCalledWith(null);
  });
  it("uses the contract withdrawal clock even when the RPC block is much higher", async () => {
    const f = fixture(); const onStage = vi.fn(); f.values.lastStakeBlock = 1n; f.values.canUnstake = false;
    const args = { ...f, deployment: d, account, action: "unstake" as const, amount: 1n, currentScope: () => true, remember: vi.fn(), onStage };
    await expect(sendStaking(args)).rejects.toThrow(/withdrawal delay/);
    expect(f.provider.writeContract).not.toHaveBeenCalled();
    f.values.canUnstake = true; onStage.mockClear();
    await sendStaking(args);
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["checking", "wallet", "confirming"]);
    expect(f.provider.writeContract.mock.calls[0]?.[0].functionName).toBe("unstake");
  });
  it("rejects changed contract bytecode before any approval", async () => {
    const f = fixture(); f.rpc.getCode.mockResolvedValueOnce("0x00" as typeof import('./fixtures.test-support').code);
    await expect(readStaking(f.client, d, account)).rejects.toThrow(/verification failed/);
  });
  it("blocks changed account or chain before wallet submission", async () => {
    const f = fixture(); f.provider.getChainId.mockResolvedValue(1);
    await expect(sendStaking({ ...f, deployment: d, account, action: "approve", amount: 1n, currentScope: () => true, remember: vi.fn() })).rejects.toThrow(/network changed/);
    f.provider.getChainId.mockResolvedValue(4663);
    await expect(sendStaking({ ...f, deployment: d, account, action: "approve", amount: 1n, currentScope: () => false, remember: vi.fn() })).rejects.toThrow(/network changed/);
    expect(f.provider.writeContract).not.toHaveBeenCalled();
  });
  it("persists ambiguous wallet outcomes and clears only explicit rejection", async () => {
    const f = fixture(), remember = vi.fn();
    f.provider.writeContract.mockRejectedValueOnce(Error("disconnected"));
    const args = { ...f, deployment: d, account, action: "approve" as const, amount: 1n, currentScope: () => true, remember };
    await expect(sendStaking(args)).rejects.toThrow("disconnected");
    expect(remember).toHaveBeenLastCalledWith(expect.objectContaining({ action: "approve" }));
    expect(remember.mock.calls.at(-1)?.[0].hash).toBeUndefined();
    f.provider.writeContract.mockRejectedValueOnce({ code: 4001 });
    await expect(sendStaking(args)).rejects.toEqual({ code: 4001 });
    expect(remember).toHaveBeenLastCalledWith(null);
  });
  it("rejects receipt mismatches without clearing the recovery record", async () => {
    for (const patch of [{ from: other }, { to: other }, { input: "0x" as const }, { value: 1n }]) {
      const f = fixture(), remember = vi.fn(), p = pending(); f.setTx({ input: p.data, ...patch });
      await expect(settleStaking(f.client, p, remember)).rejects.toThrow(/does not match/);
      expect(remember).not.toHaveBeenCalled();
    }
  });
  it("clears a verified revert but does not report success", async () => {
    const f = fixture(), remember = vi.fn(), p = pending(); f.setTx({ input: p.data }); f.receipt.status = "reverted";
    await expect(settleStaking(f.client, p, remember)).rejects.toThrow(/reverted/);
    expect(remember).toHaveBeenCalledWith(null);
  });
  it("preserves pending transactions after timeout", async () => {
    const f = fixture(), remember = vi.fn(); f.rpc.waitForTransactionReceipt.mockRejectedValueOnce(Error("timeout"));
    await expect(settleStaking(f.client, pending(), remember)).rejects.toThrow("timeout"); expect(remember).not.toHaveBeenCalled();
  });
  it("validates saved recovery data against wallet, deployment and calldata", () => {
    const p = pending(); expect(parsePending(JSON.stringify(p), d, account)).toEqual(p);
    for (const patch of [{ account: other }, { chainId: 1 }, { staking: other }, { to: other }, { data: "0x1234" }, { hash: "bad" }]) {
      expect(() => parsePending(JSON.stringify({ ...p, ...patch }), d, account)).toThrow();
    }
  });
});
