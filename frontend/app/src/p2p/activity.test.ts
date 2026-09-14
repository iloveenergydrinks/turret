import { describe, expect, it, vi } from "vitest";
import { activityAmount, activityCsv, activityExplorer, readP2PActivity, type ActivityClient } from "./activity";
import type { Address, Hex } from "viem";

const lender = `0x${"11".repeat(20)}` as Address, borrower = `0x${"22".repeat(20)}` as Address;
const market = `0x${"33".repeat(20)}` as Address, usdg = `0x${"44".repeat(20)}` as Address;
const collateral = `0x${"55".repeat(20)}` as Address, vault = `0x${"66".repeat(20)}` as Address;
const stranger = `0x${"77".repeat(20)}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const event = (eventName: string, args: Record<string, unknown>, blockNumber = 18n, logIndex = 0) => ({
  eventName, args, address: market, blockNumber, blockHash: h(Number(blockNumber)), transactionHash: h(Number(blockNumber) + 100), logIndex, removed: false,
});
function fixture(version = 3, logs: ReturnType<typeof event>[] = []) {
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: h(Number(blockNumber)), timestamp: 1_800_000_000n + blockNumber }));
  const getLogs = vi.fn(async ({ fromBlock, toBlock, events }: { fromBlock: bigint; toBlock: bigint; events: { name: string }[] }) => logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock && events.some(e => e.name === log.eventName)));
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => functionName === "vaults" ? vault : [lender, borrower, 100_000_000n, 5_000_000n, 2_000_000n, 86400n, 1_800_000_000n, 1_800_000_000n, 3]);
  const client = { config: { version, chainId: 31337, address: market, startBlock: "1", loanToken: usdg, collateralToken: collateral, loanSymbol: "USDG", collateralSymbol: "SLV", loanDecimals: 6, collateralDecimals: 6 }, publicClient: { getBlock, getLogs, readContract }, verify: vi.fn(async () => ({ number: 20n, hash: h(20) })) } as unknown as ActivityClient;
  return { client, getBlock, getLogs, readContract };
}

describe("chain-backed P2P activity", () => {
  it("rebuilds withdrawals after reload, filters wallets and omits duplicate V3 events", async () => {
    const f = fixture(3, [
      event("Withdrawn", { account: lender, recipient: borrower, token: usdg, amount: 9_000_000n }),
      event("LoanCreditWithdrawn", { id: 1n, account: lender, recipient: borrower, token: usdg, amount: 9_000_000n, writtenOff: 1_000_000n }, 18n, 1),
      event("CreditAdded", { account: lender, token: usdg, amount: 10_000_000n }, 18n, 2),
      event("LoanCreditAdded", { id: 1n, account: lender, token: usdg, amount: 10_000_000n }, 18n, 3),
      event("LoanCreditWithdrawn", { id: 2n, account: stranger, recipient: stranger, token: usdg, amount: 1n, writtenOff: 0n }, 18n, 4),
    ]);
    const first = await readP2PActivity(f.client, lender);
    expect(first.next).toBeNull();
    expect(first.entries.map(e => e.action)).toEqual(["Withdrawal credit added", "Funds withdrawn"]);
    expect(first.entries[1]).toMatchObject({ recipient: borrower, amount: 9_000_000n, writtenOff: 1_000_000n, timestamp: 1_800_000_018 });
    const reloaded = await readP2PActivity(f.client, lender);
    expect(reloaded.entries).toEqual(first.entries);
    const received = await readP2PActivity(f.client, borrower);
    expect(received.entries).toHaveLength(1);
    expect(received.entries[0]!.action).toBe("Funds withdrawn");
  });

  it.each([1, 2])("reads V%s funding, acceptance, third-party repayment and legacy withdrawals", async version => {
    const f = fixture(version, [
      event("OfferCreated", { id: 1n, lender, borrower, principal: 100_000_000n }, 17n),
      event("OfferAccepted", { id: 1n }, 18n),
      event("LoanRepaid", { id: 1n, payer: stranger, amount: 102_000_000n }, 19n),
      event("Withdrawn", { account: lender, recipient: lender, token: usdg, amount: 102_000_000n }, 20n),
    ]);
    expect((await readP2PActivity(f.client, lender)).entries.map(e => e.action)).toEqual(["Funds withdrawn", "Repayment settled", "Loan principal delivered", "Collateral deposited", "Offer funded"]);
    expect((await readP2PActivity(f.client, stranger)).entries.map(e => e.action)).toEqual(["Repayment settled"]);
    expect(f.readContract.mock.calls.every(([call]) => call.functionName === "offers")).toBe(true);
  });

  it("keeps credit-funded repayment distinct from wallet transfers", async () => {
    const f = fixture(3, [event("LoanCreditSpent", { sourceId: 2n, targetId: 1n, payer: borrower, amount: 50_000_000n }, 19n), event("LoanRepaid", { id: 1n, payer: borrower, amount: 102_000_000n }, 19n, 1)]);
    const page = await readP2PActivity(f.client, borrower);
    expect(page.entries[0]).toMatchObject({ action: "Repayment settled", amount: 102_000_000n });
    expect(page.entries[0]!.detail).toContain("not necessarily a wallet debit");
    expect(page.entries[1]).toMatchObject({ action: "Credit used for repayment", loanId: 2n, amount: 50_000_000n });
  });

  it("paginates nonoverlapping inclusive block ranges at the original snapshot", async () => {
    const f = fixture(2, [event("Withdrawn", { account: lender, recipient: lender, token: usdg, amount: 1n }, 15n)]);
    const first = await readP2PActivity(f.client, lender, { blockSpan: 5n, maxWindows: 1 });
    expect(first).toMatchObject({ entries: [], scannedFrom: 16n, scannedTo: 20n, next: { before: 15n, anchor: 20n } });
    const second = await readP2PActivity(f.client, lender, { cursor: first.next, blockSpan: 5n, maxWindows: 1 });
    expect(second).toMatchObject({ scannedFrom: 11n, scannedTo: 15n, next: { before: 10n, anchor: 20n } });
    expect(second.entries).toHaveLength(1);
    await expect(readP2PActivity(f.client, borrower, { cursor: first.next })).rejects.toThrow("another wallet");
  });

  it("rejects a reorg before pagination and does not advance past an unavailable range", async () => {
    const f = fixture();
    const first = await readP2PActivity(f.client, lender, { blockSpan: 5n, maxWindows: 1 });
    f.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber, hash: h(999), timestamp: 1n }));
    await expect(readP2PActivity(f.client, lender, { cursor: first.next })).rejects.toThrow("snapshot changed");
    const failed = fixture(); failed.getLogs.mockRejectedValue(new Error("provider unavailable"));
    await expect(readP2PActivity(failed.client, lender)).rejects.toThrow("no older history was skipped");
    expect(failed.getLogs.mock.calls).toHaveLength(6);
    expect(failed.getLogs.mock.calls.every(([request]) => request.toBlock === 20n)).toBe(true);
  });

  it("rejects removed logs, inconsistent event hashes and wallet switches", async () => {
    const log = event("Withdrawn", { account: lender, recipient: lender, token: usdg, amount: 1n });
    await expect(readP2PActivity(fixture(2, [{ ...log, removed: true }]).client, lender)).rejects.toThrow("noncanonical");
    await expect(readP2PActivity(fixture(2, [{ ...log, blockHash: h(999) }]).client, lender)).rejects.toThrow("reorganized");
    await expect(readP2PActivity(fixture().client, lender, { getAccount: () => borrower })).rejects.toThrow("wallet changed");
  });

  it("exports exact amounts, recipients, transaction hashes and CSV-safe text", async () => {
    const page = await readP2PActivity(fixture(2, [event("Withdrawn", { account: lender, recipient: borrower, token: usdg, amount: 123_456_789n })]).client, lender);
    expect(activityAmount(page.entries[0]!)).toBe("123.456789 USDG");
    const csv = activityCsv([{ ...page.entries[0]!, detail: '=HYPERLINK("bad")' }], lender);
    expect(csv).toContain('"123456789"'); expect(csv).toContain(borrower); expect(csv).toContain(h(118));
    expect(csv).toContain("' =".replace(" ", ""));
    expect(activityExplorer({ chainId: 31337 }, h(1))).toBeNull();
    expect(activityExplorer({ chainId: 4663 }, h(1))).toContain("https://explorer.mainnet.chain.robinhood.com/tx/");
  });
});
