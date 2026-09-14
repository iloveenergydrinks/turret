import { describe, expect, it } from "vitest";
import { account, other, d, fixture, hash } from "./fixtures.test-support";
import { readStaking } from "./client";
import { readPendingFees } from "./fees";

describe("recorded USDG awaiting distribution", () => {
  it("reads the verified block and keeps pending fees separate from earned rewards", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d, account);
    const fees = await readPendingFees(f.client, d, snapshot);
    expect(fees).toMatchObject({ gross: 40_000n, forStakers: 20_000n, estimatedShare: 20_000n });
    expect(snapshot.earned).toBe(5_000_000n);
    for (const [request] of f.rpc.readContract.mock.calls) expect(request).toHaveProperty("blockNumber", 10n);
  });
  it("carries the router's half base unit and uses the current stake proportion", async () => {
    const f = fixture(); f.values.fees = 5n;
    const snapshot = await readStaking(f.client, d, account);
    const result = await readPendingFees(f.client, d, { ...snapshot, totalCollected: 1n, totalStaked: 3n, staked: 1n });
    expect(result.forStakers).toBe(3n); expect(result.estimatedShare).toBe(1n);
  });
  it("sums every allowed pool and includes rounding carried from treasury forwarding", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d, account);
    f.rpc.readContract.mockResolvedValueOnce(2n).mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(account).mockResolvedValueOnce(other)
      .mockResolvedValueOnce(3n).mockResolvedValueOnce(4n);
    expect(await readPendingFees(f.client, d, snapshot)).toMatchObject({ gross: 7n, forStakers: 4n, poolCount: 2 });
  });
  it("rejects an unbounded pool list", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d, account);
    f.rpc.readContract.mockResolvedValueOnce(65n);
    await expect(readPendingFees(f.client, d, snapshot)).rejects.toThrow("Invalid staking pool count");
  });
  it("does not invent rewards without fees or stake", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d);
    f.values.fees = 0n;
    expect((await readPendingFees(f.client, d, snapshot)).forStakers).toBe(0n);
    f.values.fees = 40_000n;
    expect((await readPendingFees(f.client, d, { ...snapshot, totalStaked: 0n })).estimatedShare).toBe(0n);
  });
  it("rejects a reorg instead of mixing fee and stake snapshots", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d, account);
    f.rpc.getBlock.mockResolvedValue({ number: 10n, hash: `0x${"cd".repeat(32)}` as typeof hash, timestamp: 100n });
    await expect(readPendingFees(f.client, d, snapshot)).rejects.toThrow("Fee snapshot changed");
  });
  it("fails the total if a pool read fails instead of showing an incomplete zero", async () => {
    const f = fixture(), snapshot = await readStaking(f.client, d, account), original = f.rpc.readContract.getMockImplementation()!;
    f.rpc.readContract.mockImplementation(async request => {
      if (request.functionName === "protocolFees") throw Error("RPC failed");
      return original(request);
    });
    await expect(readPendingFees(f.client, d, snapshot)).rejects.toThrow("RPC failed");
  });
});
