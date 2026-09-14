import { isAddress, type Address, type Hex } from "viem";
import type { Deployment, Loan } from "./client";

export type ActiveLoansResult = {
  loans: Loan[];
  complete: boolean;
  status: "ready" | "syncing" | "unavailable";
  message: string | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  indexedThrough: bigint | null;
};
type Block = { number: bigint; hash: Hex | null };
type Options = {
  config: Pick<Deployment, "address" | "chainId" | "startBlock" | "version">;
  account: Address;
  targetBlock?: bigint;
  publicClient: {
    getChainId(): Promise<number>;
    getBlock(args: { blockNumber: bigint }): Promise<Block>;
  };
  readLoans(ids: readonly bigint[], blockNumber: bigint): Promise<Loan[]>;
  /** V3's owned active set, read at targetBlock with revision binding. */
  readActivePage?: (cursor: bigint, revision: bigint) => Promise<readonly [readonly bigint[], bigint, bigint]>;
  /** Supply the live account getter to reject a result after wallet switching. */
  getAccount?: () => Address | null;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const validUint = (value: unknown): value is string => typeof value === "string" && UINT.test(value) && BigInt(value) < 1n << 256n;
const unavailable = (message = "Active loan discovery is unavailable. Known loans remain available; retry loading."): ActiveLoansResult => ({
  loans: [], complete: false, status: "unavailable", message, blockNumber: null, blockHash: null, indexedThrough: null,
});

/**
 * The index is a discovery hint, never authority for ownership, status or writes.
 * Re-read every ID at the response's canonical block; callers may provide their
 * snapshot block to keep balances, deadlines and loan state consistent. An empty
 * incomplete result MUST NOT clear previously known obligations in the caller.
 */
export async function readActiveLoans(options: Options): Promise<ActiveLoansResult> {
  const { config, account, targetBlock, publicClient, readLoans, getAccount, signal } = options;
  const currentAccount = () => !getAccount || same(getAccount(), account);
  if (!currentAccount()) return unavailable("Wallet changed. Load active loans for the selected wallet.");
  try {
    if (!isAddress(config.address, { strict: false }) || !isAddress(account, { strict: false })
      || !validUint(config.startBlock) || (targetBlock !== undefined && (targetBlock < BigInt(config.startBlock) || targetBlock >= 1n << 256n))) throw new Error("Invalid active loan request");
    if (config.version === 3) return await readV3ActiveLoans(options);
    const query = new URLSearchParams({ market: config.address, account });
    if (targetBlock !== undefined) query.set("targetBlock", targetBlock.toString());
    const response = await (options.fetch ?? globalThis.fetch)(`/api/p2p/active-loans?${query}`, {
      cache: "no-store", credentials: "same-origin", signal,
    });
    if (!response.ok) return unavailable();
    const body = await response.json() as Record<string, unknown>;
    if (!body || body.schemaVersion !== 1 || body.chainId !== config.chainId
      || typeof body.market !== "string" || !same(body.market, config.address)
      || typeof body.account !== "string" || !same(body.account, account)
      || (body.status !== "ready" && body.status !== "syncing") || typeof body.complete !== "boolean"
      || body.complete !== (body.status === "ready") || !validUint(body.blockNumber)
      || typeof body.blockHash !== "string" || !HASH.test(body.blockHash)
      || typeof body.indexedThrough !== "string" || !/^-?[0-9]{1,78}$/.test(body.indexedThrough)
      || !Array.isArray(body.activeIds) || body.activeIds.length > 10_000) throw new Error("Invalid active loan response");
    const blockNumber = BigInt(body.blockNumber);
    const indexedThrough = BigInt(body.indexedThrough);
    if (blockNumber < BigInt(config.startBlock) || indexedThrough < BigInt(config.startBlock) - 1n
      || indexedThrough > blockNumber || (body.complete && indexedThrough !== blockNumber)
      || (targetBlock !== undefined && blockNumber !== targetBlock)) throw new Error("Invalid active loan block");
    const ids = body.activeIds.map(id => {
      if (!validUint(id) || BigInt(id) === 0n) throw new Error("Invalid active loan identifier");
      return BigInt(id);
    });
    if (new Set(ids.map(String)).size !== ids.length) throw new Error("Duplicate active loan identifiers");
    const [chainId, before] = await Promise.all([publicClient.getChainId(), publicClient.getBlock({ blockNumber })]);
    if (chainId !== config.chainId || before.number !== blockNumber || !same(before.hash, body.blockHash)) throw new Error("Active loan block is not canonical");
    const loans: Loan[] = [];
    for (let offset = 0; offset < ids.length; offset += 40) {
      if (!currentAccount() || signal?.aborted) throw new Error("Wallet changed");
      const requested = ids.slice(offset, offset + 40);
      const rows = await readLoans(requested, blockNumber);
      if (rows.length !== requested.length || new Set(rows.map(row => row.id.toString())).size !== rows.length
        || rows.some(row => !requested.includes(row.id) || (!same(row.lender, account) && !same(row.borrower, account)))) {
        throw new Error("Active loan index returned an unrelated loan");
      }
      // Status is taken from chain state, never from the discovery service.
      loans.push(...rows.filter(row => row.status === "active"));
    }
    const after = await publicClient.getBlock({ blockNumber });
    if (after.number !== blockNumber || !same(after.hash, body.blockHash)) throw new Error("Chain changed during active loan verification");
    if (!currentAccount() || signal?.aborted) return unavailable("Wallet changed. Load active loans for the selected wallet.");
    return { loans, complete: body.complete, status: body.status,
      message: body.complete ? null : "Active loan history is still syncing. Known loans remain available; retry loading.",
      blockNumber, blockHash: body.blockHash as Hex, indexedThrough };
  } catch {
    return unavailable(currentAccount() ? undefined : "Wallet changed. Load active loans for the selected wallet.");
  }
}

/** V3's on-chain active set excludes unsolicited proposals and closed offers. */
async function readV3ActiveLoans(options: Options): Promise<ActiveLoansResult> {
  const { config, account, targetBlock, publicClient, readActivePage, readLoans, getAccount, signal } = options;
  if (targetBlock === undefined || !readActivePage) throw new Error("V3 active loan reader unavailable");
  const [chainId, before] = await Promise.all([publicClient.getChainId(), publicClient.getBlock({ blockNumber: targetBlock })]);
  if (chainId !== config.chainId || before.number !== targetBlock || !before.hash || !HASH.test(before.hash)) throw new Error("Invalid V3 active loan block");
  const loans: Loan[] = [], seen = new Set<bigint>();
  let cursor = 0n, revision = 0n, complete = false;
  for (let page = 0; page < 250; page++) {
    if (signal?.aborted || (getAccount && !same(getAccount(), account))) throw new Error("Wallet changed or lookup cancelled");
    const [ids, next, currentRevision] = await readActivePage(cursor, revision);
    if (!Array.isArray(ids) || ids.length > 40 || typeof next !== "bigint" || next < 0n
      || typeof currentRevision !== "bigint" || currentRevision < 0n || (page > 0 && currentRevision !== revision)
      || (next !== 0n && (ids.length === 0 || next !== cursor + BigInt(ids.length)))
      || ids.some(id => typeof id !== "bigint" || id <= 0n || seen.has(id)) || new Set(ids).size !== ids.length) throw new Error("Invalid V3 active loan page");
    for (const id of ids) seen.add(id);
    const rows = ids.length ? await readLoans(ids, targetBlock) : [];
    if (rows.length !== ids.length || new Set(rows.map(row => row.id.toString())).size !== rows.length
      || rows.some(row => !ids.includes(row.id) || row.status !== "active" || (!same(row.borrower, account) && !same(row.lender, account)))) throw new Error("Invalid V3 owned active loan");
    loans.push(...rows); revision = currentRevision; cursor = next;
    if (next === 0n) { complete = true; break; }
  }
  const after = await publicClient.getBlock({ blockNumber: targetBlock });
  if (after.number !== targetBlock || !same(after.hash, before.hash) || signal?.aborted
    || (getAccount && !same(getAccount(), account))) throw new Error("V3 active loan snapshot changed");
  return { loans, complete, status: complete ? "ready" : "syncing", blockNumber: targetBlock, blockHash: before.hash,
    indexedThrough: targetBlock, message: complete ? null : "More active loans remain to be loaded. Known loans remain available." };
}
