// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, EIP1193Provider, Hex, ReplacementReturnType, Transaction, TransactionReceipt, WaitForTransactionReceiptParameters } from "viem";
const mocks = vi.hoisted(() => ({ wait: vi.fn(), block: vi.fn(), read: vi.fn(), simulate: vi.fn(), write: vi.fn(), health: vi.fn(), chainId: vi.fn(), code: vi.fn() }));
vi.mock("./health", () => ({ readP2PHealth: mocks.health }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => ({ waitForTransactionReceipt: mocks.wait, getBlock: mocks.block, readContract: mocks.read, simulateContract: mocks.simulate, getChainId: mocks.chainId, getCode: mocks.code }), createWalletClient: () => ({ writeContract: mocks.write }) }));
import { ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, keccak256 } from "viem";
import { P2PClient, p2pAbi } from "./client";
import type { Deployment, TransactionStage } from "./client";
import { loadPendingRecord, savePending } from "./pending-transactions";
const LENDER: Address = "0x1111111111111111111111111111111111111111";
const OTHER: Address = "0x2222222222222222222222222222222222222222";
const CONTRACT: Address = "0x3333333333333333333333333333333333333333";
const ORIGINAL = `0x${"a".repeat(64)}` as Hex;
const REPLACEMENT = `0x${"b".repeat(64)}` as Hex;
const SECOND = `0x${"c".repeat(64)}` as Hex;
const BLOCK = `0x${"d".repeat(64)}` as Hex;
const config: Deployment = { chainId: 31337, chainName: "Local test", rpcUrl: "/api/p2p-rpc", address: CONTRACT, loanToken: "0x4444444444444444444444444444444444444444", collateralToken: "0x5555555555555555555555555555555555555555", loanSymbol: "USDG", collateralSymbol: "SLV", loanDecimals: 6, collateralDecimals: 18, runtimeHash: BLOCK, startBlock: "1" };
const provider = { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x7a69" : [LENDER] } as EIP1193Provider;
const pendingKey = (account = LENDER) => `turret:p2p:pending:31337:${CONTRACT}:${account}`;
function receipt(hash = ORIGINAL, overrides: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return { transactionHash: hash, blockHash: BLOCK, blockNumber: 10n, status: "success", from: LENDER, to: CONTRACT, ...overrides } as TransactionReceipt;
}
function transaction(hash = ORIGINAL, overrides: Partial<Transaction> = {}): Transaction {
  return { hash, from: LENDER, to: CONTRACT, nonce: 7, input: "0x12345678", value: 0n, ...overrides } as Transaction;
}
function replacement(reason: ReplacementReturnType["reason"] = "repriced", previous = transaction(), next = transaction(REPLACEMENT), observed = receipt(next.hash)): ReplacementReturnType {
  return { reason, replacedTransaction: previous, transaction: next, transactionReceipt: observed };
}
function client() {
  const connection = new P2PClient(config); connection.account = LENDER;
  vi.spyOn(connection, "verify").mockResolvedValue({ timestamp: 1000n } as never);
  return connection;
}
function resolveWith(events: ReplacementReturnType[], finalReceipt = events.at(-1)?.transactionReceipt ?? receipt()) {
  mocks.wait.mockImplementation(async (options: WaitForTransactionReceiptParameters) => { for (const event of events) options.onReplaced?.(event); return finalReceipt; });
}
function acceptance() { mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) => functionName === "offers" ? [OTHER, LENDER, 25_000_000n, 2_000_000_000_000_000_000n, 1_000_000n, 604800n, 2000n, 0n, 1] : 0n); }
beforeEach(() => {
  mocks.health.mockReset().mockResolvedValue({ status: "ok", reasons: [], blockNumber: "10", blockHash: BLOCK, checkedAt: Date.now() });
  window.localStorage.clear(); sessionStorage.clear(); mocks.wait.mockReset().mockResolvedValue(receipt()); mocks.block.mockReset().mockResolvedValue({ hash: BLOCK });
  mocks.read.mockReset().mockResolvedValue(0n); mocks.simulate.mockReset().mockResolvedValue({ request: {} }); mocks.write.mockReset().mockResolvedValue(ORIGINAL);
  mocks.chainId.mockReset().mockResolvedValue(31337); mocks.code.mockReset().mockResolvedValue("0x6000");
});
describe("new-exposure health gate preserves recovery", () => {
  it("binds both V3 acceptance checks to its particular vault and stops if funding disappears after approval", async () => {
    acceptance();
    const connection = new P2PClient({ ...config, version: 3, vaultImplementation: OTHER, vaultImplementationHash: BLOCK });
    connection.account = LENDER;
    vi.spyOn(connection, "verify").mockResolvedValue({ number: 10n, hash: BLOCK, timestamp: 1000n } as never);
    mocks.health.mockResolvedValueOnce({ status: "ok", reasons: [] })
      .mockResolvedValue({ status: "blocked", reasons: ["This offer's vault has a token shortfall."] });
    await expect(connection.accept(provider, 7n, vi.fn())).rejects.toThrow(/vault has a token shortfall/);
    expect(mocks.health).toHaveBeenCalledTimes(2);
    expect(mocks.health.mock.calls.every(call => call[3] === 7n)).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.simulate.mock.calls.map(([request]) => request.functionName)).toEqual(["approve"]);
  });
  it("blocks acceptance before any token approval when token checks fail", async () => {
    acceptance();mocks.health.mockResolvedValue({status:"blocked",reasons:["Token implementation changed. New loans await review."]});
    await expect(client().accept(provider,1n,vi.fn())).rejects.toThrow(/implementation changed/);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("rechecks after approval and does not submit acceptance after a new restriction", async () => {
    acceptance();mocks.health.mockResolvedValueOnce({status:"ok",reasons:[]}).mockResolvedValue({status:"unavailable",reasons:["Current checks unavailable"]});
    await expect(client().accept(provider,1n,vi.fn())).rejects.toThrow(/Current checks unavailable/);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });
  it("allows cancellation while new-exposure monitoring is unavailable", async () => {
    mocks.health.mockResolvedValue({status:"unavailable",reasons:["Cannot verify"]});
    await expect(client().cancel(provider,1n,vi.fn())).resolves.toBe(ORIGINAL);
    expect(mocks.health).not.toHaveBeenCalled();
  });
});

describe("raw-unit recovery does not depend on mutable token metadata", () => {
  function recoveryClient() {
    // Exercise real verification instead of the helper's verify() stub. The
    // token decimals getter is unavailable, while escrow identity still works.
    const connection = new P2PClient({ ...config, runtimeHash: keccak256("0x6000") });
    connection.account = LENDER;
    mocks.block.mockResolvedValue({ number: 10n, hash: BLOCK, timestamp: 1000n });
    mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "decimals") throw new Error("Token decimals temporarily unavailable");
      if (functionName === "loanToken") return config.loanToken;
      if (functionName === "collateralToken") return config.collateralToken;
      if (functionName === "offers") return [OTHER, LENDER, 25_000_000n, 2_000_000_000_000_000_000n, 1_000_000n, 604800n, 2000n, 605800n, 2];
      if (functionName === "allowance") return 0n;
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
    mocks.health.mockResolvedValue({ status: "unavailable", reasons: ["Token metadata unavailable"] });
    return connection;
  }

  it("repays the immutable raw principal plus interest when decimals cannot be read", async () => {
    const connection = recoveryClient();
    await expect(connection.repay(provider, 1n, vi.fn())).resolves.toBe(ORIGINAL);
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "approve", address: config.loanToken, args: [CONTRACT, 26_000_000n],
    }));
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ functionName: "repay", address: CONTRACT, args: [1n] }));
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls.some(([request]) => request.functionName === "decimals")).toBe(false);
    expect(mocks.code).toHaveBeenCalledWith({ address: CONTRACT, blockNumber: 10n });
  });

  it.each(["cancel", "expire", "claim", "withdraw"] as const)("keeps %s available without token metadata reads", async action => {
    const connection = recoveryClient();
    const operation = action === "withdraw"
      ? connection.withdraw(provider, "USDG", 26_000_000n, OTHER, vi.fn())
      : connection[action](provider, 1n, vi.fn());
    await expect(operation).resolves.toBe(ORIGINAL);
    const functionName = { cancel: "cancelOffer", expire: "expireOffer", claim: "claimDefault", withdraw: "withdraw" }[action];
    expect(mocks.simulate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      functionName, address: CONTRACT, args: action === "withdraw" ? [config.loanToken, 26_000_000n, OTHER] : [1n],
    }));
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.read.mock.calls.some(([request]) => request.functionName === "decimals")).toBe(false);
  });

  it.each(["runtime", "token binding", "chain"])("still rejects recovery on an invalid %s", async changed => {
    const connection = recoveryClient();
    if (changed === "runtime") mocks.code.mockResolvedValue("0x6001");
    if (changed === "chain") mocks.chainId.mockResolvedValue(1);
    if (changed === "token binding") {
      const read = mocks.read.getMockImplementation()!;
      mocks.read.mockImplementation(request => request.functionName === "loanToken" ? Promise.resolve(OTHER) : read(request));
    }
    await expect(connection.withdraw(provider, "USDG", 1n, OTHER, vi.fn())).rejects.toThrow();
    expect(mocks.write).not.toHaveBeenCalled(); expect(mocks.simulate).not.toHaveBeenCalled();
  });
});

describe("wallet changes during pre-signature asynchronous checks", () => {
  function changingWallet(connection: P2PClient, updateClient: boolean) {
    let walletAccount = LENDER;
    return {
      provider: { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x7a69" : [walletAccount] } as EIP1193Provider,
      change() { walletAccount = OTHER; if (updateClient) connection.account = OTHER; },
    };
  }

  it.each([
    [1, false], [1, true], [2, false], [2, true],
  ] as const)("stops signing after health check %s when the provider changes (client event delivered: %s)", async (healthCheck, updateClient) => {
    acceptance(); const connection = client(); const wallet = changingWallet(connection, updateClient);
    let finishHealth!: (value: { status: "ok"; reasons: string[] }) => void;
    if (healthCheck === 2) mocks.health.mockResolvedValueOnce({ status: "ok", reasons: [] });
    mocks.health.mockImplementationOnce(() => new Promise(resolve => { finishHealth = resolve; }));
    const onStage = vi.fn();
    const operation = connection.accept(wallet.provider, 1n, onStage);
    await vi.waitFor(() => expect(mocks.health).toHaveBeenCalledTimes(healthCheck));
    wallet.change(); finishHealth({ status: "ok", reasons: [] });
    await expect(operation).rejects.toThrow(/wallet account changed/i);
    // The second check follows an already-confirmed approval, but the loan must
    // never be signed after the wallet switch. The first check precedes both.
    expect(mocks.write).toHaveBeenCalledTimes(healthCheck - 1);
    expect(onStage.mock.calls.filter(([stage]) => stage.status === "signature")).toHaveLength(healthCheck - 1);
    expect(sessionStorage.getItem(pendingKey(OTHER))).toBeNull();
  });

  it.each([
    ["approval", false], ["approval", true], ["loan", false], ["loan", true],
  ] as const)("stops %s signing when the wallet changes during simulation (client event delivered: %s)", async (phase, updateClient) => {
    acceptance(); const connection = client(); const wallet = changingWallet(connection, updateClient);
    if (phase === "loan") {
      const read = mocks.read.getMockImplementation()!;
      mocks.read.mockImplementation(request => request.functionName === "allowance"
        ? Promise.resolve(2_000_000_000_000_000_000n) : read(request));
    }
    let finishSimulation!: (value: { request: object }) => void;
    mocks.simulate.mockImplementationOnce(() => new Promise(resolve => { finishSimulation = resolve; }));
    const onStage = vi.fn();
    const operation = connection.accept(wallet.provider, 1n, onStage);
    await vi.waitFor(() => expect(mocks.simulate).toHaveBeenCalledOnce());
    expect(mocks.simulate.mock.calls[0]?.[0].functionName).toBe(phase === "approval" ? "approve" : "acceptOffer");
    wallet.change(); finishSimulation({ request: {} });
    await expect(operation).rejects.toThrow(/wallet account changed/i);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(onStage.mock.calls.some(([stage]) => stage.status === "signature")).toBe(false);
    expect(sessionStorage.getItem(pendingKey())).toBeNull(); expect(sessionStorage.getItem(pendingKey(OTHER))).toBeNull();
  });
});
describe("receipt identity and equivalent repricing", () => {
  it("confirms an ordinary transaction and returns its mined hash", async () => {
    const stages: TransactionStage[] = [];
    expect(await client().cancel(provider, 1n, stage => stages.push(stage))).toBe(ORIGINAL);
    expect(stages.at(-1)).toMatchObject({ status: "confirmed", hash: ORIGINAL });
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
  it("accepts a gas-only repricing and confirms/returns the replacement hash", async () => {
    resolveWith([replacement()]); const stages: TransactionStage[] = [];
    expect(await client().cancel(provider, 1n, stage => stages.push(stage))).toBe(REPLACEMENT);
    expect(stages.at(-1)).toMatchObject({ status: "confirmed", hash: REPLACEMENT });
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
  it("accepts a bounded chain of equivalent replacements", async () => {
    resolveWith([replacement(), replacement("repriced", transaction(REPLACEMENT), transaction(SECOND))]); const onStage = vi.fn();
    expect(await client().cancel(provider, 1n, onStage)).toBe(SECOND);
    expect(onStage).toHaveBeenLastCalledWith(expect.objectContaining({ status: "confirmed", hash: SECOND }));
  });
  it("accepts viem identifying the original hash itself as repriced during indexing lag", async () => {
    resolveWith([replacement("repriced", transaction(), transaction())]);
    expect(await client().cancel(provider, 1n, vi.fn())).toBe(ORIGINAL);
  });
});
describe("wallet cancellation and different calls", () => {
  it("explains a public offer lost during token approval without submitting acceptance", async () => {
    acceptance();
    mocks.simulate.mockResolvedValueOnce({ request: {} }).mockRejectedValueOnce(new ContractFunctionRevertedError({
      abi: p2pAbi, data: encodeErrorResult({ abi: p2pAbi, errorName: "WrongStatus" }), functionName: "acceptOffer",
    }));
    await expect(client().accept(provider, 1n, vi.fn())).rejects.toThrow(/no longer available.*No loan was opened.*approval already confirmed may remain/);
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
  it("rejects a successful cancellation and clears a canonically consumed pending nonce", async () => {
    resolveWith([replacement("cancelled", transaction(), transaction(REPLACEMENT, { to: LENDER, input: "0x" }), receipt(REPLACEMENT, { to: LENDER }))]); const onStage = vi.fn();
    await expect(client().cancel(provider, 1n, onStage)).rejects.toThrow(/was cancelled/);
    expect(onStage.mock.calls.some(([stage]) => stage.status === "confirmed")).toBe(false);
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
  it("never submits the loan after its token approval is cancelled", async () => {
    acceptance(); resolveWith([replacement("cancelled", transaction(), transaction(REPLACEMENT, { to: LENDER, input: "0x" }), receipt(REPLACEMENT, { to: LENDER }))]);
    await expect(client().accept(provider, 1n, vi.fn())).rejects.toThrow("Token approval was cancelled");
    expect(mocks.write).toHaveBeenCalledTimes(1); expect(mocks.simulate).toHaveBeenCalledTimes(1);
    expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ functionName: "approve" }));
  });
  it.each([["calldata", { input: "0x87654321" }], ["recipient", { to: OTHER }], ["value", { value: 1n }]])("rejects changed %s even if labeled repriced", async (_name, override) => {
    resolveWith([replacement("repriced", transaction(), transaction(REPLACEMENT, override as Partial<Transaction>))]);
    await expect(client().cancel(provider, 1n, vi.fn())).rejects.toThrow(/replaced by a different transaction/);
  });
  it("rejects a changed call followed by repricing of that changed call", async () => {
    const changed = transaction(REPLACEMENT, { input: "0x87654321" });
    resolveWith([replacement("replaced", transaction(), changed), replacement("repriced", changed, transaction(SECOND, { input: changed.input }))]);
    await expect(client().cancel(provider, 1n, vi.fn())).rejects.toThrow(/replaced by a different transaction/);
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
});
describe("unknown outcomes retain pending", () => {
  it.each([
    ["unannounced hash", [], receipt(REPLACEMENT)],
    ["unknown predecessor", [replacement("repriced", transaction(SECOND), transaction(REPLACEMENT))], receipt(REPLACEMENT)],
    ["wrong sender", [replacement("repriced", transaction(), transaction(REPLACEMENT, { from: OTHER }))], receipt(REPLACEMENT)],
    ["wrong nonce", [replacement("repriced", transaction(), transaction(REPLACEMENT, { nonce: 8 }))], receipt(REPLACEMENT)],
    ["callback hash", [replacement("repriced", transaction(), transaction(REPLACEMENT), receipt(SECOND))], receipt(SECOND)],
    ["returned block hash", [replacement()], receipt(REPLACEMENT, { blockHash: SECOND })],
    ["returned block number", [replacement()], receipt(REPLACEMENT, { blockNumber: 11n })],
    ["returned status", [replacement()], receipt(REPLACEMENT, { status: "reverted" })],
    ["missing status", [], receipt(ORIGINAL, { status: undefined })],
  ])("retains the original pending hash for %s", async (_name, events, finalReceipt) => {
    resolveWith(events as ReplacementReturnType[], finalReceipt as TransactionReceipt); const onStage = vi.fn();
    await expect(client().cancel(provider, 1n, onStage)).rejects.toThrow(/could not be verified/);
    expect(onStage.mock.calls.some(([stage]) => stage.status === "confirmed")).toBe(false);
    expect(sessionStorage.getItem(pendingKey())).toBe(ORIGINAL);
  });
  it("bounds callback processing to sixteen replacements", async () => {
    resolveWith(Array.from({ length: 17 }, () => replacement("repriced", transaction(), transaction())));
    await expect(client().cancel(provider, 1n, vi.fn())).rejects.toThrow(/could not be verified/);
    expect(sessionStorage.getItem(pendingKey())).toBe(ORIGINAL);
  });
  it("retains pending across reorganization and timeout, but clears a verified revert", async () => {
    const connection = client(); mocks.block.mockResolvedValueOnce({ hash: SECOND });
    await expect(connection.cancel(provider, 1n, vi.fn())).rejects.toThrow(/reorganization/);
    expect(sessionStorage.getItem(pendingKey())).toBe(ORIGINAL);
    mocks.wait.mockRejectedValueOnce(new Error("Timed out"));
    await expect(connection.reconcilePending(vi.fn())).rejects.toThrow(/Timed out/);
    expect(sessionStorage.getItem(pendingKey())).toBe(ORIGINAL);
    mocks.wait.mockResolvedValueOnce(receipt(ORIGINAL, { status: "reverted" }));
    await expect(connection.reconcilePending(vi.fn())).rejects.toThrow(/reverted/);
    expect(sessionStorage.getItem(pendingKey())).toBeNull();
  });
});
describe("origin account ownership survives asynchronous wallet changes", () => {
  it("does not copy A's timed-out transaction into B's pending record", async () => {
    const connection = client(); mocks.wait.mockRejectedValueOnce(new Error("Timed out"));
    await expect(connection.cancel(provider, 1n, vi.fn())).rejects.toThrow(/Timed out/);
    connection.disconnect(); connection.account = OTHER; sessionStorage.setItem(pendingKey(OTHER), SECOND);
    mocks.wait.mockResolvedValueOnce(receipt(SECOND, { from: OTHER })); await connection.reconcilePending(vi.fn());
    expect(mocks.wait.mock.calls.at(-1)?.[0].hash).toBe(SECOND);
    expect(sessionStorage.getItem(pendingKey(OTHER))).toBeNull(); expect(sessionStorage.getItem(pendingKey(LENDER))).toBe(ORIGINAL);
    connection.account = LENDER; await connection.reconcilePending(vi.fn());
    expect(mocks.wait.mock.calls.at(-1)?.[0].hash).toBe(ORIGINAL); expect(sessionStorage.getItem(pendingKey(LENDER))).toBeNull();
  });
  it.each([null, OTHER])("persists the broadcast origin after account changes to %s before hash arrives", async changedAccount => {
    const connection = client(); let deliverHash!: (hash: Hex) => void;
    mocks.write.mockImplementationOnce(() => new Promise<Hex>(resolve => { deliverHash = resolve; }));
    mocks.wait.mockRejectedValueOnce(new Error("Timed out"));
    const operation = connection.cancel(provider, 1n, vi.fn());
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
    connection.account = changedAccount; deliverHash(ORIGINAL);
    await expect(operation).rejects.toThrow(/Timed out/);
    expect(sessionStorage.getItem(pendingKey(LENDER))).toBe(ORIGINAL);
    expect(sessionStorage.getItem(`turret:p2p:pending:31337:${CONTRACT}:${changedAccount}`)).toBeNull();
  });
  it("does not continue from A's approval after the client and wallet reconnect as B", async () => {
    acceptance(); const connection = client(); let walletAccount = LENDER;
    const changingProvider = { request: async ({ method }: { method: string }) => method === "eth_chainId" ? "0x7a69" : [walletAccount] } as EIP1193Provider;
    mocks.wait.mockImplementationOnce(async () => { connection.account = OTHER; walletAccount = OTHER; return receipt(); });
    await expect(connection.accept(changingProvider, 1n, vi.fn())).rejects.toThrow(/wallet account changed/);
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.simulate).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(pendingKey(LENDER))).toBeNull();
  });
});

describe("concurrent recovery cannot replace a newer pending transaction", () => {
  it("persists the requested call before metadata arrives and rejects an altered original after timeout and reopen", async () => {
    const connection = client(); let finishLookup!: (value: Transaction) => void;
    const lookup = vi.fn(() => new Promise<Transaction>(resolve => { finishLookup = resolve; }));
    Object.assign(connection.publicClient, { getTransaction: lookup });
    mocks.wait.mockRejectedValueOnce(new Error("Receipt timed out"));
    const action = connection.cancel(provider, 1n, vi.fn()).then(() => null, error => error as Error);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    const input = encodeFunctionData({ abi: p2pAbi, functionName: "cancelOffer", args: [1n] });
    expect(loadPendingRecord(pendingKey())?.requested).toEqual({ from: LENDER, to: CONTRACT, input, value: "0" });
    expect(loadPendingRecord(pendingKey())?.intent).toBeUndefined();
    const altered = transaction(ORIGINAL, { to: OTHER, input: "0xabcd", value: 12n, blockNumber: 10n });
    finishLookup(altered);
    expect((await action)?.message).toBe("Receipt timed out");
    expect(loadPendingRecord(pendingKey())?.intent).toMatchObject({ nonce: 7, to: CONTRACT, input, value: "0" });
    sessionStorage.clear();
    const reopened = client(), stages = vi.fn();
    mocks.block.mockResolvedValue({ number: 10n, hash: BLOCK, transactions: [ORIGINAL] });
    Object.assign(reopened.publicClient, { getTransaction: vi.fn().mockResolvedValue(altered),
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt(ORIGINAL, { to: OTHER })) });
    await expect(reopened.reconcilePending(stages)).rejects.toThrow("replaced by a different transaction");
    expect(stages.mock.calls.some(([stage]) => stage.status === "confirmed")).toBe(false);
    expect(loadPendingRecord(pendingKey())).toBeNull();
  });
  it("deduplicates overlapping automatic reconciliation for the same wallet and hash", async () => {
    savePending(pendingKey(), ORIGINAL);
    const connection = client(); let finish!: (value: TransactionReceipt) => void;
    mocks.wait.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = connection.reconcilePending(vi.fn()), second = connection.reconcilePending(vi.fn());
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());
    finish(receipt());
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(loadPendingRecord(pendingKey())).toBeNull();
  });
  it("a slow old metadata lookup cannot overwrite the next broadcast after another client resolves it", async () => {
    savePending(pendingKey(), ORIGINAL);
    const slow = client(), fast = client();
    let finishLookup!: (value: Transaction) => void;
    const lookup = vi.fn(() => new Promise<Transaction>(resolve => { finishLookup = resolve; }));
    Object.assign(slow.publicClient, { getTransaction: lookup });
    const staleStage = vi.fn();
    const stale = slow.reconcilePending(staleStage).then(() => null, error => error as Error);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    // A second client/tab completes the old nonce while the first is awaiting its RPC.
    expect(await fast.reconcilePending(vi.fn())).toBe(true);
    mocks.write.mockResolvedValueOnce(SECOND);
    mocks.wait.mockRejectedValueOnce(new Error("New transaction still pending"));
    await expect(fast.cancel(provider, 2n, vi.fn())).rejects.toThrow("New transaction still pending");
    expect(loadPendingRecord(pendingKey())?.hash).toBe(SECOND);
    finishLookup(transaction(ORIGINAL, { blockNumber: 10n }));
    expect((await stale)?.message).toMatch(/record changed/);
    expect(loadPendingRecord(pendingKey())?.hash).toBe(SECOND);
    expect(loadPendingRecord(pendingKey())?.intent).toBeUndefined();
    expect(sessionStorage.getItem(pendingKey())).toBe(SECOND);
    expect(slow.verify).not.toHaveBeenCalled();
    expect(mocks.wait).toHaveBeenCalledTimes(2);
    expect(staleStage.mock.calls.some(([stage]) => stage.status === "confirmed")).toBe(false);
  });
  it("a late recovered receipt neither clears a new record nor reports it confirmed", async () => {
    savePending(pendingKey(), ORIGINAL);
    const connection = client(); let finish!: (value: TransactionReceipt) => void;
    mocks.wait.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const stage = vi.fn(), old = connection.reconcilePending(stage).then(() => null, error => error as Error);
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce());
    savePending(pendingKey(), SECOND);
    finish(receipt());
    expect((await old)?.message).toMatch(/record changed/);
    expect(loadPendingRecord(pendingKey())?.hash).toBe(SECOND);
    expect(stage.mock.calls.some(([value]) => value.status === "confirmed")).toBe(false);
  });
});

it("revalidates offchain replacement consent after transaction simulation and before wallet submission", async () => {
  const connection = client();
  const gate = vi.fn().mockRejectedValue(new Error("Agreement withdrawn"));
  const progress = vi.fn();
  await expect((connection as any).write(provider, "createOffer", [OTHER, 25_000000n, 2n, 0n, 604800n, 2000n], progress, undefined, gate)).rejects.toThrow("Agreement withdrawn");
  expect(mocks.simulate).toHaveBeenCalledOnce();
  expect(gate).toHaveBeenCalledOnce();
  expect(mocks.write).not.toHaveBeenCalled();
});
