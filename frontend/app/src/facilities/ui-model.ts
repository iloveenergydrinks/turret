import { createPublicClient, defineChain, http, parseUnits, type Address } from "viem";
import { validateTokenBaseline, type TokenBaseline } from "../p2p/health-core.mjs";
import { FacilityClient, type FacilityLoanPage } from "./client";
import { isAccount, parseSignedQuote, quoteDigest, same, uint, type AvailableQuote } from "./quotes.mjs";
import { validateFacilityEntry, type FacilityEntry } from "./reader.mjs";

export type FacilityMarket = FacilityEntry & { collateralSymbol: string; collateralDecimals: number; loanDecimals: 6; startBlock: string };
export type FacilityRegistry = { schemaVersion: 1; entries: FacilityMarket[]; baseline: TokenBaseline | null };
export function validateRegistry(value: unknown, hostname: string): FacilityRegistry {
  const v = value as FacilityRegistry;
  if (!v || v.schemaVersion !== 1 || !Array.isArray(v.entries) || v.entries.length > 100) throw new Error("Lending configuration is unavailable.");
  const seen = new Set<string>();
  for (const entry of v.entries) {
    if (![4663, 31337].includes(entry.chainId) || (entry.chainId === 31337 && !["localhost", "127.0.0.1", "[::1]"].includes(hostname))) throw new Error("This lending network is not supported here.");
    const tokens = validateFacilityEntry(entry, v.baseline);
    const key = `${entry.chainId}:${entry.address.toLowerCase()}`;
    if (seen.has(key) || entry.loanDecimals !== 6 || !/^[A-Z0-9]{1,12}$/.test(entry.collateralSymbol)
      || entry.collateralDecimals !== tokens[1]?.decimals || tokens[0]?.decimals !== 6 || uint(entry.startBlock) < 0n) throw new Error("Lending asset details could not be verified.");
    seen.add(key);
  }
  if (v.entries.length) validateTokenBaseline(v.baseline, v.entries[0]!.chainId);
  return structuredClone(v);
}
export async function loadFacilityRegistry(): Promise<FacilityRegistry> {
  const response = await fetch("/facility-markets.json", { cache: "no-store" });
  if (response.status === 404) return { schemaVersion: 1, entries: [], baseline: null };
  if (!response.ok) throw new Error("Unable to load lending balances. Try again.");
  return validateRegistry(await response.json(), window.location.hostname);
}
export function makeFacilityClient(market: FacilityMarket, baseline: TokenBaseline, getAccount: () => Address | null) {
  const rpc = new URL("/api/rpc", window.location.origin).href;
  const chain = defineChain({ id: market.chainId, name: market.chainId === 4663 ? "Robinhood Chain" : "Local test chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return new FacilityClient({ entry: market, baseline, chain, getAccount,
    loanHistory: (account, cursor) => loadFacilityLoans(market, account, cursor),
    client: createPublicClient({ chain, transport: http(rpc, { retryCount: 1, batch: { batchSize: 50, wait: 8 } }), pollingInterval: 1000 }) });
}
export type Directory = { checkedAt: number; capacity: bigint; quotes: AvailableQuote[] };
export async function loadFacilityLoans(market: FacilityMarket, account: Address, cursor?: bigint): Promise<FacilityLoanPage> {
  const query = new URLSearchParams({ chainId: String(market.chainId), facility: market.address, account, ...(cursor === undefined ? {} : { before: String(cursor) }) });
  const response = await fetch(`/api/facility-loans?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Loan history is unavailable. Your known loans can still be opened by number.");
  const data = await response.json();
  if (data.schemaVersion !== 1 || data.chainId !== market.chainId || !same(data.facility, market.address) || !same(data.account, account)
    || !Number.isSafeInteger(data.checkedAt) || data.checkedAt > Date.now() || Date.now() - data.checkedAt >= 30000
    || typeof data.complete !== "boolean" || data.status !== (data.complete ? "ready" : "syncing")
    || !Number.isSafeInteger(data.historyEpoch) || data.historyEpoch < 0 || !/^0x[0-9a-f]{64}$/i.test(data.blockHash)
    || uint(data.indexedThrough) > uint(data.blockNumber) || data.complete !== (data.indexedThrough === data.blockNumber)
    || !Array.isArray(data.rows) || data.rows.length > 20) throw new Error("Loan history could not be verified. Refresh before continuing.");
  let previous = cursor ?? (1n << 256n) - 1n;
  const rows = data.rows.map((row: any) => {
    const id = uint(row.id);
    if (id === 0n || id >= previous || ![1, 2, 3].includes(row.status) || !isAccount(row.borrower)
      || !same(account, market.lender) && !same(account, row.borrower)) throw new Error("Invalid loan history row.");
    previous = id;
    return { id, borrower: row.borrower as Address, principal: uint(row.principal), interest: uint(row.interest), dueAt: uint(row.dueAt), status: row.status };
  });
  const nextCursor = data.nextCursor === null ? null : uint(data.nextCursor);
  if (nextCursor !== null && (!rows.length || nextCursor !== rows.at(-1)!.id)) throw new Error("Invalid loan history page.");
  return { rows, checked: rows.length, nextCursor, indexComplete: data.complete, historyEpoch: data.historyEpoch };
}
export async function loadFacilityQuotes(market: FacilityMarket, account?: Address): Promise<Directory> {
  const query = new URLSearchParams({ chainId: String(market.chainId), facility: market.address, ...(account ? { account } : {}) });
  const response = await fetch(`/api/facility-quotes?${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Funded availability could not be checked. Refresh before borrowing.");
  const data = await response.json();
  if (data.chainId !== market.chainId || !same(data.facility, market.address) || data.status !== "checked"
    || !Number.isSafeInteger(data.checkedAt) || data.checkedAt > Date.now() || Date.now() - data.checkedAt >= 30000
    || !Array.isArray(data.quotes) || data.quotes.length > 100) throw new Error("The offer list is stale or could not be verified.");
  const quotes = data.quotes.map((row: any): AvailableQuote => {
    const envelope = parseSignedQuote(row.envelope), a = row.availability;
    if (envelope.chainId !== market.chainId || !same(envelope.facility, market.address) || row.id !== quoteDigest(envelope)
      || a?.status !== "available" || a.borrowerEligible !== true) throw new Error("Invalid lending offer.");
    const capacity = uint(a.capacity), minDraw = uint(a.minDraw), maxDraw = uint(a.maxDraw);
    if (minDraw === 0n || maxDraw < minDraw || capacity < maxDraw || capacity > uint(envelope.quote.capacity)) throw new Error("Invalid lending capacity.");
    return { id: row.id, envelope, availability: { status: "available", reason: null, borrowerEligible: true, capacity, minDraw, maxDraw } };
  });
  return { checkedAt: data.checkedAt, capacity: uint(data.capacity), quotes };
}
export async function publishFacilityQuote(envelope: ReturnType<typeof parseSignedQuote>) {
  const response = await fetch("/api/facility-quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The signed quote could not be published. Retry publication or cancel its nonce.");
  if (body.id !== quoteDigest(envelope)) throw new Error("The published quote could not be verified.");
  return body.id as string;
}
export function amount(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token precision is unavailable.");
  const pattern = decimals === 0 ? /^(?:0|[1-9][0-9]*)$/ : new RegExp(`^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${decimals}})?$`);
  if (!pattern.test(value)) throw new Error(`Enter a positive amount with at most ${decimals} decimal places.`);
  const result = parseUnits(value, decimals); if (result <= 0n || result >= 2n ** 256n) throw new Error("Enter a positive amount within the token limit.");
  return result;
}
export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const failMessage = (error: unknown) => error instanceof Error ? error.message.split("\n\n")[0]! : "The action failed. Refresh and try again.";
