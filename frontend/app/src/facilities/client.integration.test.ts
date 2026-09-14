import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createPublicClient, createWalletClient, http, keccak256, type Address, type EIP1193Provider, type Hex } from "viem";
import { foundry } from "viem/chains";
import { captureTokenBaseline, type TokenBaseline } from "../p2p/health-core.mjs";
import { facilityAbi } from "../abi/TurretLenderFacility";
import { FacilityClient } from "./client";
import { quoteTypedData, ZERO_ADDRESS, ZERO_HASH, type FacilityLimits, type SignedQuote } from "./quotes.mjs";
import type { FacilityEntry } from "./reader.mjs";
import { loadPendingRecord } from "../p2p/pending-transactions";
import type { FacilityStage } from "./wallet-transactions";

let child: ChildProcess, url: string, rpc: ReturnType<typeof createPublicClient>;
let lender: Address, borrower: Address, fees: Address, selected: Address;
let token: any, entry: FacilityEntry, baseline: TokenBaseline, app: FacilityClient;
const progress: FacilityStage[] = [];
const stage = (value: FacilityStage) => { progress.push(value); };
const wallet = (account: Address) => createWalletClient({ account, chain: foundry, transport: http(url) });
const artifact = async (file: string, name = file) => JSON.parse(await readFile(new URL(`../../../../contracts/p2p/out/${file}.sol/${name}.json`, import.meta.url), "utf8"));
const provider = { request: async (request: { method: string; params?: unknown }) => {
  if (request.method === "eth_accounts" || request.method === "eth_requestAccounts") return [selected];
  return rpc.request(request as never);
} } as EIP1193Provider;
const receipt = async (hash: Hex) => { const result = await rpc.waitForTransactionReceipt({ hash }); expect(result.status).toBe("success"); return result; };
const write = async (account: Address, address: Address, abi: any, functionName: string, args: readonly unknown[] = []) => receipt(await wallet(account).writeContract({ address, abi, functionName, args }));
const limits: FacilityLimits = { maxExposure: 500_000000n, minDraw: 1_000000n, maxDraw: 300_000000n, minDuration: 86400n, maxDuration: 2592000n,
  maxQuoteLifetime: 3600n, minCollateralPerPrincipalWad: 10n ** 30n, minInterestBps: 100n };
const newClient = (qualification = baseline, client = rpc) => new FacilityClient({ entry, baseline: qualification, client, chain: foundry, getAccount: () => selected });
const quote = async (nonce: number): Promise<SignedQuote> => {
  const block = await rpc.getBlock();
  const e: SignedQuote = { schemaVersion: 1, chainId: 31337, facility: entry.address, signature: "0x", quote: {
    epoch: String(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "epoch" })), nonce: String(nonce), borrower: ZERO_ADDRESS,
    capacity: "300000000", minDraw: "1000000", collateralForCapacity: "600000000000000000000", interestForCapacity: "30000000", duration: "604800",
    validAfter: String(block.timestamp), expiresAt: String(block.timestamp + 1800n),
  } };
  e.signature = await wallet(lender).signTypedData(quoteTypedData(e)); return e;
};

beforeAll(async () => {
  const storage = () => { const values = new Map<string, string>(); return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(),
  }; };
  const local = storage(); vi.stubGlobal("window", { localStorage: local }); vi.stubGlobal("localStorage", local); vi.stubGlobal("sessionStorage", storage());
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  child = spawn(`${homedir()}/.foundry/bin/anvil`, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  url = `http://127.0.0.1:${port}`; rpc = createPublicClient({ chain: foundry, transport: http(url, { retryCount: 0 }), pollingInterval: 10 });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = await rpc.getChainId() === 31337; } catch {} if (ready) break; await new Promise(r => setTimeout(r, 30)); }
  expect(ready).toBe(true); expect(await rpc.request({ method: "web3_clientVersion" })).toMatch(/anvil/i);
  [lender, borrower, fees] = await createWalletClient({ chain: foundry, transport: http(url) }).getAddresses() as [Address, Address, Address];
  token = await artifact("V3TestSupport", "V3TestToken");
}, 20_000);
afterAll(async () => { if (child?.exitCode === null) { const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await closed; } vi.unstubAllGlobals(); });
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear(); progress.length = 0; selected = lender;
  const deploy = async (art: any, args: readonly unknown[]) => (await receipt(await wallet(lender).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [...args] }))).contractAddress!;
  const loanToken = await deploy(token, ["USDG", 6]), collateralToken = await deploy(token, ["MEME", 18]);
  const facility = await artifact("TurretLenderFacility");
  expect(facilityAbi).toEqual(facility.abi);
  const address = await deploy(facility, [loanToken, collateralToken, lender, fees, 1000n, limits]);
  const vaultImplementation = await rpc.readContract({ address, abi: facilityAbi, functionName: "vaultImplementation" });
  entry = { chainId: 31337, address, lender, loanToken, collateralToken, feeRecipient: fees, feeBps: "1000", vaultImplementation,
    runtimeHash: keccak256((await rpc.getCode({ address }))!), vaultImplementationHash: keccak256((await rpc.getCode({ address: vaultImplementation }))!) };
  const block = await rpc.getBlock();
  baseline = { schemaVersion: 1, chainId: 31337, blockNumber: String(block.number), blockHash: block.hash!,
    tokens: await Promise.all([loanToken, collateralToken].map(address => captureTokenBaseline(rpc, address, block, entry.address))) };
  for (const account of [lender, borrower]) {
    await write(lender, loanToken, token.abi, "mint", [account, 1000_000000n]);
    await write(lender, collateralToken, token.abi, "mint", [account, 2000n * 10n ** 18n]);
  }
  app = newClient(); await app.deposit(provider, 500_000000n, stage); selected = borrower;
});

it("wallet lifecycle: deposit, review, exact approval, draw, repay, collateral withdrawal, recycling and fee collection", async () => {
  expect(await app.fundingState()).toMatchObject({ idleCash: 500_000000n, cash: 500_000000n, activePrincipal: 0n, paused: false });
  expect(await app.loanPage(borrower)).toEqual({ rows: [], checked: 0, nextCursor: null });
  const review = await app.reviewDraw(await quote(1), 100_000000n);
  expect(review.collateral).toBe(200n * 10n ** 18n); expect(review.repayment).toBe(110_000000n);
  const hash = await app.draw(provider, review, stage); expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(loadPendingRecord(app.transactions.key(borrower))).toBeNull();
  expect((await app.loan(1n)).borrower.toLowerCase()).toBe(borrower.toLowerCase());
  expect(await app.fundingState()).toMatchObject({ idleCash: 400_000000n, activePrincipal: 100_000000n });
  expect((await app.loanPage(borrower)).rows).toMatchObject([{ id: 1n, principal: 100_000000n, status: 1 }]);
  expect((await app.loanPage(lender)).rows).toHaveLength(1);
  expect((await app.loanPage(fees)).rows).toEqual([]);
  expect(await rpc.readContract({ address: entry.collateralToken, abi: token.abi, functionName: "allowance", args: [borrower, entry.address] })).toBe(0n);
  await app.repay(provider, 1n, stage);
  await app.withdrawCollateral(provider, 1n, review.collateral, borrower, stage);
  await app.recycleRepayment(provider, 1n, stage); await app.collectFee(provider, 1n, stage);
  expect((await app.loan(1n)).status).toBe(2);
  expect((await app.loanPage(borrower)).rows[0]?.status).toBe(2);
  expect(await app.fundingState()).toMatchObject({ idleCash: 509_000000n, activePrincipal: 0n });
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "idleCash" })).toBe(509_000000n);
  expect(await rpc.readContract({ address: entry.loanToken, abi: token.abi, functionName: "balanceOf", args: [fees] })).toBe(1_000000n);
  expect(progress.some(s => s.status === "signature")).toBe(true); expect(progress.at(-1)?.status).toBe("confirmed");
});

it("funding, loan pages and extension reads reject a block replaced during the read", async () => {
  for (const name of ["idleCash", "nextLoanId", "extensions"]) {
    let changed = false;
    const client = newClient(baseline, { ...rpc,
      readContract: async (args: any) => { const result = await rpc.readContract(args); if (args.functionName === name) changed = true; return result; },
      getBlock: async (args: any) => { const block = await rpc.getBlock(args); return changed && args?.blockNumber !== undefined ? { ...block, hash: ZERO_HASH } : block; },
    } as typeof rpc);
    await expect(name === "idleCash" ? client.fundingState() : name === "nextLoanId" ? client.loanPage(borrower) : client.extension(1n)).rejects.toThrow(/chain changed/);
  }
});
it("clears excess allowance before exact approval and stops revoked quotes after approval", async () => {
  const e = await quote(2); await write(borrower, entry.collateralToken, token.abi, "approve", [entry.address, 999n * 10n ** 18n]);
  const review = await app.reviewDraw(e, 100_000000n);
  let cancelled = false;
  const hooked = { request: async (request: any) => {
    const result = await provider.request(request);
    if (request.method === "eth_sendTransaction" && !cancelled) { cancelled = true; await receipt(result as Hex); await write(lender, entry.address, facilityAbi, "cancelQuote", [2n]); }
    return result;
  } } as EIP1193Provider;
  await expect(app.draw(hooked, review, stage)).rejects.toThrow(/revoked|cancelled|replaced/);
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(1n);
  expect(await rpc.readContract({ address: entry.collateralToken, abi: token.abi, functionName: "allowance", args: [borrower, entry.address] })).toBe(0n);
});
it("wallet account changes and altered review amounts cannot request a loan", async () => {
  const review = await app.reviewDraw(await quote(3), 100_000000n);
  selected = lender; await expect(app.draw(provider, review, stage)).rejects.toThrow(/current wallet/);
  selected = borrower; review.principal = 200_000000n; await expect(app.draw(provider, review, stage)).rejects.toThrow(/terms changed/);
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(1n);
});
it("repayment and collateral recovery remain usable when new loans are paused or token qualification changes", async () => {
  const review = await app.reviewDraw(await quote(4), 100_000000n); await app.draw(provider, review, stage);
  selected = lender; await app.pause(provider, true, stage); selected = borrower;
  const changed = structuredClone(baseline); changed.tokens[0]!.runtimeHash = ZERO_HASH;
  const exits = newClient(changed);
  await expect(exits.reviewDraw(await quote(5), 1_000000n)).rejects.toThrow(/Token code or configuration changed/);
  await exits.repay(provider, 1n, stage); await exits.withdrawCollateral(provider, 1n, review.collateral, borrower, stage);
  expect((await exits.loan(1n)).collateralCredit).toBe(0n);
});
it("a timed-out receipt stays durable and a fresh client reconciles it without broadcasting again", async () => {
  const e = await quote(6), brokenReads = { ...rpc, waitForTransactionReceipt: async () => { throw new Error("Receipt timeout"); } };
  const first = newClient(baseline, brokenReads as typeof rpc), review = await first.reviewDraw(e, 100_000000n);
  await expect(first.draw(provider, review, stage)).rejects.toThrow(/Receipt timeout/);
  expect(loadPendingRecord(first.transactions.key(borrower))).not.toBeNull();
  await expect(first.draw(provider, review, stage)).rejects.toThrow(/Review this loan/);
  const reopened = newClient(); expect(await reopened.transactions.reconcile(borrower, stage)).toBe(true);
  expect(loadPendingRecord(first.transactions.key(borrower))).toBeNull();
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(1n);
  const refreshed = await reopened.reviewDraw(e, 100_000000n); await reopened.draw(provider, refreshed, stage);
  expect((await reopened.loan(1n)).principal).toBe(100_000000n);
});

it("a confirmed draw with a lost receipt cannot reuse the same review to borrow twice", async () => {
  const e = await quote(15);
  await write(borrower, entry.collateralToken, token.abi, "approve", [entry.address, 200n * 10n ** 18n]);
  const delayed = newClient(baseline, { ...rpc, waitForTransactionReceipt: async () => { throw new Error("Lost draw receipt"); } } as typeof rpc);
  const review = await delayed.reviewDraw(e, 100_000000n);
  await expect(delayed.draw(provider, review, stage)).rejects.toThrow(/Lost draw receipt/);
  expect((await app.loan(1n)).principal).toBe(100_000000n);
  expect(await delayed.transactions.reconcile(borrower, stage)).toBe(true);
  await expect(delayed.draw(provider, review, stage)).rejects.toThrow(/Review this loan/);
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(2n);
});

it("a successful wallet transaction with different calldata is not reported as the requested action", async () => {
  const review = await app.reviewDraw(await quote(7), 100_000000n);
  const altered = { request: async (request: any) => {
    if (request.method === "eth_sendTransaction") {
      return rpc.request({ method: "eth_sendTransaction", params: [{ ...request.params[0], to: borrower, data: "0x", value: "0x0" }] } as never);
    }
    return provider.request(request);
  } } as EIP1193Provider;
  await expect(app.draw(altered, review, stage)).rejects.toThrow(/cancelled|different transaction/);
  expect(loadPendingRecord(app.transactions.key(borrower))).toBeNull();
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(1n);
});

it("two client instances cannot start parallel loans for the same facility and wallet", async () => {
  const e = await quote(16), second = newClient();
  const firstReview = await app.reviewDraw(e, 100_000000n), secondReview = await second.reviewDraw(e, 100_000000n);
  const [first, concurrent] = await Promise.allSettled([app.draw(provider, firstReview, stage), second.draw(provider, secondReview, stage)]);
  expect(first.status).toBe("fulfilled"); expect(concurrent.status).toBe("rejected");
  if (concurrent.status === "rejected") expect(concurrent.reason.message).toMatch(/already in progress|Another tab/);
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(2n);
});

it("changing wallets after broadcast retains the pending record under the original account", async () => {
  const review = await app.reviewDraw(await quote(8), 100_000000n);
  await expect(app.draw(provider, review, value => { stage(value); if (value.status === "pending") selected = lender; })).rejects.toThrow(/Wallet changed/);
  expect(loadPendingRecord(app.transactions.key(borrower))).not.toBeNull();
  expect(loadPendingRecord(app.transactions.key(lender))).toBeNull();
  selected = borrower; expect(await newClient().transactions.reconcile(borrower, stage)).toBe(true);
  expect(loadPendingRecord(app.transactions.key(borrower))).toBeNull();
  expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "nextLoanId" })).toBe(1n);
});

it("the wrong wallet chain stops before requesting any approval", async () => {
  const review = await app.reviewDraw(await quote(9), 100_000000n); let submissions = 0;
  const wrongChain = { request: async (request: any) => {
    if (request.method === "eth_chainId") return "0x1";
    if (request.method === "eth_sendTransaction") submissions++;
    return provider.request(request);
  } } as EIP1193Provider;
  await expect(app.draw(wrongChain, review, stage)).rejects.toThrow(/Switch your wallet/); expect(submissions).toBe(0);
});

it("the lender reviews and signs an executable quote; other wallets cannot issue one", async () => {
  const terms = (await quote(10)).quote;
  await expect(app.reviewQuote(terms)).rejects.toThrow(/Only the lender/);
  selected = lender;
  const review = await app.reviewQuote(terms); expect(review.idleCash).toBe(500_000000n);
  const signed = await app.signQuote(provider, review, stage);
  selected = borrower; const draw = await app.reviewDraw(signed, 1_000000n); await app.draw(provider, draw, stage);
  expect((await app.loan(1n)).principal).toBe(1_000000n);
});

it("quote terms must meet the lender policy even when lending is paused", async () => {
  selected = lender; await app.pause(provider, true, stage);
  const terms = (await quote(11)).quote;
  await expect(app.reviewQuote({ ...terms, interestForCapacity: "0" })).rejects.toThrow(/policy/);
  const review = await app.reviewQuote(terms); expect(review.paused).toBe(true);
  const signed = await app.signQuote(provider, review, stage);
  selected = borrower; await expect(app.reviewDraw(signed, 1_000000n)).rejects.toThrow(/paused/);
});

it("both parties explicitly agree to an extension and fixed repayment remains unchanged", async () => {
  const review = await app.reviewDraw(await quote(12), 100_000000n); await app.draw(provider, review, stage);
  const loan = await app.loan(1n), oldDeadline = loan.dueAt + 86400n, newDeadline = oldDeadline + 2n * 86400n;
  const expiresAt = (await rpc.getBlock()).timestamp + 600n;
  await app.proposeExtension(provider, 1n, newDeadline, expiresAt, stage);
  selected = lender;
  await expect(app.acceptExtension(provider, 1n, 99n, oldDeadline, newDeadline, expiresAt, stage)).rejects.toThrow();
  await app.acceptExtension(provider, 1n, 1n, oldDeadline, newDeadline, expiresAt, stage);
  const extended = await app.loan(1n); expect(extended.dueAt + 86400n).toBe(newDeadline); expect(extended.interest).toBe(10_000000n);
});

it("credit reads distinguish actual withdrawable USDG from nominal repayment after a vault loss", async () => {
  const review = await app.reviewDraw(await quote(13), 100_000000n); await app.draw(provider, review, stage); await app.repay(provider, 1n, stage);
  const loan = await app.loan(1n); await write(lender, entry.loanToken, token.abi, "removeBalance", [loan.vault, 20_000000n]);
  expect((await app.loan(1n)).lenderCredit).toBe(109_000000n);
  const credits = await app.loanCredits(1n); expect(credits.repayment).toBe(90_000000n); expect(credits.fee).toBe(0n);
  selected = lender; await app.withdrawRepayment(provider, 1n, credits.repayment!, lender, stage); await app.writeOffRepayment(provider, 1n, stage);
  expect((await app.loan(1n)).lenderCredit).toBe(0n);
  selected = borrower; await app.withdrawCollateral(provider, 1n, review.collateral, borrower, stage);
});

it("overdue collateral goes to the lender and default exposure clears only after explicit acknowledgement", async () => {
  const review = await app.reviewDraw(await quote(14), 100_000000n); await app.draw(provider, review, stage);
  const snapshot = await rpc.request({ method: "evm_snapshot" } as never);
  try {
    await rpc.request({ method: "evm_increaseTime", params: [8 * 86400 + 1] } as never); await rpc.request({ method: "evm_mine" } as never);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Number((await rpc.getBlock()).timestamp) * 1000);
    await app.claimDefault(provider, 1n, stage);
    await expect(app.withdrawCollateral(provider, 1n, review.collateral, borrower, stage)).rejects.toThrow();
    selected = lender;
    await expect(app.acknowledgeDefault(provider, 1n, stage)).rejects.toThrow();
    await app.withdrawCollateral(provider, 1n, review.collateral, lender, stage);
    await app.acknowledgeDefault(provider, 1n, stage);
    expect((await app.loan(1n)).defaultAcknowledged).toBe(true);
    expect(await rpc.readContract({ address: entry.address, abi: facilityAbi, functionName: "unresolvedDefaultPrincipal" })).toBe(0n);
  } finally { vi.useRealTimers(); await rpc.request({ method: "evm_revert", params: [snapshot] } as never); }
});
