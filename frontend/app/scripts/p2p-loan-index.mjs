import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isAddress, keccak256, parseAbi } from "viem";

const EVENTS = parseAbi([
  "event OfferAccepted(uint256 indexed id,uint256 dueAt,uint256 repaymentDeadline)",
  "event LoanRepaid(uint256 indexed id,address indexed payer,uint256 amount)",
  "event LoanDefaulted(uint256 indexed id)",
]);
const OFFER_ABI = parseAbi([
  "function nextOfferId() view returns (uint256)",
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
]);
const HASH = /^0x[0-9a-f]{64}$/i;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const validAddress = value => typeof value === "string" && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const idsSorted = values => [...values].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
function uint(value) {
  if (typeof value !== "string" || !UINT.test(value) || BigInt(value) >= 1n << 256n) throw fail("Invalid block or offer identifier", 400);
  return BigInt(value);
}
function header(block) {
  if (!block || typeof block.number !== "bigint" || block.number < 0n || !HASH.test(block.hash)) throw fail("Invalid canonical block");
  return { number: block.number, hash: block.hash.toLowerCase() };
}

/** Atomic, per-market checkpoints. Never stores wallets or browser-supplied paths. */
export function createFileLoanIndexPersistence(directory) {
  const path = key => {
    if (!/^[0-9]+-0x[0-9a-f]{40}$/.test(key)) throw new Error("Invalid checkpoint key");
    return resolve(directory, `${key}.json`);
  };
  return {
    async read(key) {
      try { return JSON.parse(await readFile(path(key), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
    async write(key, value) {
      await mkdir(directory, { recursive: true });
      const destination = path(key);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    },
  };
}

/**
 * Read-only event discovery for immutable V1/V2/V3 markets. The configured client is
 * trusted server infrastructure: request parameters cannot choose an RPC or market.
 * Checkpoints cover contiguous block ranges starting at the registered deployment.
 * Only accepted IDs enter the set, so unsolicited created/cancelled offers cost no
 * discovery slots. A bounded scan returns partial, explicitly incomplete results.
 */
export function createP2PLoanIndex({ markets, client, persistence, cache = new Map(),
  pageSize = 10_000n, maxPages = 4, retainedCheckpoints = 16, readBatchSize = 20,
  maxActiveCandidates = 10_000, maxLogsPerPage = 20_000, maxConcurrentSync = 4 } = {}) {
  if (!Array.isArray(markets) || !client || typeof pageSize !== "bigint" || pageSize < 1n || pageSize > 100_000n
    || ![maxPages, retainedCheckpoints, readBatchSize, maxActiveCandidates, maxLogsPerPage, maxConcurrentSync].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new Error("Invalid active loan index configuration");
  }
  const registry = new Map();
  for (const market of markets) {
    if (!market || !validAddress(market.address) || !Number.isSafeInteger(market.chainId) || market.chainId < 1
      || !HASH.test(market.runtimeHash) || ![1, 2, 3].includes(market.version ?? 1)) throw new Error("Invalid registered P2P market");
    const startBlock = uint(market.startBlock);
    const address = market.address.toLowerCase();
    if (registry.has(address) || (registry.size && registry.values().next().value.chainId !== market.chainId)) throw new Error("Ambiguous P2P registry");
    registry.set(address, { ...market, address, startBlock, key: `${market.chainId}-${address}` });
  }
  const pending = new Map();
  let running = 0;
  const initial = market => ({ schemaVersion: 1, chainId: market.chainId, market: market.address,
    startBlock: market.startBlock.toString(), runtimeHash: market.runtimeHash.toLowerCase(), checkpoints: [] });
  function validateSaved(market, saved) {
    if (!saved) return initial(market);
    const expected = initial(market);
    for (const field of ["schemaVersion", "chainId", "market", "startBlock", "runtimeHash"]) {
      if (saved[field] !== expected[field]) throw fail("Active loan checkpoint does not match the registered market");
    }
    if (!Array.isArray(saved.checkpoints) || saved.checkpoints.length > retainedCheckpoints) throw fail("Invalid active loan checkpoint");
    let previous = market.startBlock - 1n;
    for (const point of saved.checkpoints) {
      if (uint(point.blockNumber) <= previous || !HASH.test(point.blockHash) || !Array.isArray(point.activeIds)
        || point.activeIds.length > maxActiveCandidates || new Set(point.activeIds).size !== point.activeIds.length) throw fail("Invalid active loan checkpoint");
      for (const id of point.activeIds) if (uint(id) === 0n) throw fail("Invalid active loan checkpoint");
      previous = BigInt(point.blockNumber);
    }
    return structuredClone(saved);
  }
  async function canonical(number) {
    const block = header(await client.getBlock({ blockNumber: number }));
    if (block.number !== number) throw fail("RPC returned a different block");
    return block;
  }
  async function perform(market, requestedBlock) {
    if (await client.getChainId() !== market.chainId) throw fail("Active loan RPC is on the wrong chain");
    const latest = header(await client.getBlock());
    const targetNumber = requestedBlock === undefined ? latest.number : uint(requestedBlock);
    if (targetNumber > latest.number || targetNumber < market.startBlock) throw fail("Requested block is outside the market history", 400);
    const target = targetNumber === latest.number ? latest : await canonical(targetNumber);
    const code = await client.getCode({ address: market.address, blockNumber: target.number });
    if (!code || !same(keccak256(code), market.runtimeHash)) throw fail("Active loan market runtime verification failed");
    let saved = cache.get(market.key);
    if (!saved) saved = validateSaved(market, await persistence?.read(market.key));
    // In these runtime-verified immutable contracts the counter starts at one
    // and never decreases. Exactly one proves no offer has ever been created at
    // this block, unlike a zero token balance or zero outstanding principal.
    const nextOfferId = await client.readContract({ address: market.address, abi: OFFER_ABI, functionName: "nextOfferId", blockNumber: target.number });
    if (typeof nextOfferId !== "bigint" || nextOfferId < 1n || nextOfferId >= 1n << 256n) throw fail("Invalid offer counter");
    if (nextOfferId === 1n) {
      if (!same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed during empty-market verification");
      const empty = { ...initial(market), checkpoints: [{ blockNumber: target.number.toString(), blockHash: target.hash, activeIds: [] }] };
      if (!saved.checkpoints.some(point => BigInt(point.blockNumber) > target.number)) {
        await persistence?.write(market.key, empty); cache.set(market.key, empty);
      }
      if (!same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed during empty-market verification");
      return { blockNumber: target.number.toString(), blockHash: target.hash, indexedThrough: target.number.toString(), complete: true, status: "ready", loans: [] };
    }
    // Rewind to a canonical retained checkpoint. Deep reorgs rebuild from the
    // deployment block; trusting an orphaned active set could omit real loans.
    let chosen = -1;
    for (let i = saved.checkpoints.length - 1; i >= 0; --i) {
      const point = saved.checkpoints[i];
      if (BigInt(point.blockNumber) > target.number) continue;
      const observed = await canonical(BigInt(point.blockNumber));
      if (same(observed.hash, point.blockHash)) { chosen = i; break; }
    }
    let working = { ...saved, checkpoints: saved.checkpoints.slice(0, chosen + 1) };
    const checkpoint = working.checkpoints.at(-1);
    let through = checkpoint ? BigInt(checkpoint.blockNumber) : market.startBlock - 1n;
    const active = new Set(checkpoint?.activeIds ?? []);
    // Historical snapshot requests must not replace a newer valid checkpoint.
    const historical = requestedBlock !== undefined && saved.checkpoints.some(p => BigInt(p.blockNumber) > target.number);
    for (let page = 0; page < maxPages && through < target.number; ++page) {
      const fromBlock = through + 1n;
      const toBlock = fromBlock + pageSize - 1n < target.number ? fromBlock + pageSize - 1n : target.number;
      const end = await canonical(toBlock);
      const logs = await client.getLogs({ address: market.address, events: EVENTS, strict: true, fromBlock, toBlock });
      if (!Array.isArray(logs) || logs.length > maxLogsPerPage) throw fail("Active loan event page exceeds the supported limit");
      const hashes = new Map();
      const positions = new Set();
      for (const log of logs) {
        if (!same(log.address, market.address) || log.removed || typeof log.blockNumber !== "bigint"
          || log.blockNumber < fromBlock || log.blockNumber > toBlock || !HASH.test(log.blockHash)
          || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
          || !["OfferAccepted", "LoanRepaid", "LoanDefaulted"].includes(log.eventName)
          || typeof log.args?.id !== "bigint" || log.args.id <= 0n) throw fail("Invalid active loan event page");
        const position = `${log.blockNumber}:${log.logIndex}`;
        if (positions.has(position) || (hashes.has(log.blockNumber) && !same(hashes.get(log.blockNumber), log.blockHash))) throw fail("Inconsistent active loan events");
        positions.add(position); hashes.set(log.blockNumber, log.blockHash);
      }
      for (const [number, hash] of hashes) if (!same((await canonical(number)).hash, hash)) throw fail("Chain changed during active loan discovery");
      logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
      for (const log of logs) {
        const id = log.args.id.toString();
        if (log.eventName === "OfferAccepted") active.add(id); else active.delete(id);
      }
      if (active.size > maxActiveCandidates) throw fail("Active loan index capacity reached");
      if (!same((await canonical(toBlock)).hash, end.hash) || !same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed during active loan discovery");
      through = toBlock;
      working = { ...working, checkpoints: [...working.checkpoints, { blockNumber: through.toString(), blockHash: end.hash, activeIds: idsSorted(active) }].slice(-retainedCheckpoints) };
      // A checkpoint becomes visible only after its atomic persistence succeeds.
      if (!historical) { await persistence?.write(market.key, working); cache.set(market.key, working); }
    }
    const candidates = idsSorted(active);
    const loans = [];
    for (let offset = 0; offset < candidates.length; offset += readBatchSize) {
      const rows = await Promise.all(candidates.slice(offset, offset + readBatchSize).map(async id => {
        const offer = await client.readContract({ address: market.address, abi: OFFER_ABI, functionName: "offers", args: [BigInt(id)], blockNumber: target.number });
        if (!Array.isArray(offer) || offer.length !== 9 || !validAddress(offer[0]) || !validAddress(offer[1])
          || !Number.isInteger(offer[8]) || offer[8] < 2 || offer[8] > 4) throw fail("Invalid accepted loan state");
        return offer[8] === 2 ? { id, lender: offer[0].toLowerCase(), borrower: offer[1].toLowerCase() } : null;
      }));
      loans.push(...rows.filter(Boolean));
    }
    if (!same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed while verifying active loans");
    return { blockNumber: target.number.toString(), blockHash: target.hash, indexedThrough: through.toString(),
      complete: through === target.number, status: through === target.number ? "ready" : "syncing", loans };
  }
  async function syncMarket(address, targetBlock) {
    const market = registry.get(typeof address === "string" ? address.toLowerCase() : "");
    if (!market) throw fail("Market is not registered", 400);
    if (targetBlock !== undefined) uint(targetBlock);
    // Serialize different targets for one market; coalesce identical work. No
    // account appears in this cache, and account filtering happens after syncing.
    const existing = pending.get(market.key);
    if (existing) {
      if (existing.targetBlock === targetBlock) return existing.promise;
      await existing.promise.catch(() => {});
      return syncMarket(address, targetBlock);
    }
    if (running >= maxConcurrentSync) throw fail("Active loan discovery is busy; retry shortly");
    running++;
    const promise = perform(market, targetBlock).finally(() => { running--; pending.delete(market.key); });
    pending.set(market.key, { targetBlock, promise });
    return promise;
  }
  async function getActiveLoans({ market: address, account, targetBlock }) {
    const market = registry.get(typeof address === "string" ? address.toLowerCase() : "");
    if (!market || !validAddress(account)) throw fail("Invalid market or account", 400);
    if (targetBlock !== undefined) uint(targetBlock);
    const identity = { schemaVersion: 1, chainId: market.chainId, market: market.address, account: account.toLowerCase() };
    try {
      const { loans, ...snapshot } = await syncMarket(market.address, targetBlock);
      return { ...identity, ...snapshot, activeIds: loans.filter(o => same(o.borrower, account) || same(o.lender, account)).map(o => o.id) };
    } catch (error) {
      if (error.status === 400) throw error;
      return { ...identity, blockNumber: null, blockHash: null, indexedThrough: null, complete: false,
        status: "unavailable", activeIds: [], error: "Active loan discovery is unavailable. Keep known loans visible and retry." };
    }
  }
  return { getActiveLoans, syncMarket, markets: [...registry.values()].map(m => m.address) };
}

export function createP2PActiveLoansHandler(index) {
  let activeRequests = 0;
  return async (request, response, headers = {}) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/api/p2p/active-loans") return false;
    const send = (status, body) => { response.writeHead(status, { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body)); return true; };
    if (request.method !== "GET") return send(405, { complete: false, status: "unavailable", error: "Use GET" });
    if ([...url.searchParams.keys()].some(key => !["market", "account", "targetBlock"].includes(key))
      || ["market", "account"].some(key => url.searchParams.getAll(key).length !== 1)
      || url.searchParams.getAll("targetBlock").length > 1) return send(400, { complete: false, status: "unavailable", error: "Invalid query" });
    if (activeRequests >= 32) return send(503, { complete: false, status: "unavailable", error: "Active loan discovery is busy; retry shortly" });
    activeRequests++;
    try {
      const result = await index.getActiveLoans({ market: url.searchParams.get("market"), account: url.searchParams.get("account"), targetBlock: url.searchParams.get("targetBlock") ?? undefined });
      return send(result.status === "unavailable" ? 503 : 200, result);
    } catch (error) { return send(error.status === 400 ? 400 : 503, { complete: false, status: "unavailable", error: error.status === 400 ? error.message : "Active loan discovery unavailable" }); }
    finally { activeRequests--; }
  };
}
