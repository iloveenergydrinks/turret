import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { readActiveLoans } from "./active-loans";
import type { Loan } from "./client";

const market = "0x1111111111111111111111111111111111111111" as Address;
const lender = "0x2222222222222222222222222222222222222222" as Address;
const borrower = "0x3333333333333333333333333333333333333333" as Address;
const other = "0x4444444444444444444444444444444444444444" as Address;
const hash = `0x${"a".repeat(64)}` as Hex;
const row = (id = 1n, status: Loan["status"] = "active", who = borrower): Loan => ({ id, status, lender, borrower: who,
  isPublic: false, createdAt: 1, principal: 100n, collateral: 200n, interest: 1n,
  durationDays: 1, expiresAt: 100, dueAt: 200 });
function fixture(changes: Record<string, unknown> = {}) {
  const body = { schemaVersion: 1, chainId: 31337, market, account: borrower, blockNumber: "90", blockHash: hash,
    indexedThrough: "90", complete: true, status: "ready", activeIds: ["1"], ...changes };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
  const publicClient = { getChainId: vi.fn().mockResolvedValue(31337), getBlock: vi.fn().mockResolvedValue({ number: 90n, hash }) };
  const readLoans = vi.fn().mockResolvedValue([row()]);
  let account: Address | null = borrower;
  return { body, fetch, publicClient, readLoans,
    switchAccount(value: Address | null) { account = value; },
    options: { config: { address: market, chainId: 31337 as const, startBlock: "1" }, account: borrower,
      targetBlock: 90n, publicClient, readLoans, getAccount: () => account, fetch: fetch as typeof globalThis.fetch },
  };
}

describe("verified active loan discovery", () => {
  it("reads an old active obligation immediately despite 80 newer cancelled private offers", async () => {
    const f = fixture();
    const history = [row(), ...Array.from({ length: 80 }, (_, i) => row(BigInt(i + 2), "cancelled"))];
    f.readLoans.mockImplementation(async (ids: bigint[]) => history.filter(loan => ids.includes(loan.id)));
    const result = await readActiveLoans(f.options);
    expect(result.complete).toBe(true); expect(result.loans.map(loan => loan.id)).toEqual([1n]);
    expect(f.readLoans).toHaveBeenCalledExactlyOnceWith([1n], 90n);
    expect(f.fetch.mock.calls[0]![0]).toContain("targetBlock=90");
    expect(f.publicClient.getBlock).toHaveBeenCalledTimes(2);
  });

  it("preserves discovered active rows while reporting backfill incomplete", async () => {
    const f = fixture({ indexedThrough: "10", complete: false, status: "syncing" });
    const result = await readActiveLoans(f.options);
    expect(result.loans).toEqual([row()]); expect(result.complete).toBe(false); expect(result.message).toMatch(/syncing/);
  });

  it("does not label incomplete empty history as ready", async () => {
    const f = fixture({ indexedThrough: "0", complete: false, status: "syncing", activeIds: [] });
    expect(await readActiveLoans(f.options)).toMatchObject({ loans: [], complete: false, status: "syncing" });
    expect(f.readLoans).not.toHaveBeenCalled();
  });

  it("returns unavailable without throwing the enclosing snapshot after fetch/read failures", async () => {
    for (const kind of ["fetch", "http", "read"]) {
      const f = fixture();
      if (kind === "fetch") f.fetch.mockRejectedValue(new Error("offline"));
      if (kind === "http") f.fetch.mockResolvedValue({ ok: false });
      if (kind === "read") f.readLoans.mockRejectedValue(new Error("RPC unavailable"));
      expect(await readActiveLoans(f.options)).toMatchObject({ loans: [], complete: false, status: "unavailable" });
    }
  });

  it.each([
    { market: other }, { account: other }, { chainId: 1 }, { blockNumber: "91" }, { blockHash: "0x123" },
    { indexedThrough: "89" }, { activeIds: ["1", "1"] }, { activeIds: ["0"] }, { activeIds: ["-1"] },
    { activeIds: [String(1n << 256n)] }, { status: "syncing" },
  ])("fails closed for mismatched or malformed response %j", async changes => {
    const f = fixture(changes);
    expect(await readActiveLoans(f.options)).toMatchObject({ complete: false, status: "unavailable" });
    expect(f.readLoans).not.toHaveBeenCalled();
  });

  it("checks the actual RPC network and canonical block hash before reading loans", async () => {
    for (const change of ["chain", "block"]) {
      const f = fixture();
      if (change === "chain") f.publicClient.getChainId.mockResolvedValue(1);
      else f.publicClient.getBlock.mockResolvedValue({ number: 90n, hash: `0x${"b".repeat(64)}` });
      expect((await readActiveLoans(f.options)).status).toBe("unavailable"); expect(f.readLoans).not.toHaveBeenCalled();
    }
  });

  it("rejects a block reorg occurring during loan verification", async () => {
    const f = fixture();
    f.publicClient.getBlock.mockResolvedValueOnce({ number: 90n, hash }).mockResolvedValueOnce({ number: 90n, hash: `0x${"b".repeat(64)}` });
    expect(await readActiveLoans(f.options)).toMatchObject({ loans: [], complete: false, status: "unavailable" });
  });

  it("revalidates ownership and status from chain, including dishonest discovery hints", async () => {
    const f = fixture();
    f.readLoans.mockResolvedValue([row(1n, "active", other)]);
    expect((await readActiveLoans(f.options)).status).toBe("unavailable");
    f.readLoans.mockResolvedValue([row(1n, "repaid")]);
    expect(await readActiveLoans(f.options)).toMatchObject({ loans: [], complete: true, status: "ready" });
    f.readLoans.mockResolvedValue([row(2n)]);
    expect((await readActiveLoans(f.options)).status).toBe("unavailable");
    f.readLoans.mockResolvedValue([]);
    expect((await readActiveLoans(f.options)).status).toBe("unavailable");
  });

  it("never publishes the previous wallet's loans after account switch or disconnect", async () => {
    for (const nextAccount of [other, null]) {
      const f = fixture();
      f.readLoans.mockImplementation(async () => { f.switchAccount(nextAccount); return [row()]; });
      const result = await readActiveLoans(f.options);
      expect(result).toMatchObject({ loans: [], complete: false, status: "unavailable" }); expect(result.message).toMatch(/Wallet changed/);
    }
  });

  it("bounds reads into batches without losing active loans beyond the first forty", async () => {
    const f = fixture({ activeIds: Array.from({ length: 81 }, (_, i) => String(i + 1)) });
    f.readLoans.mockImplementation(async (ids: bigint[]) => ids.map(id => row(id)));
    expect((await readActiveLoans(f.options)).loans).toHaveLength(81);
    expect(f.readLoans.mock.calls.map(([ids]) => ids.length)).toEqual([40, 40, 1]);
  });
});

describe("V3 on-chain active loan discovery", () => {
  function v3() {
    const f = fixture();
    const readActivePage = vi.fn().mockResolvedValue([[1n], 0n, 1n]);
    return { ...f, readActivePage, options: { ...f.options, config: { ...f.options.config, version: 3 as const }, readActivePage } };
  }
  it("loads the owned active set without the event server or incoming invitation list", async () => {
    const f = v3(); f.fetch.mockRejectedValue(new Error("Event server offline"));
    expect(await readActiveLoans(f.options)).toMatchObject({ complete: true, loans: [row()], status: "ready" });
    expect(f.readActivePage).toHaveBeenCalledExactlyOnceWith(0n, 0n);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("binds following pages to the first revision and deduplicates ownership", async () => {
    const f = v3(); f.readActivePage.mockResolvedValueOnce([[1n], 1n, 7n]).mockResolvedValueOnce([[2n], 0n, 7n]);
    f.readLoans.mockImplementation(async (ids: bigint[]) => ids.map(id => row(id)));
    expect((await readActiveLoans(f.options)).loans.map(loan => loan.id)).toEqual([1n, 2n]);
    expect(f.readActivePage).toHaveBeenNthCalledWith(2, 1n, 7n);
  });
  it.each(["revision", "duplicate", "cursor", "ownership", "settled", "reorg", "account"])("returns incomplete for invalid %s", async kind => {
    const f = v3();
    f.readActivePage.mockResolvedValueOnce([[1n], 1n, 7n]).mockResolvedValueOnce([[2n], 0n, 7n]);
    f.readLoans.mockImplementation(async (ids: bigint[]) => ids.map(id => row(id)));
    if (kind === "revision") f.readActivePage.mockReset().mockResolvedValueOnce([[1n], 1n, 7n]).mockResolvedValueOnce([[2n], 0n, 8n]);
    if (kind === "duplicate") f.readActivePage.mockReset().mockResolvedValueOnce([[1n], 1n, 7n]).mockResolvedValueOnce([[1n], 0n, 7n]);
    if (kind === "cursor") f.readActivePage.mockReset().mockResolvedValue([[1n], 3n, 7n]);
    if (kind === "ownership") f.readLoans.mockResolvedValue([row(1n, "active", other)]);
    if (kind === "settled") f.readLoans.mockResolvedValue([row(1n, "repaid")]);
    if (kind === "reorg") f.publicClient.getBlock.mockResolvedValueOnce({ number: 90n, hash }).mockResolvedValueOnce({ number: 90n, hash: `0x${"b".repeat(64)}` });
    if (kind === "account") f.readLoans.mockImplementation(async (ids: bigint[]) => { f.switchAccount(other); return ids.map(id => row(id)); });
    expect(await readActiveLoans(f.options)).toMatchObject({ complete: false, status: "unavailable", loans: [] });
  });
  it("handles an empty never-used revision without requiring an index server", async () => {
    const f = v3(); f.readActivePage.mockResolvedValue([[], 0n, 0n]);
    expect(await readActiveLoans(f.options)).toMatchObject({ complete: true, status: "ready", loans: [] });
    expect(f.readLoans).not.toHaveBeenCalled();
  });
});
