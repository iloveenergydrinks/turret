import { describe, expect, it, vi } from "vitest";
import type { Address, Hex, Transaction } from "viem";
import { recoverPendingTransaction } from "./pending-recovery";
import type { PendingRecord } from "./pending-transactions";
import type { P2PClient } from "./client";

const account = `0x${"11".repeat(20)}` as Address, destination = `0x${"22".repeat(20)}` as Address;
const other = `0x${"33".repeat(20)}` as Address, original = `0x${"aa".repeat(32)}` as Hex, replacement = `0x${"bb".repeat(32)}` as Hex;
const h = (number: bigint) => `0x${number.toString(16).padStart(64, "0")}` as Hex;
const record: PendingRecord = { version: 2, hash: original, savedAt: 0, intent: { from: account, nonce: 7, to: destination, input: "0x1234", value: "0", submittedBlock: "10" } };
function fixture(overrides: Partial<Transaction> = {}) {
  const transaction = { hash: replacement, from: account, nonce: 7, to: destination, input: "0x1234", value: 0n, blockNumber: 15n, blockHash: h(15n), ...overrides } as Transaction;
  const getBlock = vi.fn(async (args?: { blockNumber?: bigint; includeTransactions?: boolean }) => {
    const number = args?.blockNumber ?? 1000n;
    return { number, hash: h(number), transactions: number === 15n ? args?.includeTransactions ? [transaction] : [transaction.hash] : [] };
  });
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (hash === original) throw new Error("original hash no longer exists");
    return { transactionHash: transaction.hash, from: transaction.from, to: transaction.to, blockNumber: 15n, blockHash: h(15n), status: "success" };
  });
  const getTransactionCount = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => blockNumber >= 15n ? 8 : 7);
  const getTransaction = vi.fn(async () => transaction);
  return { rpc: { getBlock, getTransactionReceipt, getTransactionCount, getTransaction } as unknown as P2PClient["publicClient"], getBlock, getTransactionReceipt, getTransactionCount, getTransaction };
}

describe("reopened transaction replacement recovery", () => {
  it("finds an old mined repricing after the original hash has disappeared without scanning intervening blocks", async () => {
    const f = fixture();
    expect(await recoverPendingTransaction(f.rpc, record, account)).toMatchObject({ hash: replacement, equivalent: true, cancelled: false });
    expect(f.getTransactionCount.mock.calls.length).toBeLessThan(15);
    expect(f.getBlock.mock.calls.filter(([args]) => args?.includeTransactions)).toHaveLength(1);
  });
  it("identifies cancellation and a different call without reporting either as successful requested action", async () => {
    expect(await recoverPendingTransaction(fixture({ to: account, input: "0x" }).rpc, record, account)).toMatchObject({ equivalent: false, cancelled: true });
    expect(await recoverPendingTransaction(fixture({ input: "0xabcd" }).rpc, record, account)).toMatchObject({ equivalent: false, cancelled: false });
    expect(await recoverPendingTransaction(fixture({ to: null, input: "0x6000" }).rpc, record, account)).toMatchObject({ equivalent: false, cancelled: false });
  });
  it("uses a supplied hash when historical nonce reads are unavailable", async () => {
    const f = fixture(); f.getTransactionCount.mockRejectedValue(new Error("no historical state"));
    expect(await recoverPendingTransaction(f.rpc, record, account, { replacementHash: replacement })).toMatchObject({ equivalent: true });
    expect(f.getTransactionCount).not.toHaveBeenCalled();
  });
  it("rejects wrong nonce, sender and a noncanonical candidate", async () => {
    await expect(recoverPendingTransaction(fixture({ nonce: 8 }).rpc, record, account, { replacementHash: replacement })).rejects.toThrow("original nonce");
    await expect(recoverPendingTransaction(fixture({ from: other }).rpc, record, account, { replacementHash: replacement })).rejects.toThrow("original nonce");
    const f = fixture(); f.getTransactionReceipt.mockResolvedValue({ transactionHash: replacement, from: account, to: destination, blockNumber: 15n, blockHash: h(99n), status: "success" });
    await expect(recoverPendingTransaction(f.rpc, record, account, { replacementHash: replacement })).rejects.toThrow("canonical block");
  });
  it("keeps a genuinely unmined nonce pending and avoids an unnecessary historical scan", async () => {
    const f = fixture(); f.getTransactionCount.mockResolvedValue(7);
    expect(await recoverPendingTransaction(f.rpc, record, account)).toBeNull();
    expect(f.getBlock.mock.calls.filter(([args]) => args?.includeTransactions)).toHaveLength(0);
  });
  it("bounds its fallback and explicitly asks for a replacement hash for older inaccessible history", async () => {
    const f = fixture(); f.getTransactionCount.mockImplementation(async ({ blockNumber }) => { if (blockNumber === 1000n) return 8; throw new Error("archive unavailable"); });
    await expect(recoverPendingTransaction(f.rpc, record, account)).rejects.toThrow("replacement transaction hash");
    expect(f.getBlock.mock.calls.filter(([args]) => args?.includeTransactions)).toHaveLength(64);
  });
  it("rejects changed wallets and a changed anchor during recovery", async () => {
    await expect(recoverPendingTransaction(fixture().rpc, record, account, { getAccount: () => other })).rejects.toThrow("Wallet changed");
    const f = fixture(); const old = f.getBlock.getMockImplementation()!;
    f.getBlock.mockImplementation(async args => args?.blockNumber === 1000n ? { number: 1000n, hash: h(999n), transactions: [] } : old(args));
    await expect(recoverPendingTransaction(f.rpc, record, account)).rejects.toThrow("chain changed");
  });
});
