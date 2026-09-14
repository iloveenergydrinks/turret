import { createPublicClient, http, decodeFunctionData, decodeEventLog, encodeFunctionData, erc20Abi, erc721Abi, isAddress, keccak256,
  formatUnits, type Address, type EIP1193Provider, type Hex } from "viem";
import { nftLendingAbi } from "./abi";
import { clearPending, loadPendingRecord, requirePendingStorage, savePending, updatePendingIntent } from "../p2p/pending-transactions";
import { recoverPendingTransaction } from "../p2p/pending-recovery";

export type NFTCollection = { address: Address; name: string; slug: string; image: string; enabled: boolean; reason?: string };
export type NFTConfig = { version: 1; chainId: number; address: Address; loanToken: Address; loanDecimals: number;
  runtimeHash: Hex; startBlock: string; collections: NFTCollection[]; rpcUrl: string };
export type NFTTerms = { borrower: Address; collection: Address; tokenId: bigint; principal: bigint;
  interest: bigint; duration: bigint; expiresAt: bigint };
export type NFTOffer = { id: bigint; lender: Address; terms: NFTTerms; vault: Address; dueAt: bigint;
  status: number; usdgCredit: bigint; nftBeneficiary: Address };
export const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const hashValid = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-f]{64}$/i.test(x);
const addr = (x: unknown): x is Address => typeof x === "string" && isAddress(x, { strict: false }) && !/^0x0{40}$/i.test(x);

export function validateNFTConfig(value: unknown): NFTConfig {
  const c = value as NFTConfig;
  if (!c || c.version !== 1 || !Number.isSafeInteger(c.chainId) || c.chainId < 1 || !addr(c.address) || !addr(c.loanToken)
    || same(c.address, c.loanToken) || c.loanDecimals !== 6 || !hashValid(c.runtimeHash)
    || !/^(0|[1-9][0-9]{0,19})$/.test(c.startBlock) || c.rpcUrl !== "/api/rpc"
    || !Array.isArray(c.collections) || !c.collections.length
    || c.collections.some(x => !addr(x.address) || typeof x.name !== "string" || !x.name || x.name.length > 100
      || !/^[a-z0-9-]{1,80}$/.test(x.slug) || typeof x.enabled !== "boolean")
    || new Set(c.collections.map(x => x.address.toLowerCase())).size !== c.collections.length) {
    throw Error("NFT deployment configuration is invalid. Transactions are disabled.");
  }
  return c;
}

export class NFTClient {
  readonly publicClient;
  private sending = false;
  constructor(readonly config: NFTConfig, rpc?: string) {
    validateNFTConfig(config);
    this.publicClient = createPublicClient({ transport: http(rpc ?? new URL(config.rpcUrl, window.location.origin).href,
      { retryCount: 1, timeout: 12_000, batch: { batchSize: 30, wait: 10 } }), pollingInterval: 1500 });
  }
  key(account: Address) { return `turret:nft:${this.config.chainId}:${this.config.address}:pending:${account}`.toLowerCase(); }
  pending(account: Address) { return loadPendingRecord(this.key(account)); }
  fundingKey(account: Address) { return `${this.key(account)}:funded`; }
  lastFunding(account: Address): { id: string; hash: Hex } | null {
    const raw = window.localStorage.getItem(this.fundingKey(account));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!/^[1-9][0-9]{0,77}$/.test(value.id) || !hashValid(value.hash)) throw Error("Saved deposit is unreadable. Check My loans before depositing again.");
    return value;
  }
  private recordFunding(account: Address, receipt: { transactionHash: Hex; logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] }) {
    for (const log of receipt.logs) {
      if (!same(log.address, this.config.address)) continue;
      let event;
      try { event = decodeEventLog({ abi: nftLendingAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }); }
      catch { continue; }
      if (event.eventName !== "OfferCreated" || !same(event.args.lender, account)) continue;
      const value = JSON.stringify({ id: String(event.args.id), hash: receipt.transactionHash });
      window.localStorage.setItem(this.fundingKey(account), value);
      if (window.localStorage.getItem(this.fundingKey(account)) !== value) throw Error("Deposit recovery could not be saved.");
      return event.args.id;
    }
    throw Error("Deposit confirmed but its offer ID could not be verified. Verify transaction before continuing.");
  }
  async existingFunding(account: Address, terms: NFTTerms) {
    const block = await this.verify();
    let cursor = 0n;
    for (;;) {
      const page = await this.accountOffers(account, cursor, block.number);
      const existing = page.offers.find(o => same(o.lender, account) && same(o.terms.collection, terms.collection)
        && o.terms.tokenId === terms.tokenId && (o.status === 1 || o.status === 2));
      if (existing) return existing;
      if (!page.more) return null;
      if (page.nextCursor <= cursor) throw Error("Could not verify your existing deposits. Refresh My loans.");
      cursor = page.nextCursor;
    }
  }
  async fundOffer(provider: EIP1193Provider, account: Address, terms: NFTTerms, onStatus: (text: string) => void) {
    onStatus("Checking your existing offers and NFT ownership…");
    const existing = await this.existingFunding(account, terms);
    if (existing) return { id: existing.id, existing: true };
    const owner = await this.publicClient.readContract({ address: terms.collection, abi: erc721Abi, functionName: "ownerOf", args: [terms.tokenId] });
    if (same(owner, account)) throw Error("You cannot lend to yourself. Choose an NFT owned by another wallet.");
    if (!same(terms.borrower, "0x0000000000000000000000000000000000000000") && !same(terms.borrower, owner)) throw Error("The listed borrower no longer owns this NFT.");
    // Name the current owner so their contract account index discovers the offer without a signed board link.
    const exact = { ...terms, borrower: owner };
    onStatus("Checking your USDG balance…");
    await this.requireUSDGBalance(account, terms.principal, "deposit this offer");
    await this.approveUSDG(provider, account, terms.principal, onStatus);
    const receipt = await this.send(provider, account, this.config.address, encodeFunctionData({ abi: nftLendingAbi, functionName: "createOffer", args: [exact] }), onStatus, "USDG deposit");
    // Use this receipt, never a last-result slot another tab could overwrite.
    for (const log of receipt.logs) {
      if (!same(log.address, this.config.address)) continue;
      try { const event = decodeEventLog({ abi: nftLendingAbi, data: log.data, topics: log.topics });
        if (event.eventName === "OfferCreated" && same(event.args.lender, account)) return { id: event.args.id, existing: false };
      } catch { /* Other event. */ }
    }
    throw Error("Check My loans to recover your confirmed deposit.");
  }
  async verify() {
    const c = this.config, p = this.publicClient;
    if (await p.getChainId() !== c.chainId) throw Error("NFT RPC is on the wrong chain.");
    const block = await p.getBlock();
    const [code, token, decimals] = await Promise.all([
      p.getCode({ address: c.address, blockNumber: block.number }),
      p.readContract({ address: c.address, abi: nftLendingAbi, functionName: "loanToken", blockNumber: block.number }),
      p.readContract({ address: c.loanToken, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
    ]);
    if (!code || !same(keccak256(code), c.runtimeHash) || !same(token, c.loanToken) || decimals !== c.loanDecimals) {
      throw Error("NFT deployment identity check failed. Transactions are disabled.");
    }
    if (!same((await p.getBlock({ blockNumber: block.number })).hash, block.hash)) throw Error("Chain changed during verification. Refresh.");
    return block;
  }
  async offer(id: bigint): Promise<NFTOffer> {
    if (id < 1n) throw Error("Invalid NFT offer ID.");
    const offer = await this.publicClient.readContract({ address: this.config.address, abi: nftLendingAbi, functionName: "getOffer", args: [id] });
    return { ...offer, id };
  }
  async accountOffers(account: Address, cursor = 0n, blockNumber?: bigint) {
    const [ids, nextCursor] = await this.publicClient.readContract({ address: this.config.address, abi: nftLendingAbi,
      functionName: "accountOffers", args: [account, cursor, 30n], blockNumber });
    return { offers: await this.batch(ids, blockNumber), nextCursor, more: ids.length === 30 };
  }
  async latestOffers(before?: bigint) {
    const end = before ?? await this.publicClient.readContract({ address: this.config.address, abi: nftLendingAbi, functionName: "nextOfferId" });
    const start = end > 21n ? end - 20n : 1n;
    const ids: bigint[] = [];
    for (let id = end - 1n; id >= start; id--) ids.push(id);
    return { offers: await this.batch(ids), nextCursor: start, more: start > 1n };
  }
  async batch(ids: readonly bigint[], blockNumber?: bigint): Promise<NFTOffer[]> {
    if (!ids.length) return [];
    const rows = await this.publicClient.readContract({ address: this.config.address, abi: nftLendingAbi,
      functionName: "getOfferBatch", args: [ids], blockNumber });
    if (rows.length !== ids.length) throw Error("NFT offer response is incomplete.");
    return rows.map((row, index) => ({ ...row, id: ids[index]! }));
  }
  async walletCheck(provider: EIP1193Provider, account: Address) {
    const [chain, accounts] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    if (Number(BigInt(chain)) !== this.config.chainId || !same(accounts[0], account)) throw Error("Wallet or network changed. Review again.");
  }
  async reconcile(account: Address, replacementHash?: Hex) {
    const record = this.pending(account);
    if (!record) return null;
    await this.verify();
    if (!record.intent) {
      const tx = await this.publicClient.getTransaction({ hash: record.hash });
      const call = record.requested;
      if (!call || !same(tx.from, call.from) || !same(tx.to, call.to) || !same(tx.input, call.input) || tx.value !== BigInt(call.value)) {
        throw Error("Saved transaction does not match the reviewed action. Check your wallet.");
      }
      updatePendingIntent(this.key(account), record.hash, { ...call, nonce: tx.nonce, submittedBlock: String(tx.blockNumber ?? 0n) });
    }
    const result = await recoverPendingTransaction(this.publicClient, this.pending(account)!, account, { replacementHash });
    if (result) {
      const input = record.intent?.input ?? record.requested?.input;
      let funding = false;
      try { funding = same(record.intent?.to ?? record.requested?.to, this.config.address)
        && decodeFunctionData({ abi: nftLendingAbi, data: input! }).functionName === "createOffer"; } catch { /* Other transaction. */ }
      if (funding && result.equivalent && result.receipt.status === "success") this.recordFunding(account, result.receipt);
      clearPending(this.key(account), record.hash);
    }
    return result;
  }
  async send(provider: EIP1193Provider, account: Address, to: Address, data: Hex, onStatus: (text: string) => void, label = "reviewed transaction") {
    onStatus(`Checking the ${label} before opening your wallet…`);
    if (this.sending) throw Error("Another wallet action is in progress.");
    if (!navigator.locks) throw Error("This browser cannot safely coordinate wallet actions across tabs. Use an up-to-date browser.");
    this.sending = true;
    try { return await navigator.locks.request(`${this.key(account)}:wallet`, { ifAvailable: true }, async lock => {
      if (!lock) throw Error("A wallet action is already running in another Turret tab. Finish it there first.");
      if (this.pending(account)) throw Error("Verify your pending transaction before submitting another.");
      requirePendingStorage();
      const block = await this.verify();
      await this.walletCheck(provider, account);
      await this.publicClient.call({ account, to, data, value: 0n });
      await this.walletCheck(provider, account);
      let fundingTerms: NFTTerms | undefined;
      try { const call = decodeFunctionData({ abi: nftLendingAbi, data });
        if (same(to, this.config.address) && call.functionName === "createOffer") fundingTerms = call.args[0];
      } catch { /* Other transaction. */ }
      if (fundingTerms) {
        const existing = await this.existingFunding(account, fundingTerms);
        if (existing) throw Error(`You already have offer #${existing.id} for this NFT. Open My loans; no additional USDG was deposited.`);
        const [latest, pending] = await Promise.all([
          this.publicClient.getTransactionCount({ address: account, blockTag: "latest" }),
          this.publicClient.getTransactionCount({ address: account, blockTag: "pending" }),
        ]);
        if (pending > latest) throw Error("Your wallet has an unconfirmed transaction. Wait for it to finish before depositing.");
        await this.walletCheck(provider, account);
      }
      onStatus(`Confirm the ${label} in your wallet.`);
      const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: account, to, data, value: "0x0" }] });
      if (!hashValid(hash)) throw Error("Wallet returned an invalid transaction hash.");
      const requested = { from: account, to, input: data, value: "0" };
      savePending(this.key(account), hash, undefined, requested);
      onStatus("Transaction submitted. Verifying its receipt…");
      const tx = await this.publicClient.getTransaction({ hash });
      if (!same(tx.from, account) || !same(tx.to, to) || !same(tx.input, data) || tx.value !== 0n) throw Error("Wallet transaction differs from the reviewed action.");
      updatePendingIntent(this.key(account), hash, { ...requested, nonce: tx.nonce, submittedBlock: String(block.number) });
      await this.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const result = await this.reconcile(account);
      if (!result) throw Error("Transaction is still pending. Use Verify transaction to check it.");
      if (!result.equivalent || result.receipt.status !== "success") throw Error("The reviewed transaction was replaced or reverted.");
      onStatus("Transaction confirmed.");
      return result.receipt;
    }); } finally { this.sending = false; }
  }
  async requireUSDGBalance(account: Address, amount: bigint, purpose: "deposit this offer" | "repay this loan") {
    const balance = await this.publicClient.readContract({ address: this.config.loanToken, abi: erc20Abi,
      functionName: "balanceOf", args: [account] });
    if (balance < amount) throw Error(`You need ${formatUnits(amount, 6)} USDG to ${purpose}. This wallet has ${formatUnits(balance, 6)} USDG on Robinhood Chain. Add USDG to this wallet, then try again.`);
  }
  async approveUSDG(provider: EIP1193Provider, account: Address, amount: bigint, onStatus: (text: string) => void) {
    onStatus("Checking USDG spending approval…");
    const current = await this.publicClient.readContract({ address: this.config.loanToken, abi: erc20Abi, functionName: "allowance", args: [account, this.config.address] });
    if (current >= amount) return;
    if (current !== 0n) await this.send(provider, account, this.config.loanToken,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.config.address, 0n] }), onStatus, "USDG approval reset");
    return this.send(provider, account, this.config.loanToken,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [this.config.address, amount] }), onStatus, "USDG spending approval");
  }
  async approveNFT(provider: EIP1193Provider, account: Address, collection: Address, tokenId: bigint, onStatus: (text: string) => void) {
    if (!this.config.collections.some(x => x.enabled && same(x.address, collection))) throw Error("Unsupported NFT collection.");
    const [owner, approved] = await Promise.all([
      this.publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "ownerOf", args: [tokenId] }),
      this.publicClient.readContract({ address: collection, abi: erc721Abi, functionName: "getApproved", args: [tokenId] }),
    ]);
    if (!same(owner, account)) throw Error("This wallet no longer owns the NFT.");
    if (same(approved, this.config.address)) return;
    return this.send(provider, account, collection,
      encodeFunctionData({ abi: erc721Abi, functionName: "approve", args: [this.config.address, tokenId] }), onStatus, "NFT transfer approval");
  }
}
