import { createWalletClient, custom, encodeFunctionData, parseAbi, type Abi, type Address, type Chain, type EIP1193Provider, type Hex, type createPublicClient } from "viem";
import { clearPending, loadPendingRecord, requirePendingStorage, savePending, updatePendingIntent, type PendingCall } from "../p2p/pending-transactions";
import { recoverPendingTransaction } from "../p2p/pending-recovery";
import { same } from "./quotes.mjs";

export type FacilityStage = { status: "checking" | "signature" | "pending" | "confirmed"; message: string; hash?: Hex };
export type FacilityProgress = (stage: FacilityStage) => void;
export type FacilityPublicClient = ReturnType<typeof createPublicClient>;
type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; label: string };
const tokenAbi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const active = new Set<string>();

/** Wallet-only transport. No keys, automated signing, silent retries or optimistic success. */
export class FacilityTransactions {
  constructor(readonly options: { address: Address; chain: Chain; client: FacilityPublicClient; getAccount: () => Address | null; verify: () => Promise<void> }) {}
  key(account: Address) { return `turret:facility:pending:${this.options.chain.id}:${this.options.address}:${account}`.toLowerCase(); }
  async assertWallet(provider: EIP1193Provider, account: Address) {
    const [accounts, chain] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
    if (!same(this.options.getAccount(), account) || !same(accounts[0], account)) throw new Error("Your wallet account changed. Review the action again.");
    if (Number(chain) !== this.options.chain.id) throw new Error(`Switch your wallet to ${this.options.chain.name} (${this.options.chain.id}).`);
  }
  private async capture(account: Address, hash: Hex) {
    const key = this.key(account), record = loadPendingRecord(key);
    if (!record || record.hash !== hash || record.intent || !record.requested) return;
    try {
      const tx = await this.options.client.getTransaction({ hash });
      if (!same(tx.hash, hash) || !same(tx.from, account)) return;
      const block = tx.blockNumber ?? (await this.options.client.getBlock()).number;
      if (block === null) return;
      updatePendingIntent(key, hash, { ...record.requested, nonce: tx.nonce, submittedBlock: String(block) });
    } catch { /* The durable hash and requested call remain available for another status check. */ }
  }
  async reconcile(account: Address, progress: FacilityProgress, replacementHash?: Hex) {
    const key = this.key(account), record = loadPendingRecord(key);
    if (!record) return false;
    progress({ status: "checking", hash: record.hash, message: "Checking your previous transaction…" });
    await this.options.verify();
    await this.capture(account, record.hash);
    const current = loadPendingRecord(key);
    if (!current || current.hash !== record.hash) throw new Error("The saved transaction changed. Refresh its status.");
    if (!current.intent) throw new Error("Your previous transaction is saved, but its nonce is not available yet. Check its status again before submitting another action.");
    const found = await recoverPendingTransaction(this.options.client, current, account, { replacementHash, getAccount: this.options.getAccount });
    if (!found) throw new Error("Your previous transaction is still pending. Confirm or cancel it in your wallet, then check its status again.");
    if (loadPendingRecord(key)?.hash !== record.hash) throw new Error("The saved transaction changed while checking confirmation.");
    clearPending(key, record.hash);
    if (!found.equivalent) throw new Error(found.cancelled ? "The transaction was cancelled in your wallet." : "A different transaction replaced this action. Refresh your balances.");
    if (found.receipt.status !== "success") throw new Error("The transaction reverted. Its contract changes were not applied.");
    progress({ status: "confirmed", hash: found.hash, message: "Transaction confirmed." });
    return true;
  }
  private async send(provider: EIP1193Provider, account: Address, call: Call, progress: FacilityProgress) {
    await this.assertWallet(provider, account);
    const { request, result } = await this.options.client.simulateContract({ account, address: call.address, abi: call.abi, functionName: call.functionName, args: call.args });
    if (call.functionName === "approve" && result === false) throw new Error("The token rejected this approval.");
    await this.assertWallet(provider, account);
    const requested: PendingCall = { from: account, to: call.address, input: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }), value: "0" };
    progress({ status: "signature", message: `${call.label}: confirm in your wallet.` });
    const wallet = createWalletClient({ account, chain: this.options.chain, transport: custom(provider, { retryCount: 0 }) });
    const hash = await wallet.writeContract(request);
    // Save before callbacks or RPC work: timeouts and account changes must not erase a broadcast.
    savePending(this.key(account), hash, undefined, requested);
    progress({ status: "pending", hash, message: `${call.label} submitted. Waiting for confirmation…` });
    await this.capture(account, hash);
    const receipt = await this.options.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000,
      onReplaced: replacement => {
        const original = replacement.replacedTransaction;
        const record = loadPendingRecord(this.key(account));
        if (same(original.hash, hash) && same(original.from, account) && record?.hash === hash && record.requested && !record.intent) {
          updatePendingIntent(this.key(account), hash, { ...record.requested, nonce: original.nonce,
            submittedBlock: String(original.blockNumber ?? replacement.transactionReceipt.blockNumber) });
        }
      },
    });
    await this.reconcile(account, progress, receipt.transactionHash);
    await this.assertWallet(provider, account);
    return receipt.transactionHash;
  }
  async execute(provider: EIP1193Provider, account: Address, call: Call, progress: FacilityProgress, options: {
    check?: () => Promise<void>; approval?: { token: Address; amount: bigint };
  } = {}) {
    const key = this.key(account);
    const run = async () => {
      if (active.has(key)) throw new Error("A wallet action is already in progress for this facility.");
      active.add(key);
      try {
        await this.assertWallet(provider, account); requirePendingStorage();
        if (await this.reconcile(account, progress)) throw new Error("Your previous transaction is confirmed. Review updated balances before continuing.");
        const check = async () => { progress({ status: "checking", message: "Checking current contract state…" }); await this.options.verify(); await options.check?.(); await this.assertWallet(provider, account); };
        await check();
        if (options.approval) {
          const { token, amount } = options.approval;
          if (amount <= 0n) throw new Error("Approval amount must be positive.");
          const allowance = await this.options.client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account, this.options.address] });
          if (allowance !== amount) {
            for (const value of allowance === 0n ? [amount] : [0n, amount]) {
              await check();
              await this.send(provider, account, { address: token, abi: tokenAbi, functionName: "approve", args: [this.options.address, value], label: value === 0n ? "Clear previous allowance" : "Approve exact token amount" }, progress);
            }
          }
          const actual = await this.options.client.readContract({ address: token, abi: tokenAbi, functionName: "allowance", args: [account, this.options.address] });
          if (actual !== amount) throw new Error("The exact allowance was not confirmed. Refresh before continuing.");
        }
        await check();
        return await this.send(provider, account, call, progress);
      } finally { active.delete(key); }
    };
    // Web Locks prevent parallel tabs from opening duplicate wallet requests when supported.
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request(key, { ifAvailable: true }, lock => {
        if (!lock) throw new Error("Another tab is handling a transaction for this facility.");
        return run();
      });
    }
    return run();
  }
}
