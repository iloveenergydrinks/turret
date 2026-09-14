import { type Address, encodeAbiParameters, encodeEventTopics, type Hash, pad, type PublicClient } from "viem";
import { describe, expect, test, vi } from "vitest";
import {
  dockyardHistoryAbi,
  formatHistoryAmount,
  HISTORY_START_BLOCK,
  HISTORY_VAULT,
  MVP_HISTORY_VAULT,
  MVP_HISTORY_START_BLOCK,
  PILOT_HISTORY_VAULT,
  PILOT_HISTORY_START_BLOCK,
  historyStartBlock,
  loadWalletHistory,
} from "./dockyard-history";

const wallet = "0x8D9c41c35a1Cf9A6958d58880d3DC5dca36f5086" as const;
const otherWallet = "0x0000000000000000000000000000000000000001" as const;
const aapl = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as const;
const borrowTx = "0xd71ff4f692a132bee9e466a4a3fcace8df8cb87f2516e7194cbc25dca57ac83e" as const;
const closeTx = "0x013fe09be49e3b44575551dbe38c76696593a9658db03df124142a9099ded119" as const;
const tip = 52_502_863n;

function eventLog(
  eventName: "CollateralDeposited" | "Borrowed" | "Repaid" | "CollateralWithdrawn" | "Liquidated" | "BadDebtWrittenOff",
  values: bigint[],
  options: {
    hash?: Hash;
    block?: bigint;
    index?: number;
    borrower?: Address;
    recipient?: Address;
    collateral?: Address;
  } = {},
) {
  const hasAddress = eventName === "Repaid" || eventName === "CollateralWithdrawn";
  const topics = encodeEventTopics({
    abi: dockyardHistoryAbi,
    eventName,
    args: {
      collateral: options.collateral ?? aapl,
      borrower: options.borrower ?? wallet,
      ...(eventName === "Liquidated" ? { liquidator: otherWallet } : {}),
    },
  });
  return {
    address: HISTORY_VAULT as Address,
    topics,
    data: hasAddress
      ? encodeAbiParameters([{ type: "address" }, ...values.map(() => ({ type: "uint256" } as const))], [
        options.recipient ?? wallet,
        ...values,
      ])
      : encodeAbiParameters(values.map(() => ({ type: "uint256" } as const)), values),
    blockNumber: `0x${(options.block ?? tip - 10n).toString(16)}`,
    logIndex: `0x${(options.index ?? 0).toString(16)}`,
    transactionHash: options.hash ?? borrowTx,
    removed: false,
  };
}

function fixture(logs: ReturnType<typeof eventLog>[] = []) {
  const request = vi.fn(async ({ params }: { params: [{ fromBlock: string; toBlock: string }] }) =>
    logs.filter((log) =>
      BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(log.blockNumber) <= BigInt(params[0].toBlock)
    )
  );
  const getBlock = vi.fn(async () => ({ timestamp: 1_788_344_792n }));
  const getBlockNumber = vi.fn(async () => tip);
  const client = { request, getBlock, getBlockNumber } as unknown as Pick<
    PublicClient,
    "request" | "getBlock" | "getBlockNumber"
  >;
  return { client, request, getBlock, getBlockNumber };
}
const params = { wallet, vault: HISTORY_VAULT, chainId: 4663 };

describe("Turret wallet history", () => {
  test("recognizes the replacement and never scans before its verified creation block", async () => {
    const f = fixture();
    f.getBlockNumber.mockResolvedValue(PILOT_HISTORY_START_BLOCK + 5n);
    const page = await loadWalletHistory({ ...params, vault: PILOT_HISTORY_VAULT, client: f.client });
    expect(historyStartBlock(4663, PILOT_HISTORY_VAULT)).toBe(PILOT_HISTORY_START_BLOCK);
    expect(page.fromBlock).toBe(PILOT_HISTORY_START_BLOCK);
    expect(page.before).toBeNull();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ params: [expect.objectContaining({
      address: PILOT_HISTORY_VAULT, fromBlock: `0x${PILOT_HISTORY_START_BLOCK.toString(16)}`,
    })] }));
    expect(historyStartBlock(1, PILOT_HISTORY_VAULT)).toBeUndefined();
    expect(historyStartBlock(4663, otherWallet)).toBeUndefined();
  });

  test("keeps separate market actions within a multi-market smart-wallet transaction", async () => {
    const f = fixture([
      eventLog("Borrowed", [500_000n, 2_500n, 502_500n]),
      eventLog("Borrowed", [1_000_000n, 5_000n, 1_005_000n], {
        index: 1,
        collateral: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
      }),
    ]);
    const page = await loadWalletHistory({ ...params, client: f.client });
    expect(page.entries.map((entry) => entry.market)).toEqual(["MSFT", "AAPL"]);
    expect(page.entries.map((entry) => entry.transactionHash)).toEqual([borrowTx, borrowTx]);
    expect(page.entries[0]?.effects[0]?.amount).toBe(1_000_000n);
    expect(page.entries[1]?.effects[0]?.amount).toBe(500_000n);
  });

  test("groups the real canary's deposit/borrow and repayment/withdrawal, newest first", async () => {
    const f = fixture([
      eventLog("CollateralDeposited", [10_000_000_000_000_000n], { index: 69 }),
      eventLog("Borrowed", [500_000n, 2_500n, 502_500n], { index: 71 }),
      eventLog("Repaid", [502_500n, 0n], { hash: closeTx, block: tip - 1n, index: 1 }),
      eventLog("CollateralWithdrawn", [10_000_000_000_000_000n], { hash: closeTx, block: tip - 1n, index: 4 }),
    ]);
    const page = await loadWalletHistory({ ...params, client: f.client });
    expect(page.entries.map((entry) => entry.title)).toEqual(["Repaid and withdrew", "Borrowed USDG"]);
    expect(page.entries[0]).toMatchObject({ transactionHash: closeTx, market: "AAPL", liquidated: false });
    expect(page.entries[0]?.effects).toEqual([
      { label: "Debt repaid", amount: 502_500n, decimals: 6, symbol: "USDG" },
      { label: "Collateral withdrawn", amount: 10_000_000_000_000_000n, decimals: 18, symbol: "AAPL" },
    ]);
    expect(page.entries[1]?.effects[2]).toEqual({ label: "One-time fee", amount: 2_500n, decimals: 6, symbol: "USDG" });
    expect(f.getBlock).toHaveBeenCalledTimes(2);
  });

  test("filters by wallet and vault at the RPC and ignores unrelated or removed results", async () => {
    const valid = eventLog("CollateralDeposited", [1n]);
    const f = fixture([valid, eventLog("Borrowed", [1n, 1n, 2n], { borrower: otherWallet }), {
      ...valid,
      address: otherWallet,
    }, { ...valid, removed: true }]);
    const page = await loadWalletHistory({ ...params, client: f.client });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.effects).toHaveLength(1);
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      method: "eth_getLogs",
      params: [{ address: HISTORY_VAULT, topics: [expect.any(Array), null, pad(wallet)] }],
    });
  });

  test("paginates backwards without gaps and never requests before vault deployment", async () => {
    const f = fixture();
    const page = await loadWalletHistory({ ...params, client: f.client, before: HISTORY_START_BLOCK + 100_004n });
    expect(page.fromBlock).toBe(HISTORY_START_BLOCK + 5n);
    expect(page.before).toBe(HISTORY_START_BLOCK + 4n);
    expect(f.request).toHaveBeenCalledTimes(10);
    const last = await loadWalletHistory({ ...params, client: f.client, before: page.before! });
    expect(last.fromBlock).toBe(HISTORY_START_BLOCK);
    expect(last.before).toBeNull();
    expect(f.getBlockNumber).not.toHaveBeenCalled();
  });

  test("does not mistake an RPC failure for an empty wallet", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("Rate limited"));
    await expect(loadWalletHistory({ ...params, client: f.client })).rejects.toThrow("Rate limited");
  });

  test("keeps liquidation and bad-debt events distinct from voluntary repayment", async () => {
    const f = fixture([
      eventLog("Liquidated", [1_005_000n, 7_035_000_000_000_000n]),
      eventLog("BadDebtWrittenOff", [5_000n], { hash: closeTx, block: tip - 1n }),
    ]);
    const { entries } = await loadWalletHistory({ ...params, client: f.client });
    expect(entries[0]?.title).toBe("Bad debt written off");
    expect(entries[1]).toMatchObject({ title: "Position liquidated", liquidated: true });
    expect(entries[1]?.effects.map((effect) => effect.label)).toEqual([
      "Debt repaid by liquidator",
      "Collateral seized",
    ]);
  });

  test("deduplicates identical logs while retaining separate events in one transaction", async () => {
    const event = eventLog("CollateralDeposited", [1n]);
    const f = fixture([event, event, eventLog("CollateralDeposited", [2n], { index: 1 })]);
    const page = await loadWalletHistory({ ...params, client: f.client });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.effects.map((effect) => effect.amount)).toEqual([1n, 2n]);
  });

  test("falls back to block numbers when timestamps cannot be fetched", async () => {
    const f = fixture([eventLog("CollateralDeposited", [1n])]);
    f.getBlock.mockRejectedValue(new Error("Block lookup unavailable"));
    const page = await loadWalletHistory({ ...params, client: f.client });
    expect(page.entries[0]?.timestamp).toBeNull();
    expect(page.entries[0]?.blockNumber).toBe(tip - 10n);
  });

  test("cancels old-wallet work before more RPC calls", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(loadWalletHistory({ ...params, client: f.client, signal: controller.signal })).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.getBlockNumber).not.toHaveBeenCalled();
  });

  test("fails closed on another chain or vault", async () => {
    const f = fixture();
    await expect(loadWalletHistory({ ...params, client: f.client, chainId: 1 })).rejects.toThrow("deployment");
    await expect(loadWalletHistory({ ...params, client: f.client, vault: otherWallet })).rejects.toThrow("deployment");
    expect(f.request).not.toHaveBeenCalled();
  });

  test("preserves tiny and large token amounts exactly", () => {
    expect(formatHistoryAmount(1n, 18)).toBe("0.000000000000000001");
    expect(formatHistoryAmount(502_500n, 6)).toBe("0.5025");
    expect(formatHistoryAmount(999_999_999_999_999_999_999_999n, 6)).toBe("999999999999999999.999999");
  });
});

test("execution-gated MVP history starts at its verified creation block", () => {
  expect(historyStartBlock(4663, MVP_HISTORY_VAULT)).toBe(MVP_HISTORY_START_BLOCK);
  expect(MVP_HISTORY_START_BLOCK).toBe(52939342n);
  expect(historyStartBlock(1, MVP_HISTORY_VAULT)).toBeUndefined();
});
