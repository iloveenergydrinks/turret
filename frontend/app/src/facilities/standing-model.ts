import { createPublicClient, defineChain, formatUnits, http, type Address } from "viem";
import { inspectTokenBaseline } from "../p2p/health-core.mjs";
import { factoryAbi, readFactoryFacility, validateFactoryConfig, verifyFactory, type FactoryConfig } from "./factory.mjs";
import { isAccount, same, ZERO_ADDRESS } from "./quotes.mjs";
import { amount, validateRegistry, type FacilityMarket } from "./ui-model";
import { FacilityTransactions } from "./wallet-transactions";

export function validateStandingConfig(value: unknown, hostname: string): FactoryConfig {
  const config = validateFactoryConfig(value);
  if (config.chainId === 31337 && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new Error("This lending network is not supported here.");
  return structuredClone(config);
}
export async function loadStandingConfig(): Promise<FactoryConfig | null> {
  const response = await fetch("/standing-offers.json", { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Standing offer configuration could not be loaded. Try again.");
  return validateStandingConfig(await response.json(), window.location.hostname);
}
export function validateStandingEntry(value: unknown, config: FactoryConfig): FacilityMarket {
  const entry = validateRegistry({ schemaVersion: 1, entries: [value], baseline: config.baseline }, window.location.hostname).entries[0]!;
  const token = config.collateral.find(token => same(token.address, entry.collateralToken));
  if (entry.chainId !== config.chainId || !same((value as { factory?: string }).factory, config.factory)
    || !same(entry.loanToken, config.loanToken) || !same(entry.feeRecipient, entry.lender) || entry.feeBps !== "0"
    || !token || token.symbol !== entry.collateralSymbol || token.decimals !== entry.collateralDecimals
    || BigInt(entry.startBlock) < BigInt(config.startBlock)) throw new Error("Lending balance identity does not match this market.");
  return entry;
}
async function directoryRequest(config: FactoryConfig, query: URLSearchParams, address?: Address) {
  const response = await fetch(`/api/standing-facilities${query.size ? `?${query}` : ""}`, address
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) }
    : { cache: "no-store" });
  if (!response.ok) throw new Error(address ? "Your lending balance could not be published. Retry setup to publish the existing balance." : "Standing offers could not be loaded. Refresh to try again.");
  const data = await response.json();
  if (address || query.has("facility")) {
    const entry = validateStandingEntry(data.entry, config);
    if (!same(entry.address, address ?? query.get("facility"))) throw new Error("The directory returned a different lending balance.");
    return entry;
  }
  return data;
}
export async function loadStandingPage(config: FactoryConfig, options: { after?: string; lender?: Address; collateral?: Address; available?: boolean } = {}) {
  const query = new URLSearchParams();
  if (options.after) query.set("after", options.after);
  if (options.lender) query.set("lender", options.lender);
  if (options.collateral) query.set("collateral", options.collateral);
  if (options.available) query.set("available", "1");
  const data = await directoryRequest(config, query);
  if (data.schemaVersion !== 1 || !Array.isArray(data.entries) || data.entries.length > 12
    || data.nextCursor !== null && (!/^[1-9][0-9]{0,14}$/.test(data.nextCursor) || BigInt(data.nextCursor) <= BigInt(options.after ?? "0"))) throw new Error("The standing offer directory returned an invalid page.");
  const entries: FacilityMarket[] = data.entries.map((entry: unknown) => validateStandingEntry(entry, config));
  if (new Set(entries.map(entry => entry.address.toLowerCase())).size !== entries.length
    || entries.some(entry => options.lender && !same(entry.lender, options.lender) || options.collateral && !same(entry.collateralToken, options.collateral))) throw new Error("The standing offer directory returned unexpected balances.");
  return { entries, nextCursor: data.nextCursor as string | null };
}
export const registerStandingFacility = (config: FactoryConfig, address: Address): Promise<FacilityMarket> => directoryRequest(config, new URLSearchParams(), address);
export const loadStandingFacility = (config: FactoryConfig, address: Address): Promise<FacilityMarket> => directoryRequest(config, new URLSearchParams({ facility: address }));
export const standingHref = (address: Address, intent = "borrow") => `/borrow/p2p?facility=${address}&intent=${intent}`;

export type SetupDraft = { budget: string; minimum: string; maximum: string; collateral: string; interest: string; days: string };
export function setupTerms(draft: SetupDraft, decimals: number) {
  const budget = amount(draft.budget, 6), minimum = amount(draft.minimum, 6), maximum = amount(draft.maximum, 6);
  const collateral = amount(draft.collateral, decimals), interest = draft.interest === "0" ? 0n : amount(draft.interest, 6);
  if (minimum > maximum || maximum > budget) throw new Error("The minimum loan must be at most the maximum, and the maximum must fit your budget.");
  if (!/^[1-9][0-9]*$/.test(draft.days) || BigInt(draft.days) > 365n) throw new Error("Choose a loan duration from 1 to 365 whole days.");
  const duration = BigInt(draft.days) * 86400n;
  // Round the full-budget amounts upward so a partial draw never undercuts the lender's entered ratio.
  const scale = (value: bigint) => (value * budget + maximum - 1n) / maximum;
  const fullCollateral = scale(collateral), fullInterest = scale(interest);
  if (fullCollateral >= 2n ** 256n || fullInterest + budget >= 2n ** 256n) throw new Error("These terms exceed the contract amount limit.");
  const ratio = collateral * 10n ** 18n / maximum;
  if (!ratio || ratio >= 2n ** 256n) throw new Error("The collateral amount is outside the supported range.");
  const interestBps = interest * 10000n / maximum;
  return {
    limits: { maxExposure: budget, minDraw: minimum, maxDraw: maximum, minDuration: duration, maxDuration: duration,
      maxQuoteLifetime: 86400n, minCollateralPerPrincipalWad: ratio, minInterestBps: interestBps > 10000n ? 10000n : interestBps },
    quote: { cash: draft.budget, capacity: draft.budget, minimum: draft.minimum, collateral: formatUnits(fullCollateral, decimals), interest: formatUnits(fullInterest, 6), days: draft.days, minutes: "1440" },
  };
}
export function makeStandingClient(config: FactoryConfig, getAccount: () => Address | null) {
  const rpc = new URL("/api/rpc", window.location.origin).href;
  const chain = defineChain({ id: config.chainId, name: config.chainId === 4663 ? "Robinhood Chain" : "Local test chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 1, batch: { batchSize: 50, wait: 8 } }), pollingInterval: 1000 });
  const transactions = new FacilityTransactions({ address: config.factory, chain, client, getAccount, verify: async () => { await verifyFactory(client, config); } });
  return { client, transactions,
    async existing(lender: Address, collateral: Address) {
      await verifyFactory(client, config);
      const result = await client.readContract({ address: config.factory, abi: factoryAbi, functionName: "getFacility", args: [lender, collateral] });
      if (same(result, ZERO_ADDRESS)) return null;
      if (!isAccount(result)) throw new Error("Your lending balance could not be checked.");
      return same(result, ZERO_ADDRESS) ? null : result as Address;
    },
    async qualify(collateral: Address) {
      const block = await verifyFactory(client, config);
      if (!config.collateral.some(token => same(token.address, collateral))) throw new Error("Choose supported collateral.");
      for (const address of [config.loanToken, collateral]) {
        const token = config.baseline.tokens.find(token => same(token.address, address));
        const reason = await inspectTokenBaseline(client, token!, block);
        if (reason) throw new Error(reason);
      }
    },
    async verifyEntry(address: Address) { return (await readFactoryFacility(client, config, address, { qualify: false })).entry; },
  };
}

// Bound directory RPC work across visible lenders. A cancelled view never starts a queued read.
const readQueue: Array<() => void> = [];
let activeReads = 0;
export function queueStandingRead<T>(read: () => Promise<T>, live: () => boolean = () => true): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const run = () => {
      if (!live()) { resolve(null); readQueue.shift()?.(); return; }
      activeReads++;
      Promise.resolve().then(read).then(resolve, reject).finally(() => { activeReads--; readQueue.shift()?.(); });
    };
    if (activeReads < 2) run(); else readQueue.push(run);
  });
}

export async function loadStandingAccount(config: FactoryConfig, account: Address, after?: Address, epoch?: number) {
  const query = new URLSearchParams({ account, ...(after ? { after } : {}), ...(epoch === undefined ? {} : { epoch: String(epoch) }) });
  const response = await fetch(`/api/standing-account?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 409 ? "Loan history changed. Refresh to reload the first page." : "Standing loan history could not be checked. Refresh to try again.");
  const data = await response.json();
  if (data.schemaVersion !== 1 || data.chainId !== config.chainId || !same(data.account, account)
    || typeof data.complete !== "boolean" || !Number.isSafeInteger(data.checkedAt) || Date.now() - data.checkedAt >= 30000 || data.checkedAt > Date.now()
    || !Number.isSafeInteger(data.historyEpoch) || data.historyEpoch < 0 || !/^0x[0-9a-f]{64}$/i.test(data.blockHash)
    || !/^[0-9]+$/.test(data.blockNumber) || !/^-?[0-9]+$/.test(data.indexedThrough)
    || BigInt(data.indexedThrough) > BigInt(data.blockNumber) || data.complete !== (data.indexedThrough === data.blockNumber)
    || !Array.isArray(data.entries) || data.entries.length > 12) throw new Error("Standing loan history returned invalid results.");
  const entries: FacilityMarket[] = data.entries.map((entry: unknown) => validateStandingEntry(entry, config));
  let previous = after?.toLowerCase() ?? "";
  for (const entry of entries) { if (entry.address.toLowerCase() <= previous) throw new Error("Standing loan history returned an invalid page."); previous = entry.address.toLowerCase(); }
  if (data.nextCursor !== null && (!isAccount(data.nextCursor) || !entries.length || !same(data.nextCursor, entries.at(-1)!.address))) throw new Error("Standing loan pagination could not be verified.");
  return { entries, complete: data.complete as boolean, indexedThrough: data.indexedThrough as string, blockNumber: data.blockNumber as string, historyEpoch: data.historyEpoch as number, nextCursor: data.nextCursor as Address | null };
}
