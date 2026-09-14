import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, defineChain, getAddress, http, isAddress,
  encodeFunctionData, keccak256, parseAbi, type Address, type EIP1193Provider, type Hex, type ReplacementReturnType, type Transaction,
} from "viem";
import { clearPending, loadPending, loadPendingRecord, requirePendingStorage, savePending, updatePendingIntent } from "./pending-transactions";
import { recoverPendingTransaction } from "./pending-recovery";
import { P2P_ASSETS, P2P_USDG } from "./asset-catalog";
import { readP2PHealth, type P2PHealth } from "./health";
import { readActiveLoans } from "./active-loans";
import { p2pV3Abi } from "../abi/TurretP2PV3";

export type Deployment = {
  chainId: 4663 | 31337; chainName: string; rpcUrl: string; address: Address;
  loanToken: Address; collateralToken: Address; loanSymbol: "USDG"; collateralSymbol: string;
  loanDecimals: 6; collateralDecimals: number; version?: 1 | 2 | 3; vaultImplementation?: Address; vaultImplementationHash?: Hex; collateralName?: string; legacy?: boolean; runtimeHash: Hex; startBlock: string;
};
export type LoanCredit = { beneficiary: Address; nominal: bigint; available: bigint; unavailable?: boolean };
export type ExtensionProposal = { proposer: Address; nonce: bigint; oldDeadline: number; newDeadline: number; expiresAt: number };
export type Loan = {
  id: bigint; isPublic: boolean; createdAt: number; lender: Address; borrower: Address; principal: bigint; collateral: bigint;
  interest: bigint; durationDays: number; expiresAt: number; dueAt: number;
  status: "open" | "active" | "repaid" | "claimed" | "cancelled" | "expired";
  repaymentDeadline?: number; vault?: Address; fundingAvailable?: bigint; collateralAvailable?: bigint;
  loanCredits?: { USDG: LoanCredit; COLLATERAL: LoanCredit }; extensionProposal?: ExtensionProposal;
};
export type Snapshot = {
  account: Address; now: number; blockNumber: bigint; approvedLender: boolean; paused: boolean;
  balances: { USDG: bigint; COLLATERAL: bigint }; credits: { USDG: bigint; COLLATERAL: bigint }; nativeBalance: bigint;
  offers: Loan[]; maxPrincipal: bigint | null; maxCommitted: bigint | null; committed: bigint; nextCursor: bigint | null;
  incomingOffers?: Loan[]; incomingNextCursor?: bigint | null; incomingOffersComplete?: boolean; incomingOffersMessage?: string;
  nominalCredits?: { USDG: bigint; COLLATERAL: bigint }; creditsComplete?: boolean;
  balancesUnavailable?: { USDG: boolean; COLLATERAL: boolean };
  health?: P2PHealth; activeLoansComplete?: boolean; activeLoansMessage?: string;
};
export type OfferPage = { offers: Loan[]; now: number; blockNumber: bigint; paused: boolean; nextCursor: bigint | null; health?: P2PHealth };
export type UnavailableAsset = { symbol: string; name: string; address: Address; reason: string };
export type P2PRegistry = { markets: Deployment[]; unavailableAssets: UnavailableAsset[] };
export type TransactionStage = { message: string; hash?: Hex; status: "signature" | "pending" | "confirmed" };
export type Terms = { borrower: Address; principal: bigint; collateral: bigint; interest: bigint; durationDays: number; expiresAt: number };
type Progress = (stage: TransactionStage) => void;
const previousP2PAbi = parseAbi([
  "function loanToken() view returns (address)", "function collateralToken() view returns (address)",
  "function permittedLenders(address) view returns (bool)", "function newLoansPaused() view returns (bool)",
  "function maxPrincipalPerLoan() view returns (uint256)", "function maxCommittedPrincipal() view returns (uint256)",
  "function committedPrincipal() view returns (uint256)", "function nextOfferId() view returns (uint256)",
  "function credits(address,address) view returns (uint256)",
  "function isPublicOffer(uint256) view returns (bool)", "function offerCreatedAt(uint256) view returns (uint64)",
  "function getAccountOfferIds(address,uint256,uint256) view returns (uint256[] ids,uint256 nextCursor)",
  "function getPublicOfferIds(uint256,uint256) view returns (uint256[] ids,uint256 nextCursor)",
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
  "function createOffer(address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt) returns (uint256)",
  "function acceptOffer(uint256)", "function cancelOffer(uint256)", "function expireOffer(uint256)",
  "function repay(uint256)", "function claimDefault(uint256)", "function withdraw(address,uint256,address)",
  "error InvalidConfiguration()", "error InvalidTerms()", "error NewLoansPaused()", "error Unauthorized()",
  "error WrongStatus()", "error OfferExpired()", "error TooEarly()", "error RepaymentDeadlinePassed()",
  "error ExposureLimit()", "error UnsupportedTransfer()", "error InvalidWithdrawal()", "error InvalidPagination()",
]);
export const p2pAbi = [...previousP2PAbi, ...p2pV3Abi] as const;
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)",
]);
const statuses: Loan["status"][] = ["open", "active", "repaid", "claimed", "cancelled", "expired"];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function validateDeployment(value: unknown, hostname = window.location.hostname): Deployment {
  const d = value as Partial<Deployment> | null;
  if (!d || ![4663, 31337].includes(d.chainId ?? 0) || typeof d.chainName !== "string" || !d.chainName.trim()
    || ![d.address, d.loanToken, d.collateralToken].every(a => typeof a === "string" && isAddress(a) && !/^0x0{40}$/i.test(a))
    || typeof d.runtimeHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(d.runtimeHash)
    || typeof d.rpcUrl !== "string" || !/^\/api\/[a-z0-9/-]+$/i.test(d.rpcUrl)
    || !/^\d+$/.test(d.startBlock ?? "") || d.loanDecimals !== 6
    || !Number.isInteger(d.collateralDecimals) || d.collateralDecimals! < 0 || d.collateralDecimals! > 36
    || d.loanSymbol !== "USDG" || typeof d.collateralSymbol !== "string" || !/^[A-Z0-9]{1,12}$/.test(d.collateralSymbol)
    || (d.version !== undefined && ![1, 2, 3].includes(d.version))
    || (d.collateralName !== undefined && (typeof d.collateralName !== "string" || d.collateralName.length > 100))
    || (d.legacy !== undefined && typeof d.legacy !== "boolean")) throw new Error("P2P deployment configuration is invalid. Lending is unavailable.");
  if (d.version === 3 && (typeof d.vaultImplementation !== "string" || !isAddress(d.vaultImplementation)
    || /^0x0{40}$/i.test(d.vaultImplementation) || typeof d.vaultImplementationHash !== "string"
    || !/^0x[0-9a-f]{64}$/i.test(d.vaultImplementationHash))) throw new Error("V3 vault implementation identity is missing or invalid.");
  if (d.chainId === 31337 && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new Error("A local-chain deployment cannot be used on this website.");
  if (same(d.loanToken!, d.collateralToken!)) throw new Error("Loan and collateral tokens must differ.");
  if ((d.version ?? 1) === 1 && (d.collateralSymbol !== "SLV" || d.collateralDecimals !== 18)) throw new Error("The legacy deployment must use SLV collateral.");
  if (d.chainId === 4663) {
    const asset = P2P_ASSETS.find(asset => asset.symbol === d.collateralSymbol && same(d.collateralToken!, asset.address));
    if (!same(d.loanToken!, P2P_USDG) || !asset || !same(d.collateralToken!, asset.address)) throw new Error("This deployment does not use the reviewed token identities.");
  }
  return d as Deployment;
}
export async function loadP2PDeployment(): Promise<Deployment> {
  const response = await fetch("/p2p-deployment.json", { cache: "no-store" });
  if (!response.ok) throw new Error("P2P lending has no verified deployment on this site yet.");
  return validateDeployment(await response.json());
}
export function validateP2PRegistry(value: unknown, hostname = window.location.hostname): P2PRegistry {
  const registry = value as { schemaVersion?: number; markets?: unknown[]; unavailableAssets?: unknown[] } | null;
  // One current market and one retained V2 market per asset, plus the original SLV pilot.
  if (!registry || registry.schemaVersion !== 2 || !Array.isArray(registry.markets) || registry.markets.length > P2P_ASSETS.length * 2 + 1
    || !Array.isArray(registry.unavailableAssets) || registry.unavailableAssets.length > P2P_ASSETS.length) throw new Error("P2P market configuration is invalid. Retry loading the verified markets.");
  const markets = registry.markets.map(m => validateDeployment(m, hostname));
  const contracts = new Set<string>(); const activeAssets = new Set<string>(); const retainedAssets = new Set<string>();
  for (const market of markets) {
    const key = `${market.chainId}:${market.address.toLowerCase()}`;
    if (contracts.has(key) || (markets[0] && (market.chainId !== markets[0].chainId || market.rpcUrl !== markets[0].rpcUrl))) throw new Error("P2P market identities overlap or use different networks.");
    contracts.add(key);
    if (market.legacy && market.version === 2) {
      if (retainedAssets.has(market.collateralSymbol)) throw new Error("Duplicate retained collateral market.");
      retainedAssets.add(market.collateralSymbol);
    } else if ((market.version ?? 1) >= 2) {
      if (activeAssets.has(market.collateralSymbol)) throw new Error("Duplicate active collateral market.");
      activeAssets.add(market.collateralSymbol);
    }
  }
  const unavailableAssets = registry.unavailableAssets.map(value => {
    const a = value as Partial<UnavailableAsset> | null;
    if (!a || typeof a.symbol !== "string" || typeof a.name !== "string" || typeof a.reason !== "string" || !a.reason.trim()
      || typeof a.address !== "string" || !isAddress(a.address) || activeAssets.has(a.symbol)) throw new Error("Unavailable asset details are invalid.");
    return a as UnavailableAsset;
  });
  if (!markets.length && !unavailableAssets.length) throw new Error("No verified P2P markets are configured yet.");
  return { markets, unavailableAssets };
}
export async function loadP2PRegistry(): Promise<P2PRegistry> {
  const response = await fetch("/p2p-markets.json", { cache: "no-store" });
  if (response.status === 404) return { markets: [{ ...await loadP2PDeployment(), legacy: true }], unavailableAssets: [] };
  if (!response.ok) throw new Error("Unable to load the P2P markets. Retry without submitting a transaction.");
  return validateP2PRegistry(await response.json());
}

export class P2PClient {
  readonly config: Deployment;
  readonly publicClient: ReturnType<typeof createPublicClient>;
  readonly chain;
  account: Address | null = null;
  private busy = false;
  private pendingHashes = new Map<string, Hex>();
  private pendingReconciliations = new Map<string, Promise<boolean>>();

  constructor(config: Deployment, sharedReads?: P2PClient) {
    this.config = validateDeployment(config);
    const rpc = new URL(config.rpcUrl, window.location.origin).href;
    this.chain = defineChain({ id: config.chainId, name: config.chainName,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    if (sharedReads && (sharedReads.config.chainId !== config.chainId || sharedReads.config.rpcUrl !== config.rpcUrl)) {
      throw new Error("P2P markets cannot share reads across different networks.");
    }
    // Share read transport only; accounts, pending receipts and write locks stay per market.
    // Match the RPC gateway's maximum of 50 requests per HTTP batch.
    this.publicClient = sharedReads?.publicClient ?? createPublicClient({ chain: this.chain,
      transport: http(rpc, { retryCount: 1, batch: { batchSize: 50, wait: 8 } }), pollingInterval: 1000 });
  }
  async verify() {
    const client = this.publicClient;
    if (await client.getChainId() !== this.config.chainId) throw new Error("The RPC is connected to the wrong chain. No transaction was requested.");
    const block = await client.getBlock();
    if (block.number === null || block.hash === null) throw new Error("A confirmed block is unavailable. Refresh before continuing.");
    const code = await client.getCode({ address: this.config.address, blockNumber: block.number });
    if (!code || keccak256(code) !== this.config.runtimeHash) throw new Error("The deployed P2P contract does not match the verified release. Lending is unavailable.");
    const [loan, collateral] = await Promise.all([
      client.readContract({ address: this.config.address, abi: p2pAbi, functionName: "loanToken", blockNumber: block.number }),
      client.readContract({ address: this.config.address, abi: p2pAbi, functionName: "collateralToken", blockNumber: block.number }),
    ]);
    if (!same(loan, this.config.loanToken) || !same(collateral, this.config.collateralToken)) throw new Error("Token configuration does not match the contract. Lending is unavailable.");
    // Recovery uses the immutable agreement's raw amounts and original display
    // decimals. Mutable metadata qualification belongs to the new-exposure check.
    return { ...block, number: block.number, hash: block.hash };
  }
  async connect(provider: EIP1193Provider): Promise<Address> {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts[0]) throw new Error("No wallet account was selected.");
    this.account = getAddress(accounts[0]);
    await this.assertWallet(provider);
    await this.verify();
    return this.account;
  }
  disconnect() { this.account = null; }
  private async assertWallet(provider: EIP1193Provider, expectedAccount = this.account) {
    if (!this.account || !expectedAccount) throw new Error("Connect your wallet first.");
    if (!same(this.account, expectedAccount)) throw new Error("The wallet account changed. Reconnect before continuing.");
    const [accounts, chainId] = await Promise.all([
      provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" }),
    ]);
    if (!this.account || !same(this.account, expectedAccount) || !accounts[0] || !same(accounts[0], expectedAccount)) throw new Error("The wallet account changed. Reconnect before continuing.");
    if (Number(chainId) !== this.config.chainId) throw new Error(`Switch your wallet to ${this.config.chainName} (chain ${this.config.chainId}) and reconnect.`);
    return expectedAccount;
  }
  private async readLoans(ids: readonly bigint[], blockNumber: bigint): Promise<Loan[]> {
    const loans: Loan[] = [];
    for (let start = 0; start < ids.length; start += 5) {
      loans.push(...await Promise.all(ids.slice(start, start + 5).map(async id => {
        if (id <= 0n) throw new Error("Invalid loan identifier.");
        const [row, isPublic, createdAt] = await Promise.all([
          this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "offers", args: [id], blockNumber }),
          (this.config.version ?? 1) >= 2 ? this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "isPublicOffer", args: [id], blockNumber }) : false,
          (this.config.version ?? 1) >= 2 ? this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "offerCreatedAt", args: [id], blockNumber }) : 0n,
        ]);
        const [lender, borrower, principal, collateral, interest, duration, expiresAt, dueAt, status] = row;
        const parsed = statuses[status - 1];
        if (!parsed || [duration, expiresAt, dueAt, createdAt].some(v => v > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error("The loan is unavailable or has invalid terms.");
        const v3 = this.config.version === 3 ? await this.readV3LoanDetails(id, blockNumber) : {};
        return { ...v3, id, lender, borrower, principal, collateral, interest, durationDays: Number(duration / 86400n), expiresAt: Number(expiresAt), dueAt: Number(dueAt), status: parsed, isPublic, createdAt: Number(createdAt) };
      })));
    }
    return loans;
  }
  private async readV3LoanDetails(id: bigint, blockNumber: bigint) {
    const read = (functionName: "vaults" | "repaymentDeadline" | "loanCredit" | "extensionProposals", args: readonly unknown[]) =>
      this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName, args, blockNumber } as never);
    const [vault, deadline, usdCredit, collateralCredit, extension] = await Promise.all([
      read("vaults", [id]), read("repaymentDeadline", [id]), read("loanCredit", [id, this.config.loanToken]).catch(() => null),
      read("loanCredit", [id, this.config.collateralToken]).catch(() => null), read("extensionProposals", [id]),
    ]) as [Address, bigint, readonly [Address, bigint, bigint] | null, readonly [Address, bigint, bigint] | null, readonly [Address, bigint, bigint, bigint, bigint]];
    const time = (value: bigint) => {
      if (typeof value !== "bigint" || value < 0n || value > 8_640_000_000_000n) throw new Error("Invalid V3 loan deadline.");
      return Number(value);
    };
    const credit = (row: readonly [Address, bigint, bigint] | null): LoanCredit => {
      if (!row) return { beneficiary: "0x0000000000000000000000000000000000000000", nominal: 0n, available: 0n, unavailable: true };
      const [beneficiary, nominal, available] = row;
      if (!isAddress(beneficiary) || nominal < 0n || available < 0n || available > nominal
        || (nominal > 0n && /^0x0{40}$/i.test(beneficiary))) throw new Error("Invalid loan credit.");
      return { beneficiary, nominal, available };
    };
    if (!isAddress(vault) || /^0x0{40}$/i.test(vault) || !isAddress(extension[0]) || extension[1] < 0n) throw new Error("Invalid V3 loan vault or extension.");
    const [fundingAvailable, collateralAvailable] = await Promise.all([
      this.publicClient.readContract({ address: this.config.loanToken, abi: tokenAbi,
        functionName: "balanceOf", args: [vault], blockNumber }).catch(() => undefined),
      this.publicClient.readContract({ address: this.config.collateralToken, abi: tokenAbi,
        functionName: "balanceOf", args: [vault], blockNumber }).catch(() => undefined),
    ]);
    return { vault, repaymentDeadline: time(deadline), fundingAvailable, collateralAvailable,
      loanCredits: { USDG: credit(usdCredit), COLLATERAL: credit(collateralCredit) },
      extensionProposal: { proposer: extension[0], nonce: extension[1], oldDeadline: time(extension[2]), newDeadline: time(extension[3]), expiresAt: time(extension[4]) } };
  }
  async getLoan(id: bigint): Promise<Loan> {
    const block = await this.verify();
    return (await this.readLoans([id], block.number))[0]!;
  }
  async browse(cursor = 0n, atBlock?: bigint): Promise<OfferPage> {
    const verified = await this.verify();
    if (atBlock !== undefined && (atBlock < 0n || atBlock > verified.number)) throw new Error("Invalid offer observation block.");
    const observed = atBlock === undefined || atBlock === verified.number ? verified : await this.publicClient.getBlock({blockNumber:atBlock});
    if (observed.number === null || observed.hash === null) throw new Error("Offer observation block is unavailable.");
    const block = {...observed,number:observed.number,hash:observed.hash};
    const health = await readP2PHealth(this.publicClient, this.config, block);
    const paused = await this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "newLoansPaused", blockNumber: block.number });
    if ((this.config.version ?? 1) < 2) return { offers: [], now: Number(block.timestamp), blockNumber: block.number, paused, nextCursor: null };
    const [ids, next] = await this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "getPublicOfferIds", args: [cursor, 40n], blockNumber: block.number });
    if (ids.length > 40 || (cursor > 0n && next >= cursor)) throw new Error("Invalid public offer page. Refresh the marketplace.");
    const rows = await this.readLoans(ids, block.number);
    if (rows.some(loan => !loan.isPublic)) throw new Error("A private offer was returned in the public market.");
    return { offers: rows.filter(loan => loan.status === "open" && BigInt(loan.expiresAt) > block.timestamp), now: Number(block.timestamp), blockNumber: block.number, paused, nextCursor: next > 0n ? next : null, health };
  }
  private async incomingAt(account: Address, cursor: bigint, block: { number: bigint; timestamp: bigint }) {
    const [ids, next] = await this.publicClient.readContract({ address: this.config.address, abi: p2pAbi,
      functionName: "getIncomingOfferIds", args: [account, cursor, 40n], blockNumber: block.number });
    if (ids.length > 40 || new Set(ids).size !== ids.length || (cursor > 0n && next >= cursor)) throw new Error("Invalid incoming offer page.");
    const offers = await this.readLoans(ids, block.number);
    if (offers.some(loan => loan.isPublic || !same(loan.borrower, account) || same(loan.lender, account))) throw new Error("An unrelated incoming offer was returned.");
    return { offers: offers.filter(loan => loan.status === "open" && BigInt(loan.expiresAt) > block.timestamp),
      nextCursor: next > 0n ? next : null };
  }
  async getIncomingOffers(cursor = 0n) {
    if (!this.account) throw new Error("Connect your wallet to view incoming offers.");
    const account = this.account;
    if (this.config.version !== 3) return { offers: [], nextCursor: null };
    const block = await this.verify();
    const page = await this.incomingAt(account, cursor, block);
    if (this.account !== account) throw new Error("Wallet changed while loading incoming offers.");
    return page;
  }
  /** Outstanding claims have their own discovery, independent of the displayed loan history. */
  async creditPage(cursor = 0n, anchor?: { number: bigint; hash: Hex }) {
    const account = this.account;
    if (!account || this.config.version !== 3) throw new Error("Connect to a V3 market to load withdrawal credits.");
    const verified = await this.verify();
    const block = anchor ?? { number: verified.number, hash: verified.hash };
    if (block.number > verified.number || (await this.publicClient.getBlock({ blockNumber: block.number })).hash !== block.hash) {
      throw new Error("Credit history changed after a chain reorganization. Refresh to load it again.");
    }
    const [page, usd, collateral] = await Promise.all([
      this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "getAccountOfferIds", args: [account, cursor, 40n], blockNumber: block.number }),
      this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "credits", args: [this.config.loanToken, account], blockNumber: block.number }),
      this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "credits", args: [this.config.collateralToken, account], blockNumber: block.number }),
    ]);
    const [ids, next] = page;
    if (usd === 0n && collateral === 0n) {
      if (this.account !== account || (await this.publicClient.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Withdrawal history changed. Refresh to load it again.");
      if (this.account !== account) throw new Error("Wallet changed while loading withdrawal credits.");
      return { loans: [] as Loan[], nextCursor: null, anchor: block, nominal: { USDG: usd, COLLATERAL: collateral } };
    }
    if (ids.length > 40 || next < 0n || (cursor > 0n && next >= cursor) || ids.some(id => id <= 0n)) throw new Error("Invalid withdrawal credit page.");
    const owned: bigint[] = [];
    for (let start = 0; start < ids.length; start += 5) {
      await Promise.all(ids.slice(start, start + 5).map(async id => {
        const claims = await Promise.all([this.config.loanToken, this.config.collateralToken].map(token =>
          this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "loanCredit", args: [id, token], blockNumber: block.number }).catch(() => null)));
        // Include unreadable claims so their explicit unknown state cannot hide this loan’s other token.
        if (claims.some(claim => claim === null || (same(claim[0], account) && claim[1] > 0n))) owned.push(id);
      }));
      if (this.account !== account) throw new Error("Wallet changed while loading withdrawal credits.");
    }
    const loans = await this.readLoans(owned, block.number);
    if (this.account !== account || (await this.publicClient.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Withdrawal history changed. Refresh to load it again.");
    return { loans, nextCursor: next > 0n ? next : null, anchor: block, nominal: { USDG: usd, COLLATERAL: collateral } };
  }
  async snapshot(beforeId?: bigint): Promise<Snapshot> {
    if (!this.account) throw new Error("Connect your wallet to view your loans.");
    const account = this.account;
    const block = await this.verify();
    const health = await readP2PHealth(this.publicClient, this.config, block);
    const read = <N extends "permittedLenders" | "newLoansPaused" | "maxPrincipalPerLoan" | "maxCommittedPrincipal" | "committedPrincipal" | "nextOfferId" | "credits">(name: N, args: readonly unknown[] = []) => this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: name, args, blockNumber: block.number } as never);
    const [approvedLender, paused, maxPrincipal, maxCommitted, committed, next, usdCredit, collateralCredit, usdBalance, collateralBalance, nativeBalance] = await Promise.all([
      (this.config.version ?? 1) >= 2 ? true : read("permittedLenders", [account]), read("newLoansPaused"),
      (this.config.version ?? 1) >= 2 ? null : read("maxPrincipalPerLoan"), (this.config.version ?? 1) >= 2 ? null : read("maxCommittedPrincipal"),
      read("committedPrincipal"), (this.config.version ?? 1) >= 2 ? 0n : read("nextOfferId"), read("credits", [this.config.loanToken, account]), read("credits", [this.config.collateralToken, account]),
      this.publicClient.readContract({ address: this.config.loanToken, abi: tokenAbi, functionName: "balanceOf", args: [account], blockNumber: block.number })
        .catch(error => { if (this.config.version === 3) return null; throw error; }),
      this.publicClient.readContract({ address: this.config.collateralToken, abi: tokenAbi, functionName: "balanceOf", args: [account], blockNumber: block.number })
        .catch(error => { if (this.config.version === 3) return null; throw error; }),
      this.publicClient.getBalance({ address: account, blockNumber: block.number }),
    ]);
    let offers: Loan[]; let nextCursor: bigint | null;
    if ((this.config.version ?? 1) >= 2) {
      const [ids, cursor] = await this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "getAccountOfferIds", args: [account, beforeId ?? 0n, 40n], blockNumber: block.number });
      if (ids.length > 40 || (beforeId && cursor >= beforeId)) throw new Error("Invalid account loan page. Refresh your loans.");
      offers = await this.readLoans(ids, block.number);
      if (offers.some(loan => !same(loan.lender, account) && !same(loan.borrower, account))) throw new Error("An unrelated loan was returned for your wallet.");
      nextCursor = cursor > 0n ? cursor : null;
    } else {
      const upper = beforeId ?? next as bigint;
      const lower = upper > 40n ? upper - 40n : 1n;
      const ids = Array.from({ length: Number(upper > lower ? upper - lower : 0n) }, (_, i) => upper - 1n - BigInt(i));
      offers = (await this.readLoans(ids, block.number)).filter(loan => same(account, loan.lender) || same(account, loan.borrower));
      nextCursor = lower > 1n ? lower : null;
    }
    // An unavailable or spammed invitation inbox must not hide owned loans.
    const incoming = this.config.version === 3 ? await this.incomingAt(account, 0n, block)
      .then(page => ({ ...page, complete: page.nextCursor === null, message: undefined as string | undefined }))
      .catch(() => ({ offers: [] as Loan[], nextCursor: null, complete: false, message: "Incoming offers could not be loaded. Your existing loans remain available." })) : undefined;
    const active = await readActiveLoans({ config: this.config, account, targetBlock: block.number,
      publicClient: this.publicClient, readLoans: (ids, number) => this.readLoans(ids, number),
      getAccount: () => this.account, signal: AbortSignal.timeout(12_000),
      ...(this.config.version === 3 ? { readActivePage: (cursor: bigint, revision: bigint) => this.publicClient.readContract({
        address: this.config.address, abi: p2pAbi, functionName: "getActiveLoanIds", args: [account, cursor, 40n, revision], blockNumber: block.number }) } : {}) });
    offers = [...new Map([...offers, ...active.loans].map(loan => [loan.id.toString(), loan])).values()];
    if (this.account !== account) throw new Error("Wallet changed while loading. Refresh your loans.");
    const availableCredits = offers.reduce((total, loan) => {
      for (const token of ["USDG", "COLLATERAL"] as const) {
        const credit = loan.loanCredits?.[token];
        if (credit && same(credit.beneficiary, account)) total[token] += credit.available;
      }
      return total;
    }, { USDG: 0n, COLLATERAL: 0n });
    return { account, now: Number(block.timestamp), blockNumber: block.number, approvedLender: approvedLender as boolean, paused: paused as boolean,
      balances: { USDG: usdBalance ?? 0n, COLLATERAL: collateralBalance ?? 0n },
      ...(this.config.version === 3 ? { balancesUnavailable: { USDG: usdBalance === null, COLLATERAL: collateralBalance === null } } : {}), credits: this.config.version === 3 ? availableCredits : { USDG: usdCredit as bigint, COLLATERAL: collateralCredit as bigint }, nativeBalance, offers,
      ...(this.config.version === 3 ? { nominalCredits: { USDG: usdCredit as bigint, COLLATERAL: collateralCredit as bigint }, creditsComplete: nextCursor === null && !beforeId && offers.every(loan => !loan.loanCredits?.USDG.unavailable && !loan.loanCredits?.COLLATERAL.unavailable) } : {}),
      maxPrincipal: maxPrincipal as bigint | null, maxCommitted: maxCommitted as bigint | null, committed: committed as bigint, nextCursor, health,
      activeLoansComplete: active.complete, activeLoansMessage: active.message ?? undefined,
      ...(incoming ? { incomingOffers: incoming.offers, incomingNextCursor: incoming.nextCursor, incomingOffersComplete: incoming.complete, incomingOffersMessage: incoming.message } : {}) };
  }
  private currentPending(key: string, hash: Hex) {
    const record = loadPendingRecord(key);
    if (!record || record.hash !== hash) {
      if (this.pendingHashes.get(key) === hash) this.pendingHashes.delete(key);
      throw new Error("The pending transaction record changed while checking status. Refresh before continuing.");
    }
    return record;
  }
  private async capturePendingIntent(hash: Hex, account: Address, expected?: { to: Address; input: Hex; value: bigint }) {
    const key = `turret:p2p:pending:${this.config.chainId}:${this.config.address}:${account}`;
    const saved = loadPendingRecord(key);
    if (!saved || saved.hash !== hash || saved.intent || typeof this.publicClient.getTransaction !== "function") return false;
    if (saved.requested && !same(saved.requested.from, account)) throw new Error("The saved transaction request belongs to a different wallet.");
    const requested = expected ?? (saved.requested ? { ...saved.requested, value: BigInt(saved.requested.value) } : undefined);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (loadPendingRecord(key)?.hash !== hash) return false;
        const transaction = await this.publicClient.getTransaction({ hash });
        if (!same(transaction.from, account) || !transaction.to || !isAddress(transaction.to)
          || !Number.isSafeInteger(transaction.nonce) || transaction.nonce < 0 || typeof transaction.value !== "bigint"
          || !/^0x(?:[0-9a-f]{2})*$/i.test(transaction.input)) return false;
        const observedBlock = transaction.blockNumber ?? (await this.publicClient.getBlock()).number ?? 0n;
        const updated = updatePendingIntent(key, hash, { from: account, nonce: transaction.nonce,
          to: requested?.to ?? transaction.to, input: requested?.input ?? transaction.input,
          value: (requested?.value ?? transaction.value).toString(), submittedBlock: observedBlock.toString() });
        if (!updated) return false;
        return !!requested && (!same(transaction.to, requested.to) || !same(transaction.input, requested.input) || transaction.value !== requested.value);
      } catch {
        // Some RPCs take a moment to expose a just-broadcast transaction. The hash
        // is already durable; receipt/reopen recovery can retry metadata capture.
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return false;
  }
  private async receipt(hash: Hex, onStage: Progress, label: string, account = this.account, expected?: { to: Address; input: Hex; value: bigint }, recovering = false): Promise<Hex> {
    if (!account) throw new Error("Connect your wallet before checking a transaction.");
    const key = `turret:p2p:pending:${this.config.chainId}:${this.config.address}:${account}`;
    if (recovering) {
      this.currentPending(key, hash);
    } else {
      this.pendingHashes.set(key, hash);
      savePending(key, hash, undefined, expected ? { from: account, to: expected.to, input: expected.input, value: expected.value.toString() } : undefined);
    }
    onStage({ status: "pending", hash, message: `${label} submitted. Waiting for confirmation…` });
    const originalChanged = await this.capturePendingIntent(hash, account, expected);
    // viem resolves the replacement receipt even when the wallet cancelled the
    // original. Capture a bounded lineage; never equate receipt success with
    // success of a different call that reused the nonce.
    const replacements: ReplacementReturnType[] = [];
    let tooManyReplacements = false;
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash, confirmations: 1, timeout: 120000,
      onReplaced: replacement => {
        if (replacements.length < 16) replacements.push(replacement);
        else tooManyReplacements = true;
      },
    });
    const unknown = () => new Error("Transaction replacement could not be verified. Refresh transaction status before retrying.");
    const validHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
    const validTransaction = (transaction: Transaction) => validHash(transaction.hash)
      && isAddress(transaction.from) && transaction.to !== null && isAddress(transaction.to)
      && typeof transaction.value === "bigint" && transaction.value >= 0n
      && Number.isSafeInteger(transaction.nonce) && transaction.nonce >= 0
      && typeof transaction.input === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(transaction.input);
    const equivalent = (left: Transaction, right: Transaction) => same(left.from, right.from)
      && left.nonce === right.nonce && left.to !== null && right.to !== null && same(left.to, right.to)
      && left.value === right.value && same(left.input, right.input);
    if (tooManyReplacements || !validHash(receipt.transactionHash) || !validHash(receipt.blockHash)
      || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber < 0n
      || !isAddress(receipt.from) || !same(receipt.from, account) || !["success", "reverted"].includes(receipt.status)) throw unknown();
    const lineage = new Map<string, Transaction>();
    let expectedHash = hash;
    let rejectedReplacement: "cancelled" | "replaced" | null = null;
    for (const replacement of replacements) {
      const { replacedTransaction: previous, transaction: next, transactionReceipt: observed } = replacement;
      if (!validTransaction(previous) || !validTransaction(next) || !same(previous.from, account)
        || !same(next.from, account) || previous.nonce !== next.nonce
        || !validHash(observed.transactionHash) || !same(observed.transactionHash, next.hash)
        || !validHash(observed.blockHash) || typeof observed.blockNumber !== "bigint" || observed.blockNumber < 0n
        || !same(observed.from, account) || !["success", "reverted"].includes(observed.status)) throw unknown();
      if (lineage.size === 0) {
        if (!same(previous.hash, hash)) throw unknown();
        lineage.set(hash.toLowerCase(), previous);
      }
      const known = lineage.get(previous.hash.toLowerCase());
      if (!known || !equivalent(known, previous)) throw unknown();
      const knownNext = lineage.get(next.hash.toLowerCase());
      if (knownNext && !equivalent(knownNext, next)) throw unknown();
      if (replacement.reason !== "repriced" || !equivalent(previous, next)) {
        rejectedReplacement ??= replacement.reason === "cancelled" ? "cancelled" : "replaced";
      }
      lineage.set(next.hash.toLowerCase(), next);
      expectedHash = next.hash;
    }
    if (!same(receipt.transactionHash, expectedHash)) throw unknown();
    const lastReplacement = replacements.at(-1);
    if (lastReplacement && (lastReplacement.transactionReceipt.blockHash !== receipt.blockHash
      || lastReplacement.transactionReceipt.blockNumber !== receipt.blockNumber
      || lastReplacement.transactionReceipt.status !== receipt.status)) throw unknown();
    const canonical = await this.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) throw new Error("The confirmation changed after a chain reorganization. Refresh transaction status before retrying.");
    if (recovering) this.currentPending(key, hash);
    // A canonical, identified transaction consumed this nonce. Unknown outcomes
    // retain the original pending record, including across an account change.
    if (this.pendingHashes.get(key) === hash) this.pendingHashes.delete(key);
    clearPending(key, hash);
    if (originalChanged) throw new Error(`${label} was changed in your wallet. The requested action was not confirmed. Refresh your balances before trying again.`);
    if (rejectedReplacement === "cancelled") throw new Error(`${label} was cancelled in your wallet. The requested action was not completed.`);
    if (rejectedReplacement) throw new Error(`${label} was replaced by a different transaction. Refresh your balances before trying again.`);
    if (receipt.status === "reverted") throw new Error(`${label} reverted. No contract changes from that transaction were applied.`);
    onStage({ status: "confirmed", hash: receipt.transactionHash, message: `${label} confirmed.` });
    return receipt.transactionHash;
  }
  async reconcilePending(onStage: Progress, replacementHash?: Hex): Promise<boolean> {
    const account = this.account;
    if (!account) return false;
    const key = `turret:p2p:pending:${this.config.chainId}:${this.config.address}:${account}`;
    const hash = loadPending(key) ?? this.pendingHashes.get(key) ?? null;
    if (!hash) {
      if (replacementHash) throw new Error("No pending transaction is saved for this wallet and market.");
      return false;
    }
    const flightKey = `${key.toLowerCase()}:${hash}:${replacementHash ?? "automatic"}`;
    const existing = this.pendingReconciliations.get(flightKey);
    if (existing) return existing;
    const operation = this.reconcileSavedPending(account, key, hash, onStage, replacementHash);
    this.pendingReconciliations.set(flightKey, operation);
    try { return await operation; }
    finally { if (this.pendingReconciliations.get(flightKey) === operation) this.pendingReconciliations.delete(flightKey); }
  }
  private async reconcileSavedPending(account: Address, key: string, hash: Hex, onStage: Progress, replacementHash?: Hex): Promise<boolean> {
    await this.capturePendingIntent(hash, account);
    const record = this.currentPending(key, hash);
    if (record?.intent) {
      await this.verify();
      const recovered = await recoverPendingTransaction(this.publicClient, record, account, { replacementHash, getAccount: () => this.account });
      if (recovered) {
        this.currentPending(key, hash);
        if (this.pendingHashes.get(key) === hash) this.pendingHashes.delete(key);
        clearPending(key, hash);
        if (recovered.cancelled && !recovered.equivalent) throw new Error("Previous transaction was cancelled in your wallet. The requested action was not completed.");
        if (!recovered.equivalent) throw new Error("Previous transaction was replaced by a different transaction. Refresh your balances before trying again.");
        if (recovered.receipt.status === "reverted") throw new Error("Previous transaction reverted. No contract changes from that transaction were applied.");
        onStage({ status: "confirmed", hash: recovered.hash, message: "Previous transaction confirmed." });
        return true;
      }
    } else if (replacementHash) {
      throw new Error("The original transaction's nonce could not be recovered. The replacement cannot safely be matched yet; retry with an RPC that retains the original transaction.");
    }
    await this.receipt(hash, onStage, "Previous transaction", account, undefined, true);
    return true;
  }
  private async write(provider: EIP1193Provider, functionName: "createOffer" | "acceptOffer" | "cancelOffer" | "expireOffer" | "repay" | "claimDefault" | "withdraw" | "withdrawCredit" | "withdrawAvailableCredit" | "repayWithCredits" | "proposeExtension" | "acceptExtension" | "cancelExtension", args: readonly unknown[], onStage: Progress, approval?: { token: Address; amount: bigint }, beforeSend?: () => Promise<void>) {
    if (this.busy) throw new Error("A wallet action is already in progress.");
    this.busy = true;
    try {
      const account = await this.assertWallet(provider);
      requirePendingStorage();
      if (await this.reconcilePending(onStage)) throw new Error("The previous transaction is now confirmed. Review your refreshed balances before submitting another action.");
      const newExposure = functionName === "createOffer" || functionName === "acceptOffer";
      const check = async () => {
        const block = await this.verify();
        if (newExposure) {
          const health = await readP2PHealth(this.publicClient, this.config, block, functionName === "acceptOffer" ? args[0] as bigint : undefined);
          if (health.status !== "ok") throw new Error(health.reasons.join(" "));
        }
      };
      await check();
      const wallet = createWalletClient({ account, chain: this.chain, transport: custom(provider, { retryCount: 0 }) });
      if (approval) {
        const allowance = await this.publicClient.readContract({ address: approval.token, abi: tokenAbi, functionName: "allowance", args: [account, this.config.address] });
        if (allowance !== approval.amount) {
          const amounts = allowance === 0n ? [approval.amount] : [0n, approval.amount];
          for (const amount of amounts) {
            await this.assertWallet(provider, account);
            const { request } = await this.publicClient.simulateContract({ account, address: approval.token, abi: tokenAbi, functionName: "approve", args: [this.config.address, amount] });
            await this.assertWallet(provider, account);
            onStage({ status: "signature", message: amount === 0n ? "Confirm clearing the previous token allowance in your wallet." : "Confirm the exact token approval in your wallet." });
            const hash = await wallet.writeContract(request);
            await this.receipt(hash, onStage, "Token approval", account, { to: approval.token, input: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [this.config.address, amount] }), value: 0n });
          }
        }
      }
      await this.assertWallet(provider, account);
      await check();
      const { request } = await this.publicClient.simulateContract({ account, address: this.config.address, abi: p2pAbi, functionName, args } as never);
      await this.assertWallet(provider, account);
      if (beforeSend) await beforeSend();
      await this.assertWallet(provider, account);
      onStage({ status: "signature", message: "Review and confirm the loan transaction in your wallet." });
      const hash = await wallet.writeContract(request);
      return await this.receipt(hash, onStage, "Loan transaction", account, { to: this.config.address, input: encodeFunctionData({ abi: p2pAbi, functionName, args } as never), value: 0n });
    } catch (error) {
      const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null;
      if (functionName === "acceptOffer" && reverted instanceof ContractFunctionRevertedError
        && ["WrongStatus", "OfferExpired"].includes(reverted.data?.errorName ?? "")) {
        throw new Error("This offer is no longer available. It was accepted, cancelled or expired before your acceptance. No loan was opened. A token approval already confirmed may remain; you can revoke it in your wallet.");
      }
      throw error;
    } finally { this.busy = false; }
  }
  async createOffer(provider: EIP1193Provider, terms: Terms, onStage: Progress, beforeSend?: () => Promise<void>) {
    if (this.config.legacy) throw new Error("This market is retained for existing loans. Create offers in the current market.");
    const max = (1n << 256n) - 1n;
    if (!isAddress(terms.borrower) || ((this.config.version ?? 1) < 2 && /^0x0{40}$/i.test(terms.borrower)) || same(terms.borrower, this.config.address)
      || (this.account && same(terms.borrower, this.account)) || terms.principal <= 0n || terms.collateral <= 0n || terms.collateral > max
      || terms.interest < 0n || terms.principal > max - terms.interest || !Number.isSafeInteger(terms.durationDays) || terms.durationDays <= 0
      || ((this.config.version ?? 1) < 2 && (terms.interest > terms.principal / 10n || ![7, 14, 30].includes(terms.durationDays)))) throw new Error("Check the borrower, amounts, fixed interest and loan duration.");
    const block = await this.verify();
    if (!Number.isSafeInteger(terms.expiresAt) || BigInt(terms.expiresAt) <= block.timestamp) throw new Error("Choose an offer expiry after the current chain time.");
    if ((this.config.version ?? 1) < 2 && BigInt(terms.expiresAt) > block.timestamp + 3600n) throw new Error("The legacy offer expiry must be within one hour of the current chain time.");
    if (BigInt(terms.expiresAt) + BigInt(terms.durationDays) * 86400n + 86400n > 8_640_000_000_000n) throw new Error("The selected terms exceed the supported calendar range.");
    return this.write(provider, "createOffer", [terms.borrower, terms.principal, terms.collateral, terms.interest, BigInt(terms.durationDays) * 86400n, BigInt(terms.expiresAt)], onStage, { token: this.config.loanToken, amount: terms.principal }, beforeSend);
  }
  private async loan(id: bigint) { return this.publicClient.readContract({ address: this.config.address, abi: p2pAbi, functionName: "offers", args: [id] }); }
  async accept(provider: EIP1193Provider, id: bigint, onStage: Progress) {
    if (this.config.legacy) throw new Error("New borrowing is closed in this retained market. Choose a current offer.");
    const loan = await this.loan(id);
    if (loan[8] !== 1) throw new Error("This offer is no longer available. It may have been accepted, cancelled or expired.");
    if (!this.account || same(loan[0], this.account)) throw new Error("Connect a borrower wallet different from the lender.");
    if (!((this.config.version ?? 1) >= 2 && /^0x0{40}$/i.test(loan[1])) && !same(loan[1], this.account)) throw new Error("Only the named borrower can accept this private offer.");
    const block = await this.verify();
    if (loan[6] <= block.timestamp) throw new Error("This offer has expired. Choose another offer.");
    return this.write(provider, "acceptOffer", [id], onStage, { token: this.config.collateralToken, amount: loan[3] });
  }
  async repay(provider: EIP1193Provider, id: bigint, onStage: Progress) {
    const loan = await this.loan(id);
    if (loan[8] !== 2) throw new Error("Only an active loan can be repaid.");
    return this.write(provider, "repay", [id], onStage, { token: this.config.loanToken, amount: loan[2] + loan[4] });
  }
  cancel(provider: EIP1193Provider, id: bigint, onStage: Progress) { return this.write(provider, "cancelOffer", [id], onStage); }
  expire(provider: EIP1193Provider, id: bigint, onStage: Progress) { return this.write(provider, "expireOffer", [id], onStage); }
  claim(provider: EIP1193Provider, id: bigint, onStage: Progress) { return this.write(provider, "claimDefault", [id], onStage); }
  withdraw(provider: EIP1193Provider, token: "USDG" | "COLLATERAL" | "SLV", amount: bigint, recipient: Address, onStage: Progress) {
    if (this.config.version === 3) throw new Error("V3 credits must be withdrawn from their individual loan vault.");
    if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient) || same(recipient, this.config.address) || amount <= 0n) throw new Error("Enter a valid withdrawal recipient and amount.");
    return this.write(provider, "withdraw", [token === "USDG" ? this.config.loanToken : this.config.collateralToken, amount, recipient], onStage);
  }
  private requireV3() { if (this.config.version !== 3) throw new Error("This action requires a V3 loan."); }
  private tokenAddress(token: "USDG" | "COLLATERAL") { return token === "USDG" ? this.config.loanToken : this.config.collateralToken; }
  private recipient(recipient: Address) {
    if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient) || same(recipient, this.config.address)) throw new Error("Enter a valid withdrawal recipient.");
  }
  async withdrawCredit(provider: EIP1193Provider, id: bigint, token: "USDG" | "COLLATERAL", amount: bigint, recipient: Address, onStage: Progress) {
    this.requireV3(); this.recipient(recipient);
    const loan = await this.getLoan(id), credit = loan.loanCredits![token];
    if (!this.account || !same(credit.beneficiary, this.account) || amount <= 0n || amount > credit.available || same(recipient, loan.vault!)) throw new Error("Choose an available credit owned by your wallet and a valid recipient.");
    return this.write(provider, "withdrawCredit", [id, this.tokenAddress(token), amount, recipient], onStage);
  }
  async withdrawAvailableCredit(provider: EIP1193Provider, id: bigint, token: "USDG" | "COLLATERAL", minReceived: bigint, recipient: Address, onStage: Progress) {
    this.requireV3(); this.recipient(recipient);
    const loan = await this.getLoan(id), credit = loan.loanCredits![token];
    if (!this.account || !same(credit.beneficiary, this.account) || credit.nominal <= 0n || minReceived < 0n || minReceived > credit.available || same(recipient, loan.vault!)) throw new Error("Choose a credit owned by your wallet, a valid recipient and a valid minimum recovery amount.");
    return this.write(provider, "withdrawAvailableCredit", [id, this.tokenAddress(token), minReceived, recipient], onStage);
  }
  async repayWithCredits(provider: EIP1193Provider, id: bigint, sourceIds: readonly bigint[], sourceAmounts: readonly bigint[], walletAmount: bigint, onStage: Progress) {
    this.requireV3();
    if (sourceIds.length > 16 || sourceIds.length !== sourceAmounts.length || walletAmount < 0n
      || sourceIds.some((source, i) => source <= 0n || source === id || (i > 0 && source <= sourceIds[i - 1]!) || sourceAmounts[i]! <= 0n)) throw new Error("Choose up to 16 distinct credit sources in ascending loan order.");
    const loan = await this.getLoan(id);
    if (loan.status !== "active" || !this.account) throw new Error("Connect your wallet to repay this active loan with your own credits.");
    if (sourceAmounts.reduce((sum, amount) => sum + amount, walletAmount) !== loan.principal + loan.interest) throw new Error("Credits and wallet payment must exactly cover the full repayment.");
    for (let i = 0; i < sourceIds.length; i++) {
      const source = await this.getLoan(sourceIds[i]!); const credit = source.loanCredits!.USDG;
      if (!same(credit.beneficiary, this.account) || sourceAmounts[i]! > credit.available) throw new Error("A selected loan credit is unavailable or belongs to another wallet.");
    }
    return this.write(provider, "repayWithCredits", [id, sourceIds, sourceAmounts, walletAmount], onStage,
      walletAmount > 0n ? { token: this.config.loanToken, amount: walletAmount } : undefined);
  }
  async proposeExtension(provider: EIP1193Provider, id: bigint, newDeadline: number, expiresAt: number, onStage: Progress) {
    this.requireV3();
    const block = await this.verify(), loan = await this.getLoan(id);
    if (loan.status !== "active" || !this.account || (!same(loan.lender, this.account) && !same(loan.borrower, this.account))
      || !Number.isSafeInteger(newDeadline) || !Number.isSafeInteger(expiresAt) || newDeadline > 8_640_000_000_000
      || newDeadline <= loan.repaymentDeadline! || BigInt(newDeadline) <= block.timestamp
      || BigInt(expiresAt) <= block.timestamp || expiresAt > newDeadline) throw new Error("Choose a later final deadline and a proposal expiry before that new deadline.");
    return this.write(provider, "proposeExtension", [id, BigInt(newDeadline), BigInt(expiresAt)], onStage);
  }
  async acceptExtension(provider: EIP1193Provider, id: bigint, proposal: ExtensionProposal, onStage: Progress) {
    this.requireV3();
    const loan = await this.getLoan(id), current = loan.extensionProposal!;
    if (!this.account || loan.status !== "active" || (!same(loan.lender, this.account) && !same(loan.borrower, this.account))
      || same(current.proposer, this.account) || /^0x0{40}$/i.test(current.proposer)
      || current.nonce !== proposal.nonce || current.oldDeadline !== proposal.oldDeadline || current.newDeadline !== proposal.newDeadline
      || current.expiresAt !== proposal.expiresAt || !same(current.proposer, proposal.proposer)) throw new Error("The extension changed or cannot be accepted by this wallet. Review the current proposal.");
    return this.write(provider, "acceptExtension", [id, proposal.nonce, BigInt(proposal.oldDeadline), BigInt(proposal.newDeadline), BigInt(proposal.expiresAt)], onStage);
  }
  cancelExtension(provider: EIP1193Provider, id: bigint, nonce: bigint, onStage: Progress) {
    this.requireV3();
    if (id <= 0n || nonce <= 0n) throw new Error("Choose a current extension proposal.");
    return this.write(provider, "cancelExtension", [id, nonce], onStage);
  }

}
