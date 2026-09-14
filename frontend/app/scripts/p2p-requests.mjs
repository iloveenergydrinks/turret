import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isAddress, keccak256, parseAbi, verifyMessage } from "viem";
import { requestActionMessage } from "../src/p2p/requests-shared.mjs";

const ABI = parseAbi([
  "function loanToken() view returns (address)", "function collateralToken() view returns (address)",
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
  "function vaults(uint256) view returns (address)", "function balanceOf(address) view returns (uint256)",
  "function reservedPrincipal() view returns (uint256)", "function totalCredits(address) view returns (uint256)",
]);
const HASH = /^0x[0-9a-f]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX = (1n << 256n) - 1n;
const MAX_TIME = 8_640_000_000_000;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const address = value => typeof value === "string" && isAddress(value, { strict: false }) && !/^0x0{40}$/i.test(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const uint = value => typeof value === "string" && UINT.test(value) && BigInt(value) <= MAX;
const object = value => value && typeof value === "object" && !Array.isArray(value);
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw fail("Unexpected or missing signed fields.");
}
function validateTerms(terms, now, maxExpiry = now + 30 * 86400) {
  exactKeys(terms, ["principal", "collateral", "interest", "durationDays", "expiresAt"]);
  if (![terms.principal, terms.collateral, terms.interest].every(uint) || BigInt(terms.principal) === 0n
    || BigInt(terms.collateral) === 0n || BigInt(terms.principal) + BigInt(terms.interest) > MAX
    || !Number.isSafeInteger(terms.durationDays) || terms.durationDays < 1
    || !Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= now || terms.expiresAt > maxExpiry
    || BigInt(terms.expiresAt) + BigInt(terms.durationDays) * 86400n + 86400n > BigInt(MAX_TIME)) {
    throw fail("Use exact positive amounts, nonnegative fixed interest, whole-day duration and an expiry within 30 days.");
  }
}

/** Atomic fsync/rename store. Mount this directory on a persistent volume in production. */
export function createFileRequestPersistence(directory) {
  const destination = resolve(directory, "borrower-requests-v1.json");
  return {
    async read() {
      try { return JSON.parse(await readFile(destination, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
    async write(value) {
      await mkdir(directory, { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, destination);
        const directoryHandle = await open(directory, "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    },
  };
}

/** Single writer service. Signed listings are informational; only existing contracts create debt. */
export function createP2PRequests({ markets, client, persistence, origin, now = () => Math.floor(Date.now() / 1000),
  verify = client?.verifyMessage ? args => client.verifyMessage(args) : verifyMessage, maxRecords = 10_000 } = {}) {
  let canonicalOrigin;
  try { canonicalOrigin = new URL(origin).origin; } catch { throw new Error("Configure a canonical P2P request origin."); }
  if (canonicalOrigin !== origin || !/^https?:\/\//.test(origin) || !Array.isArray(markets) || !client
    || !persistence?.read || !persistence?.write) throw new Error("Invalid P2P request service configuration.");
  const registeredMarkets = markets.filter(market => !market.legacy && (market.version ?? 1) >= 2);
  const registry = new Map(registeredMarkets.map(market => {
    if (!address(market.address) || !address(market.loanToken) || !address(market.collateralToken)
      || same(market.loanToken, market.collateralToken) || !Number.isSafeInteger(market.chainId) || market.chainId < 1
      || ![2, 3].includes(market.version) || !HASH.test(market.runtimeHash)) throw new Error("Invalid P2P request market.");
    return [market.address.toLowerCase(), market];
  }));
  if (registry.size !== registeredMarkets.length || new Set(registeredMarkets.map(market => market.chainId)).size > 1) throw new Error("Ambiguous P2P request market registry.");
  let state;
  let queue = Promise.resolve();
  const serialize = action => {
    const pending = queue.then(action); queue = pending.catch(() => {}); return pending;
  };
  async function load() {
    if (state) return state;
    const saved = await persistence.read();
    if (saved && (saved.schemaVersion !== 1 || saved.origin !== origin || !Array.isArray(saved.requests)
      || saved.requests.length > maxRecords || !Array.isArray(saved.usedNonces)
      || !Number.isSafeInteger(saved.nextSequence) || saved.nextSequence < 1)) throw fail("Borrower request storage is invalid; listings are unavailable.", 503);
    state = saved ?? { schemaVersion: 1, origin, nextSequence: 1, requests: [], usedNonces: [] };
    return state;
  }
  function marketFor(market, chainId) {
    const config = typeof market === "string" && registry.get(market.toLowerCase());
    if (!config || (chainId !== undefined && config.chainId !== chainId)) throw fail("Choose a current registered P2P market.");
    return config;
  }
  function validateEnvelope(envelope) {
    const fields = { publish: ["terms"], propose: ["requestId", "revision", "terms"], accept: ["requestId", "revision", "proposalId"],
      cancel: ["requestId", "revision"], cancelProposal: ["requestId", "revision", "proposalId"], bind: ["requestId", "revision", "proposalId", "offerId"] }[envelope?.action];
    if (!fields) throw fail("Unknown borrower request action.");
    exactKeys(envelope, ["version", "origin", "chainId", "market", "account", "action", "nonce", "issuedAt", "validUntil", ...fields]);
    if (envelope.version !== 1 || envelope.origin !== origin || !address(envelope.account)
      || !HASH.test(envelope.nonce) || !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validUntil)
      || envelope.issuedAt > now() + 30 || envelope.issuedAt < now() - 300 || envelope.validUntil <= now()
      || envelope.validUntil > envelope.issuedAt + 300 || envelope.validUntil <= envelope.issuedAt
      || (fields.includes("requestId") && !UUID.test(envelope.requestId))
      || (fields.includes("proposalId") && !UUID.test(envelope.proposalId))
      || (fields.includes("revision") && (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1))
      || (fields.includes("offerId") && (!uint(envelope.offerId) || envelope.offerId === "0"))) throw fail("Invalid or expired signed request. Refresh and sign again.");
    const config = marketFor(envelope.market, envelope.chainId);
    if (same(envelope.account, config.address)) throw fail("A market contract cannot publish requests.");
    if (envelope.terms) validateTerms(envelope.terms, now());
    return config;
  }
  async function verifyOffer(config, request, proposal, offerId) {
    if (await client.getChainId() !== config.chainId) throw fail("Request verification RPC is on the wrong chain.", 503);
    const block = await client.getBlock();
    if (typeof block.number !== "bigint" || block.number < 0n || typeof block.timestamp !== "bigint" || !HASH.test(block.hash)) throw fail("Canonical block is unavailable.", 503);
    const read = (functionName, args = [], target = config.address) => client.readContract({ address: target, abi: ABI, functionName, args, blockNumber: block.number });
    const [code, loanToken, collateralToken, offer] = await Promise.all([
      client.getCode({ address: config.address, blockNumber: block.number }), read("loanToken"), read("collateralToken"), read("offers", [BigInt(offerId)]),
    ]);
    const terms = proposal.terms;
    const previouslyLinked = proposal.fundedOffer?.id === offerId;
    if (!code || !same(keccak256(code), config.runtimeHash) || !same(loanToken, config.loanToken) || !same(collateralToken, config.collateralToken)) throw fail("Registered market identity verification failed.", 503);
    if (!Array.isArray(offer) || !same(offer[0], proposal.lender) || !same(offer[1], request.borrower)
      || offer[2] !== BigInt(terms.principal) || offer[3] !== BigInt(terms.collateral) || offer[4] !== BigInt(terms.interest)
      || offer[5] !== BigInt(terms.durationDays) * 86400n || offer[6] !== BigInt(terms.expiresAt)
      || !(previouslyLinked ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4]).includes(Number(offer[8]))) throw fail("This offer does not match the signed parties and exact proposed terms.");
    if (Number(offer[8]) === 1) {
      if (offer[6] <= block.timestamp && !previouslyLinked) throw fail("The funded offer has already expired.");
      const vault = config.version === 3 ? await read("vaults", [BigInt(offerId)]) : config.address;
      if (!address(vault)) throw fail("The offer custody address is unavailable.", 503);
      const balance = await read("balanceOf", [vault], config.loanToken);
      const required = config.version === 3 ? offer[2] : (await read("reservedPrincipal")) + (await read("totalCredits", [config.loanToken]));
      if (typeof balance !== "bigint" || typeof required !== "bigint") throw fail("The offer backing could not be verified.", 503);
      if (balance < required) throw fail("The offer's promised principal is not fully backed.");
    }
    const canonical = await client.getBlock({ blockNumber: block.number });
    if (canonical.number !== block.number || !same(canonical.hash, block.hash)) throw fail("The chain changed during offer verification. Retry.", 503);
    return { id: offerId, status: Number(offer[8]) === 1 && offer[6] <= block.timestamp ? "expired" : ["none", "open", "active", "repaid", "defaulted", "cancelled", "expired"][Number(offer[8])],
      blockNumber: block.number.toString(), blockHash: block.hash, checkedAt: now() };
  }
  return {
    origin,
    async list({ market, account, cursor, requestId } = {}) {
      if (market) marketFor(market);
      if (account && !address(account)) throw fail("Invalid wallet filter.");
      if (cursor && (!/^[1-9][0-9]{0,14}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw fail("Invalid request page.");
      if (requestId && !UUID.test(requestId)) throw fail("Invalid request identifier.");
      return serialize(async () => {
        const saved = await load();
        const rows = saved.requests.filter(row => (!market || same(row.market, market)) && (!requestId || row.id === requestId)
          && (!account || same(row.borrower, account) || row.proposals.some(proposal => same(proposal.lender, account)))
          && (requestId || account || (row.status !== "cancelled" && row.terms.expiresAt > now()))
          && (!cursor || row.sequence < Number(cursor))).sort((a, b) => b.sequence - a.sequence);
        const selected = rows.slice(0, 30);
        return { schemaVersion: 1, origin, now: now(), requests: structuredClone(selected), nextCursor: rows.length > 30 ? String(selected.at(-1).sequence) : null };
      });
    },
    async submit({ envelope, signature } = {}) {
      const config = validateEnvelope(envelope);
      if (typeof signature !== "string" || !/^0x[0-9a-f]+$/i.test(signature) || signature.length > 4098) throw fail("Invalid wallet signature.");
      if (await client.getChainId() !== config.chainId) throw fail("Request signature verification RPC is on the wrong chain.", 503);
      if (!await verify({ address: envelope.account, message: requestActionMessage(envelope), signature })) throw fail("The wallet signature does not match this action.", 401);
      return serialize(async () => {
        // Recheck time after signature RPC and queue delays.
        validateEnvelope(envelope);
        const next = structuredClone(await load());
        const key = `${envelope.account.toLowerCase()}:${envelope.nonce.toLowerCase()}`;
        next.usedNonces = next.usedNonces.filter(item => item.until > now());
        if (next.usedNonces.some(item => item.key === key)) throw fail("This signed action was already used. Refresh the request.", 409);
        if (next.usedNonces.filter(item => item.account === envelope.account.toLowerCase() && item.at > now() - 60).length >= 12) throw fail("Too many signed actions. Retry in a minute.", 429);
        let row;
        if (envelope.action === "publish") {
          if (next.requests.length >= maxRecords) throw fail("The request board is at capacity. Existing loans remain available.", 503);
          if (next.requests.filter(item => same(item.borrower, envelope.account) && item.status !== "cancelled" && item.terms.expiresAt > now()).length >= 5) throw fail("Cancel or let an existing request expire before publishing more than five active requests.", 409);
          row = { id: randomUUID(), sequence: next.nextSequence++, revision: 1, market: config.address,
            chainId: config.chainId, borrower: envelope.account, terms: envelope.terms, createdAt: now(), status: "open", proposals: [], acceptedProposalId: null };
          next.requests.push(row);
        } else {
          row = next.requests.find(item => item.id === envelope.requestId && same(item.market, config.address));
          if (!row) throw fail("Borrower request not found.", 404);
          if (row.revision !== envelope.revision) throw fail("This request changed. Refresh its terms before signing again.", 409);
          const proposal = row.proposals.find(item => item.id === envelope.proposalId);
          const borrower = same(row.borrower, envelope.account);
          if (envelope.action === "cancel") {
            if (!borrower) throw fail("Only the borrower can cancel this request.", 403);
            if (row.status === "cancelled") throw fail("This request is already cancelled.", 409);
            row.status = "cancelled";
          } else if (envelope.action === "bind") {
            if (!proposal || (!borrower && !same(proposal.lender, envelope.account))) throw fail("Only the named parties can link this funded offer.", 403);
            if (proposal.fundedOffer && proposal.fundedOffer.id !== envelope.offerId) throw fail("This proposal already has a linked offer.", 409);
            if (next.requests.some(item => item.proposals.some(p => p.fundedOffer?.id === envelope.offerId && same(item.market, row.market) && p.id !== proposal.id))) throw fail("This offer is already linked to another proposal.", 409);
            proposal.fundedOffer = await verifyOffer(config, row, proposal, envelope.offerId);
          } else {
            if (row.status === "cancelled" || row.terms.expiresAt <= now()) throw fail("This request has expired or was cancelled.", 409);
            if (envelope.action === "propose") {
              if (borrower) throw fail("Use a lender wallet different from the borrower.", 403);
              if (row.proposals.length >= 20) throw fail("This request reached its limit of 20 proposals. The borrower can publish a new request.", 409);
              if (row.proposals.filter(item => same(item.lender, envelope.account) && !item.cancelled && item.terms.expiresAt > now()).length >= 3) throw fail("Cancel an older proposal before adding more than three active proposals to this request.", 409);
              validateTerms(envelope.terms, now(), row.terms.expiresAt);
              row.proposals.push({ id: randomUUID(), lender: envelope.account, terms: envelope.terms, createdAt: now(), cancelled: false, fundedOffer: null });
            } else if (envelope.action === "accept") {
              if (!borrower) throw fail("Only the borrower can agree to proposed terms.", 403);
              if (!proposal || proposal.cancelled || proposal.terms.expiresAt <= now()) throw fail("This proposal is no longer available.", 409);
              row.acceptedProposalId = proposal.id; row.status = "agreed";
            } else {
              if (!proposal || !same(proposal.lender, envelope.account)) throw fail("Only its lender can cancel this proposal.", 403);
              if (proposal.cancelled) throw fail("This proposal was already cancelled.", 409);
              proposal.cancelled = true;
              if (row.acceptedProposalId === proposal.id) { row.acceptedProposalId = null; row.status = "open"; }
            }
          }
          row.revision++;
        }
        next.usedNonces.push({ key, account: envelope.account.toLowerCase(), at: now(), until: envelope.validUntil });
        try { await persistence.write(next); }
        catch (error) { state = undefined; throw error; } // A rename may have succeeded before a later fsync failed.
        state = next;
        return { schemaVersion: 1, origin, now: now(), request: structuredClone(row) };
      });
    },
  };
}

export function createP2PRequestsHandler(service) {
  const rates = new Map();
  return async (request, response, headers = {}) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/api/p2p/requests") return false;
    const send = (status, body) => { response.writeHead(status, { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      if (!service) throw fail("The borrower request board is not configured.", 503);
      if (request.method === "GET") {
        send(200, await service.list(Object.fromEntries(url.searchParams))); return true;
      }
      if (request.method !== "POST") { send(405, { error: "Use GET or POST." }); return true; }
      if (request.headers.origin !== service.origin || !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw fail("Use this website's signed request form.", 403);
      const timestamp = Date.now();
      for (const [key, rate] of rates) if (rate.reset < timestamp) rates.delete(key);
      const ip = request.socket.remoteAddress ?? "unknown";
      const rate = rates.get(ip) ?? { count: 0, reset: timestamp + 60_000 };
      if (rates.size >= 10_000 && !rates.has(ip)) throw fail("The board is busy. Retry shortly.", 429);
      rate.count++; rates.set(ip, rate);
      if (rate.count > 40) throw fail("Too many requests. Retry in a minute.", 429);
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (Buffer.byteLength(body) > 16_384) throw fail("Signed request is too large.", 413);
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw fail("Invalid request JSON."); }
      exactKeys(parsed, ["envelope", "signature"]);
      send(200, await service.submit(parsed));
    } catch (error) { send(error.status ?? 503, { error: error.status ? error.message : "The request board is unavailable. Retry without assuming your listing was saved." }); }
    return true;
  };
}
