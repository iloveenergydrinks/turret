import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPublicClient, createTestClient, createWalletClient, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { foundry } from "viem/chains";
import { activityCsv, readP2PActivity, type ActivityClient } from "./activity";
import type { Deployment } from "./client";
import { recoverPendingTransaction } from "./pending-recovery";
import type { PendingRecord } from "./pending-transactions";

// This suite creates its own disposable chain. No configured RPC or signing key is read.
const root = fileURLToPath(new URL("../../../../contracts/p2p/", import.meta.url));
let process: ChildProcess | undefined;
let url: string, guardian: Address, lender: Address, borrower: Address, recipient: Address;
let rpc: ReturnType<typeof createPublicClient>;
const chain = foundry;
let token: { abi: any; bytecode: { object: Hex } }, loanToken: Address, collateralToken: Address;
const artifact = async (name: string) => JSON.parse(await readFile(`${root}out/${name}.sol/${name}.json`, "utf8"));
const wallet = (account: Address) => createWalletClient({ account, chain, transport: http(url, { retryCount: 0 }) });
async function deploy(code: { abi: any; bytecode: { object: Hex } }, args: any[]) {
  const hash = await wallet(guardian).deployContract({ abi: code.abi, bytecode: code.bytecode.object, args });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success"); return { address: receipt.contractAddress!, block: receipt.blockNumber };
}
async function send(account: Address, address: Address, abi: any, functionName: string, args: any[]) {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args });
  const receipt = await rpc.waitForTransactionReceipt({ hash }); expect(receipt.status).toBe("success"); return receipt;
}

beforeAll(async () => {
  await promisify(execFile)(`${homedir()}/.foundry/bin/forge`, ["build", "--root", root, "--skip", "test"], { timeout: 90_000 });
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
  process = spawn(`${homedir()}/.foundry/bin/anvil`, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  url = `http://127.0.0.1:${port}`;
  rpc = createPublicClient({ chain, transport: http(url, { retryCount: 0 }), pollingInterval: 10 });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = await rpc.getChainId() === 31337; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  expect(ready).toBe(true);
  expect(await rpc.request({ method: "web3_clientVersion" })).toMatch(/anvil/i);
  const accounts = await createWalletClient({ chain, transport: http(url) }).getAddresses();
  [guardian, lender, borrower, recipient] = accounts.map(account => getAddress(account)) as [Address, Address, Address, Address];
  token = await artifact("LocalToken");
  loanToken = (await deploy(token, ["Test USDG", "USDG", 6])).address;
  collateralToken = (await deploy(token, ["Test collateral", "SLV", 18])).address;
  for (const account of [lender, borrower]) {
    await send(guardian, loanToken, token.abi, "mint", [account, 10_000_000_000n]);
    await send(guardian, collateralToken, token.abi, "mint", [account, 1_000n * 10n ** 18n]);
  }
}, 120_000);

afterAll(async () => {
  if (process && process.exitCode === null) {
    const closed = new Promise<void>(resolve => process!.once("exit", () => resolve())); process.kill("SIGTERM"); await closed;
  }
});

it.each([1, 2, 3] as const)("reconstructs actual V%s lifecycle, repayment and recipient withdrawals after a fresh reader reload", async version => {
  const code = await artifact(version === 1 ? "TurretP2PLending" : `TurretP2PLendingV${version}`);
  const deployment = await deploy(code, version === 1 ? [loanToken, collateralToken, guardian, 1_000_000_000n, 10_000_000_000n, [lender]] : [loanToken, collateralToken, guardian]);
  const runtime = await rpc.getCode({ address: deployment.address });
  const config = { version, chainId: 31337, chainName: "Activity local test", rpcUrl: url, address: deployment.address,
    loanToken, collateralToken, loanSymbol: "USDG", collateralSymbol: "SLV", loanDecimals: 6, collateralDecimals: 18,
    startBlock: String(deployment.block), runtimeHash: keccak256(runtime!) } satisfies Deployment;
  const freshClient = (): ActivityClient => ({ config, publicClient: rpc, verify: async () => {
    expect(await rpc.getChainId()).toBe(31337); const block = await rpc.getBlock();
    expect(keccak256((await rpc.getCode({ address: config.address, blockNumber: block.number }))!)).toBe(config.runtimeHash);
    return { ...block, number: block.number!, hash: block.hash! };
  } });
  const act = (account: Address, fn: string, args: any[]) => send(account, config.address, code.abi, fn, args);
  for (const account of [lender, borrower]) for (const address of [loanToken, collateralToken]) await send(account, address, token.abi, "approve", [config.address, 1_000n * 10n ** 18n]);
  const create = async (account: Address, target: Address, principal: bigint) => {
    const now = (await rpc.getBlock()).timestamp;
    await act(account, "createOffer", [target, principal, 5n * 10n ** 18n, 2_000_000n, 7n * 86400n, now + 1800n]);
  };
  await create(lender, borrower, 100_000_000n);
  await act(lender, "cancelOffer", [1n]);
  const withdrawn = await act(lender, version === 3 ? "withdrawCredit" : "withdraw", version === 3
    ? [1n, loanToken, 40_000_000n, recipient] : [loanToken, 40_000_000n, recipient]);
  await create(lender, borrower, 100_000_000n);
  await act(borrower, "acceptOffer", [2n]);
  if (version === 3) {
    await create(borrower, lender, 50_000_000n);
    await act(borrower, "cancelOffer", [3n]);
    await act(borrower, "repayWithCredits", [2n, [3n], [50_000_000n], 52_000_000n]);
    await act(lender, "withdrawCredit", [2n, loanToken, 102_000_000n, lender]);
  } else {
    await act(borrower, "repay", [2n]);
    await act(lender, "withdraw", [loanToken, 162_000_000n, lender]);
  }
  const first = await readP2PActivity(freshClient(), lender);
  expect(first.next).toBeNull();
  expect(first.entries.find(e => e.transactionHash === withdrawn.transactionHash && e.action === "Funds withdrawn"))
    .toMatchObject({ amount: 40_000_000n, recipient });
  expect(first.entries.filter(e => e.action === "Funds withdrawn")).toHaveLength(2);
  expect(first.entries.find(e => e.action === "Repayment settled")).toMatchObject({ amount: 102_000_000n, actor: borrower });
  const reloaded = await readP2PActivity(freshClient(), lender);
  expect(reloaded.entries).toEqual(first.entries);
  const receiver = await readP2PActivity(freshClient(), recipient);
  expect(receiver.entries).toHaveLength(1); expect(receiver.entries[0]!.amount).toBe(40_000_000n);
  const borrowerHistory = await readP2PActivity(freshClient(), borrower);
  if (version === 3) expect(borrowerHistory.entries.find(e => e.action === "Credit used for repayment"))
    .toMatchObject({ amount: 50_000_000n, loanId: 3n });
  expect(activityCsv(first.entries, lender)).toContain(withdrawn.transactionHash);
}, 60_000);

it.each(["repriced", "cancelled", "changed"] as const)("recovers an actual mined %s transaction after the original hash disappears and 100 blocks pass", async kind => {
  const test = createTestClient({ chain, mode: "anvil", transport: http(url) });
  await test.setAutomine(false);
  try {
    const nonce = await rpc.getTransactionCount({ address: lender, blockTag: "pending" });
    const submittedBlock = (await rpc.getBlock()).number!;
    const gasPrice = (await rpc.getGasPrice()) + 1_000_000_000n;
    const original = await wallet(lender).sendTransaction({ to: recipient, value: 1n, nonce, gas: 21_000n, gasPrice });
    const record: PendingRecord = { version: 2, hash: original, savedAt: Date.now(), intent: {
      from: lender, nonce, to: recipient, input: "0x", value: "1", submittedBlock: submittedBlock.toString(),
    } };
    const replacement = await wallet(lender).sendTransaction({ to: kind === "cancelled" ? lender : recipient,
      value: kind === "cancelled" ? 0n : kind === "changed" ? 2n : 1n, nonce, gas: 21_000n, gasPrice: gasPrice * 2n });
    await test.mine({ blocks: 1 });
    await test.setAutomine(true); await test.mine({ blocks: 100 });
    await expect(rpc.getTransactionReceipt({ hash: original })).rejects.toThrow();
    const reopened = await recoverPendingTransaction(rpc, JSON.parse(JSON.stringify(record)) as PendingRecord, lender);
    expect(reopened).toMatchObject({ hash: replacement, equivalent: kind === "repriced", cancelled: kind === "cancelled" });
    const explicit = await recoverPendingTransaction(rpc, record, lender, { replacementHash: replacement });
    expect(explicit).toEqual(reopened);
  } finally { await test.setAutomine(true); }
}, 30_000);
