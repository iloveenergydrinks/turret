import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isAddress, keccak256, parseAbi, verifyMessage } from "viem";
import { nftRequestActionMessage } from "../src/nft/requests-shared.mjs";

import { nftLendingAbi } from "../src/nft/abi.mjs";
const ABI = [...nftLendingAbi, ...parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
])];
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
  exactKeys(terms, ["principal", "collection", "tokenId", "interest", "durationDays", "expiresAt"]);
  if (![terms.principal, terms.tokenId, terms.interest].every(uint) || !address(terms.collection) || BigInt(terms.principal) === 0n
    || BigInt(terms.principal) + BigInt(terms.interest) > MAX
    || !Number.isSafeInteger(terms.durationDays) || terms.durationDays < 1
    || !Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= now || terms.expiresAt > maxExpiry
    || BigInt(terms.expiresAt) + BigInt(terms.durationDays) * 86400n + 86400n > BigInt(MAX_TIME)) {
    throw fail("Use exact positive amounts, nonnegative fixed interest, whole-day duration and an expiry within 30 days.");
  }
}

/** Atomic fsync/rename store. Mount this directory on a persistent volume in production. */
export function createNFTRequestPersistence(directory) {
  const destination = resolve(directory, "nft-borrower-requests-v1.json");
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
export function createNFTRequests({ markets, client, persistence, origin, now = () => Math.floor(Date.now() / 1000),
  verify = client?.verifyMessage ? args => client.verifyMessage(args) : verifyMessage, maxRecords = 10_000 } = {}) {
  let canonicalOrigin;
  try { canonicalOrigin = new URL(origin).origin; } catch { throw new Error("Configure a canonical P2P request origin."); }
  if (canonicalOrigin !== origin || !/^https?:\/\//.test(origin) || !Array.isArray(markets) || !client
    || !persistence?.read || !persistence?.write) throw new Error("Invalid P2P request service configuration.");
  const registeredMarkets = markets;
  const registry = new Map(registeredMarkets.map(market => {
    if (!address(market.address) || !address(market.loanToken)
      || !Array.isArray(market.collections) || !market.collections.length || !market.collections.every(address)
      || new Set(market.collections.map(x => x.toLowerCase())).size !== market.collections.length || !Number.isSafeInteger(market.chainId) || market.chainId < 1
      || market.version !== 1 || !HASH.test(market.runtimeHash)) throw new Error("Invalid P2P request market.");
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
    if (envelope.version === 2) {
      if (!["publish", "cancel"].includes(envelope.action)) throw fail("Refresh to use direct NFT loan offers.");
      if (envelope.action === "cancel") fields.push("terms");
    }
    exactKeys(envelope, ["version", "origin", "chainId", "market", "account", "action", "nonce", "issuedAt", "validUntil", ...fields]);
    if (![1, 2].includes(envelope.version) || envelope.origin !== origin || !address(envelope.account)
      || !HASH.test(envelope.nonce) || !Number.isSafeInteger(envelope.issuedAt) || !Number.isSafeInteger(envelope.validUntil)
      || envelope.issuedAt > now() + 30 || envelope.issuedAt < now() - 300 || envelope.validUntil <= now()
      || envelope.validUntil > envelope.issuedAt + 300 || envelope.validUntil <= envelope.issuedAt
      || (fields.includes("requestId") && !UUID.test(envelope.requestId))
      || (fields.includes("proposalId") && !UUID.test(envelope.proposalId))
      || (fields.includes("revision") && (!Number.isSafeInteger(envelope.revision) || envelope.revision < 1))
      || (fields.includes("offerId") && (!uint(envelope.offerId) || envelope.offerId === "0"))) throw fail("Invalid or expired signed request. Refresh and sign again.");
    const config = marketFor(envelope.market, envelope.chainId);
    if (same(envelope.account, config.address)) throw fail("A market contract cannot publish requests.");
    if (envelope.terms) {
      // Listing removal must remain possible after its expiry.
      if (envelope.action !== "cancel") validateTerms(envelope.terms, now());
      else { exactKeys(envelope.terms, ["principal", "collection", "tokenId", "interest", "durationDays", "expiresAt"]);
        if (![envelope.terms.principal, envelope.terms.interest, envelope.terms.tokenId].every(uint)
          || !Number.isSafeInteger(envelope.terms.expiresAt) || envelope.terms.expiresAt <= 0
          || envelope.terms.expiresAt > MAX_TIME || !Number.isSafeInteger(envelope.terms.durationDays) || envelope.terms.durationDays < 1) throw fail("Invalid listing terms."); }
      if (!config.collections.some(x => same(x, envelope.terms.collection))) throw fail("Choose a supported NFT collection.");
    }
    return config;
  }
  async function verifiedBlock(config) {
    if (await client.getChainId() !== config.chainId) throw fail("NFT RPC is on the wrong chain.", 503);
    const block = await client.getBlock();
    if (typeof block.number !== "bigint" || typeof block.timestamp !== "bigint" || !HASH.test(block.hash)) throw fail("Canonical block unavailable.", 503);
    const code = await client.getCode({ address: config.address, blockNumber: block.number });
    const token = await client.readContract({ address: config.address, abi: ABI, functionName: "loanToken", blockNumber: block.number });
    if (!code || !same(keccak256(code), config.runtimeHash) || !same(token, config.loanToken)) throw fail("NFT market identity verification failed.", 503);
    return block;
  }
  async function canonical(block) {
    const next = await client.getBlock({ blockNumber: block.number });
    if (next.number !== block.number || !same(next.hash, block.hash)) throw fail("The chain changed during verification. Retry.", 503);
  }
  async function verifyOwner(config, terms, borrower) {
    const block = await verifiedBlock(config);
    const read = (functionName, args, target = config.address) => client.readContract({ address: target, abi: ABI, functionName, args, blockNumber: block.number });
    const [allowed, paused, holder] = await Promise.all([
      read("allowedCollections", [terms.collection]), read("newLoansPaused", []),
      read("ownerOf", [BigInt(terms.tokenId)], terms.collection),
    ]);
    if (allowed !== true || paused !== false) throw fail("New loans for this collection are paused.", 409);
    if (!same(holder, borrower)) throw fail("The borrower no longer owns this NFT.", 409);
    await canonical(block);
  }
  async function verifyOffer(config, request, proposal, offerId) {
    const block = await verifiedBlock(config);
    const offer = await client.readContract({ address: config.address, abi: ABI, functionName: "getOffer", args: [BigInt(offerId)], blockNumber: block.number });
    const terms = proposal.terms;
    const previouslyLinked = proposal.fundedOffer?.id === offerId;
    if (!offer || !same(offer.lender, proposal.lender) || !same(offer.terms.borrower, request.borrower)
      || !same(offer.terms.collection, request.terms.collection) || offer.terms.tokenId !== BigInt(request.terms.tokenId)
      || offer.terms.principal !== BigInt(terms.principal) || offer.terms.interest !== BigInt(terms.interest)
      || offer.terms.duration !== BigInt(terms.durationDays) * 86400n || offer.terms.expiresAt !== BigInt(terms.expiresAt)
      || !(previouslyLinked ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4]).includes(Number(offer.status))) {
      throw fail("This offer does not match the signed parties, NFT and exact proposed terms.");
    }
    if (Number(offer.status) === 1) {
      if (offer.terms.expiresAt <= block.timestamp && !previouslyLinked) throw fail("The funded offer has already expired.");
      const balance = await client.readContract({ address: config.loanToken, abi: ABI, functionName: "balanceOf", args: [offer.vault], blockNumber: block.number });
      if (typeof balance !== "bigint" || balance < offer.terms.principal) throw fail("The offer's promised principal is not fully backed.");
    }
    await canonical(block);
    return { id: offerId, status: Number(offer.status) === 1 && offer.terms.expiresAt <= block.timestamp ? "expired" : ["none", "open", "active", "repaid", "defaulted", "cancelled", "expired"][Number(offer.status)],
      blockNumber: block.number.toString(), blockHash: block.hash, checkedAt: now() };
  }
  const accountCache = new Map();
  async function chainOffers(config, account, block) {
    const key = `${config.address}:${account}`.toLowerCase();
    const cached = accountCache.get(key);
    if (cached?.blockHash === block.hash) return cached.offers;
    const offers = [];
    let cursor = 0n;
    for (let page = 0; page < 100; page++) {
      const [ids, next] = await client.readContract({ address: config.address, abi: ABI, functionName: "accountOffers", args: [account, cursor, 30n], blockNumber: block.number });
      const batch = ids.length ? await client.readContract({ address: config.address, abi: ABI, functionName: "getOfferBatch", args: [ids], blockNumber: block.number }) : [];
      if (batch.length !== ids.length) throw fail("NFT offer history is incomplete. Retry shortly.", 503);
      offers.push(...batch.map((offer, i) => ({ ...offer, id: String(ids[i]) })));
      if (ids.length < 30) {
        if (accountCache.size > 300) accountCache.clear();
        accountCache.set(key, { blockHash: block.hash, offers }); return offers;
      }
      if (next <= cursor) break;
      cursor = next;
    }
    throw fail("NFT offer history could not be fully checked. Open My loans.", 503);
  }
  async function refreshRows(rows) {
    const blocks = new Map();
    for (const row of rows) {
      const config = marketFor(row.market);
      if (!blocks.has(config.address)) blocks.set(config.address, await verifiedBlock(config));
      const block = blocks.get(config.address);
      const related = new Map();
      for (const account of new Set([row.borrower, ...row.proposals.map(p => p.lender)])) {
        for (const offer of await chainOffers(config, account, block)) {
          if (same(offer.terms.collection, row.terms.collection) && offer.terms.tokenId === BigInt(row.terms.tokenId)
            && (same(offer.terms.borrower, row.borrower) || same(offer.terms.borrower, "0x0000000000000000000000000000000000000000"))) related.set(offer.id, offer);
        }
      }
      const status = o => Number(o.status) === 1 && o.terms.expiresAt <= block.timestamp ? "expired"
        : ["none", "open", "active", "repaid", "defaulted", "cancelled", "expired"][Number(o.status)];
      row.liveOffers = [...related.values()].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 100).map(o => ({
        id: o.id, lender: o.lender, status: status(o), checkedAt: now(), terms: { collection: o.terms.collection,
          tokenId: String(o.terms.tokenId), principal: String(o.terms.principal), interest: String(o.terms.interest),
          durationDays: Number(o.terms.duration / 86400n), expiresAt: Number(o.terms.expiresAt) } }));
      for (const proposal of row.proposals) {
        if (proposal.fundedOffer) proposal.fundedOffer = await verifyOffer(config, row, proposal, proposal.fundedOffer.id);
      }
    }
    for (const block of blocks.values()) await canonical(block);
    return rows;
  }
  return {
    origin,
    async list({ market, account, cursor, requestId } = {}) {
      if (market) marketFor(market);
      if (account && !address(account)) throw fail("Invalid wallet filter.");
      if (cursor && (!/^[1-9][0-9]{0,14}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw fail("Invalid request page.");
      if (requestId && !UUID.test(requestId)) throw fail("Invalid request identifier.");
      const page = await serialize(async () => {
        const saved = await load();
        const rows = saved.requests.filter(row => (!market || same(row.market, market)) && (!requestId || row.id === requestId)
          && (!account || same(row.borrower, account) || row.proposals.some(proposal => same(proposal.lender, account)))
          && (requestId || account || (row.status !== "cancelled" && row.terms.expiresAt > now()))
          && (!cursor || row.sequence < Number(cursor))).sort((a, b) => b.sequence - a.sequence);
        const selected = rows.slice(0, 30);
        return { schemaVersion: 1, origin, now: now(), requests: structuredClone(selected), nextCursor: rows.length > 30 ? String(selected.at(-1).sequence) : null };
      });
      page.requests = await refreshRows(page.requests);
      return page;
    },
    async submit({ envelope, signature } = {}) {
      const config = validateEnvelope(envelope);
      if (typeof signature !== "string" || !/^0x[0-9a-f]+$/i.test(signature) || signature.length > 4098) throw fail("Invalid wallet signature.");
      if (await client.getChainId() !== config.chainId) throw fail("Request signature verification RPC is on the wrong chain.", 503);
      if (!await verify({ address: envelope.account, message: nftRequestActionMessage(envelope), signature })) throw fail("The wallet signature does not match this action.", 401);
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
          await verifyOwner(config, envelope.terms, envelope.account);
          if (next.requests.some(item => same(item.terms.collection, envelope.terms.collection)
            && item.terms.tokenId === envelope.terms.tokenId && item.status !== "cancelled" && item.terms.expiresAt > now())) {
            throw fail("An active request already exists for this NFT.", 409);
          }
          // Keep a 30-day archive; on-chain positions are independent and remain discoverable in My loans.
          next.requests = next.requests.filter(item => item.terms.expiresAt > now() - 30 * 86400);
          if (next.requests.length >= maxRecords) throw fail("The request board is at capacity. Existing loans remain available.", 503);
          if (next.requests.filter(item => same(item.borrower, envelope.account) && item.status !== "cancelled" && item.terms.expiresAt > now()).length >= 5) throw fail("Cancel or let an existing request expire before publishing more than five active requests.", 409);
          row = { id: randomUUID(), sequence: next.nextSequence++, revision: 1, market: config.address,
            chainId: config.chainId, borrower: envelope.account, terms: envelope.terms, createdAt: now(), status: "open", proposals: [], acceptedProposalId: null };
          next.requests.push(row);
        } else {
          row = next.requests.find(item => item.id === envelope.requestId && same(item.market, config.address));
          if (!row) throw fail("Borrower request not found.", 404);
          if (!(envelope.version === 2 && envelope.action === "cancel") && row.revision !== envelope.revision) throw fail("This request changed. Refresh its terms before signing again.", 409);
          const proposal = row.proposals.find(item => item.id === envelope.proposalId);
          const borrower = same(row.borrower, envelope.account);
          if (envelope.action === "cancel") {
            if (!borrower) throw fail("Only the borrower can cancel this request.", 403);
            if (envelope.version === 2 && Object.keys(row.terms).some(key => String(row.terms[key]).toLowerCase() !== String(envelope.terms[key]).toLowerCase())) throw fail("The signed listing terms do not match.");
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
              if (!same(envelope.terms.collection, row.terms.collection) || envelope.terms.tokenId !== row.terms.tokenId) throw fail("A proposal cannot replace the listed NFT.");
              await verifyOwner(config, row.terms, row.borrower);
              row.proposals.push({ id: randomUUID(), lender: envelope.account, terms: envelope.terms, createdAt: now(), cancelled: false, fundedOffer: null });
            } else if (envelope.action === "accept") {
              if (!borrower) throw fail("Only the borrower can agree to proposed terms.", 403);
              if (!proposal || proposal.cancelled || proposal.terms.expiresAt <= now()) throw fail("This proposal is no longer available.", 409);
              await verifyOwner(config, row.terms, row.borrower);
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

export function createNFTRequestsHandler(service) {
  const rates = new Map();
  return async (request, response, headers = {}) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/api/p2p/nft/requests") return false;
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
