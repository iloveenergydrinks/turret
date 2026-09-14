import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decodeEventLog, encodeFunctionData, isAddress, keccak256, parseAbi, verifyMessage } from "viem";
import { canonicalNegotiation, negotiationMessage } from "../src/p2p/negotiations-shared.mjs";

const ABI = parseAbi([
  "function loanToken() view returns (address)",
  "function collateralToken() view returns (address)",
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
  "function vaults(uint256) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function loanCredit(uint256,address) view returns (address beneficiary,uint256 nominal,uint256 available)",
  "function cancelOffer(uint256)",
  "function createOffer(address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt) returns (uint256)",
  "event OfferCreated(uint256 indexed id,address indexed lender,address indexed borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt)",
]);
const HASH = /^0x[0-9a-f]{64}$/i, UUID = /^[0-9a-f-]{36}$/i;
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const zero = (a) => /^0x0{40}$/i.test(a);
const address = (a) => typeof a === "string" && isAddress(a, { strict: false }) && !zero(a);
const uint = (v) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (v) => createHash("sha256").update(canonicalNegotiation(v)).digest("hex");
function keys(value, expected) {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== expected.sort().join()
  ) throw fail("Unexpected or missing signed fields.");
}
export function negotiationTerms(terms, now) {
  keys(terms, ["principal", "collateral", "interest", "durationDays", "expiresAt"]);
  if (
    ![terms.principal, terms.collateral, terms.interest].every(uint) || BigInt(terms.principal) === 0n
    || BigInt(terms.collateral) === 0n
    || BigInt(terms.principal) + BigInt(terms.interest) >= 1n << 256n || !Number.isSafeInteger(terms.durationDays)
    || terms.durationDays < 1
    || !Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= now
    || BigInt(terms.expiresAt) + BigInt(terms.durationDays) * 86400n + 86400n > 8_640_000_000_000n
  ) throw fail("Check exact amounts, whole-day duration and future offer expiry.");
}
export function createP2PNegotiations(
  {
    markets,
    client,
    origin,
    filename = ":memory:",
    now = () => Math.floor(Date.now() / 1000),
    verify = client?.verifyMessage
      ? (args) => client.verifyMessage(args)
      : verifyMessage,
  },
) {
  if (new URL(origin).origin !== origin) throw new Error("Use a canonical negotiation origin.");
  const registry = new Map(
    markets.filter((m) => m.version === 3 && !m.legacy).map((m) => [m.address.toLowerCase(), m]),
  );
  if (
    [...registry.values()].some((m) =>
      !address(m.address) || !address(m.loanToken) || !address(m.collateralToken) || !HASH.test(m.runtimeHash)
    )
  ) throw new Error("Invalid negotiation registry.");
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS config (origin TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS threads (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,source TEXT NOT NULL,borrower TEXT NOT NULL,lender TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS borrower_threads ON threads(borrower,seq);
    CREATE INDEX IF NOT EXISTS lender_threads ON threads(lender,seq);
    CREATE UNIQUE INDEX IF NOT EXISTS active_conversation ON threads(source,borrower) WHERE state!='closed';
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,thread TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS thread_events ON events(thread,seq);
    CREATE TABLE IF NOT EXISTS selections (source TEXT PRIMARY KEY,thread TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nonces (key TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,account TEXT NOT NULL,until INTEGER NOT NULL);
  `);
  const savedOrigin = db.prepare("SELECT origin FROM config").get();
  if (savedOrigin && savedOrigin.origin !== origin) throw new Error("Negotiation storage belongs to another origin.");
  if (!savedOrigin) db.prepare("INSERT INTO config VALUES (?)").run(origin);
  const get = (id) => {
    const record = db.prepare("SELECT data FROM threads WHERE id=?").get(id);
    return record ? JSON.parse(record.data) : null;
  };
  const participant = (row, account) => row && (same(row.borrower, account) || same(row.lender, account));
  const visible = (id, account) => {
    const row = get(id);
    if (!participant(row, account)) throw fail("Conversation unavailable.", 404);
    return row;
  };
  const marketFor = (market, chainId) => {
    const m = typeof market === "string" && registry.get(market.toLowerCase());
    if (!m || m.chainId !== chainId) throw fail("Choose a current V3 market.");
    return m;
  };
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const pack = (row) => ({ origin, now: now(), thread: row });
  function checkEnvelope(e) {
    const extras = {
      login: [],
      open: ["offerId", "sourceDigest", "terms", "responseBy"],
      counter: ["threadId", "revision", "proposalId", "terms", "responseBy"],
      agree: ["threadId", "revision", "proposalId"],
      close: ["threadId", "revision", "proposalId"],
      start: ["threadId", "revision", "proposalId"],
      cancelled: ["threadId", "revision", "proposalId", "hash"],
      prepare: ["threadId", "revision", "proposalId"],
      bind: ["threadId", "revision", "proposalId", "hash"],
    }[e?.action];
    if (!extras) throw fail("Unknown negotiation action.");
    if (extras.includes("threadId")) extras.push("context");
    keys(e, [
      "version",
      "origin",
      "account",
      "market",
      "chainId",
      "action",
      "nonce",
      "issuedAt",
      "validUntil",
      ...extras,
    ]);
    if (
      e.version !== 1 || e.origin !== origin || !address(e.account) || !HASH.test(e.nonce)
      || !Number.isSafeInteger(e.issuedAt) || !Number.isSafeInteger(e.validUntil)
      || e.issuedAt > now() + 30 || e.issuedAt < now() - 300 || e.validUntil <= now() || e.validUntil > e.issuedAt + 300
      || e.validUntil <= e.issuedAt
    ) throw fail("Signature expired or invalid. Refresh and sign again.");
    const config = marketFor(e.market, e.chainId);
    if (same(e.account, config.address)) throw fail("Invalid participant.");
    if (
      e.threadId
      && (!UUID.test(e.threadId) || !UUID.test(e.proposalId) || !Number.isSafeInteger(e.revision) || e.revision < 1)
    ) throw fail("Invalid conversation revision.");
    if (e.action === "open" && (!uint(e.offerId) || e.offerId === "0" || !/^[0-9a-f]{64}$/.test(e.sourceDigest))) {
      throw fail("Invalid source offer.");
    }
    if (e.hash && !HASH.test(e.hash)) throw fail("Invalid transaction hash.");
    if (e.terms) {
      negotiationTerms(e.terms, now());
      if (!Number.isSafeInteger(e.responseBy) || e.responseBy <= now() || e.responseBy >= e.terms.expiresAt) {
        throw fail("Respond-by time must be before the offer expiry.");
      }
    }
    return config;
  }
  async function source(config, id) {
    if (await client.getChainId() !== config.chainId) throw fail("Verification RPC is on the wrong chain.", 503);
    const block = await client.getBlock();
    if (typeof block.number !== "bigint" || typeof block.timestamp !== "bigint" || !HASH.test(block.hash)) {
      throw fail("Chain state unavailable.", 503);
    }
    const read = (functionName, args = [], target = config.address) =>
      client.readContract({ address: target, abi: ABI, functionName, args, blockNumber: block.number });
    const [code, loanToken, collateralToken, offer] = await Promise.all([
      client.getCode({ address: config.address, blockNumber: block.number }),
      read("loanToken"),
      read("collateralToken"),
      read("offers", [BigInt(id)]),
    ]);
    if (
      !code || !same(keccak256(code), config.runtimeHash) || !same(loanToken, config.loanToken)
      || !same(collateralToken, config.collateralToken)
    ) throw fail("Registered contract identity mismatch.", 503);
    if (!offer || !address(offer[0]) || Number(offer[8]) < 1) throw fail("Offer unavailable.", 404);
    const terms = {
      principal: offer[2].toString(),
      collateral: offer[3].toString(),
      interest: offer[4].toString(),
      durationDays: Number(offer[5] / 86400n),
      expiresAt: Number(offer[6]),
    };
    const snapshot = {
      market: config.address,
      chainId: config.chainId,
      id,
      lender: offer[0],
      borrower: offer[1],
      terms,
    };
    const result = {
      ...snapshot,
      digest: digest(snapshot),
      status: Number(offer[8]),
      now: Number(block.timestamp),
      blockNumber: block.number.toString(),
      blockHash: block.hash,
    };
    if (result.status === 1) {
      const vault = await read("vaults", [BigInt(id)]);
      if (!address(vault)) throw fail("Offer custody unavailable.", 503);
      result.backed = (await read("balanceOf", [vault], config.loanToken)) >= offer[2];
    } else if ([5, 6].includes(result.status)) {
      const credit = await read("loanCredit", [BigInt(id), config.loanToken]);
      result.credit = { beneficiary: credit[0], nominal: credit[1].toString(), available: credit[2].toString() };
    }
    const canonical = await client.getBlock({ blockNumber: block.number });
    if (!same(canonical.hash, block.hash)) throw fail("Chain changed during verification. Retry.", 503);
    return result;
  }
  function sourceOpen(s) {
    if (s.status !== 1 || s.terms.expiresAt <= Math.max(now(), s.now) || !s.backed) {
      throw fail("Original offer is no longer open, funded and available.", 409);
    }
  }
  async function receipt(config, hash, account, input) {
    const [tx, r] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    if (
      !same(tx.from, account) || !same(tx.to, config.address) || tx.value !== 0n || !same(tx.input, input)
      || r.status !== "success" || !same(r.transactionHash, hash) || !same(r.from, account)
    ) throw fail("Transaction does not match this replacement step.");
    const block = await client.getBlock({ blockNumber: r.blockNumber });
    if (!same(block.hash, r.blockHash)) throw fail("Transaction confirmation changed. Retry.", 503);
    return r;
  }
  function session(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
      throw fail("Unlock conversations with your wallet.", 401);
    }
    const value = db.prepare("SELECT account,until FROM sessions WHERE token=?").get(digest(token));
    if (!value || value.until <= now()) throw fail("Conversation session expired. Unlock again.", 401);
    return value.account;
  }
  const service = {
    origin,
    close: () => db.close(),
    async inspect(market, chainId, id, token) {
      const account = session(token), config = marketFor(market, chainId), s = await source(config, id);
      if (!zero(s.borrower) && !same(s.borrower, account) && !same(s.lender, account)) {
        throw fail(
          "Offer unavailable.",
          404,
        );
      }
      return { origin, now: now(), source: s };
    },
    list(token, { id, cursor } = {}) {
      const account = session(token).toLowerCase();
      if (cursor && !/^[1-9][0-9]{0,14}$/.test(cursor)) throw fail("Invalid page.");
      if (id) {
        const row = visible(id, account);
        const events = db.prepare("SELECT seq,data FROM events WHERE thread=? AND seq<? ORDER BY seq DESC LIMIT 31")
          .all(id, Number(cursor) || Number.MAX_SAFE_INTEGER);
        return {
          ...pack(row),
          events: events.slice(0, 30).map((e) => JSON.parse(e.data)),
          nextCursor: events.length > 30 ? String(events[29].seq) : null,
        };
      }
      if (cursor && !/^[1-9][0-9]{0,14}$/.test(cursor)) throw fail("Invalid page.");
      const rows = db.prepare(
        "SELECT seq,data FROM threads WHERE (borrower=? OR lender=?) AND seq<? ORDER BY seq DESC LIMIT 31",
      ).all(account, account, Number(cursor) || Number.MAX_SAFE_INTEGER);
      return {
        origin,
        now: now(),
        threads: rows.slice(0, 30).map((r) => JSON.parse(r.data)),
        nextCursor: rows.length > 30 ? String(rows[29].seq) : null,
      };
    },
    async preflight(token, id, attempt) {
      const row = visible(id, session(token));
      if (!same(row.lender, session(token)) || row.state !== "funding" || row.attempt !== attempt) {
        throw fail(
          "Replacement attempt changed. Refresh.",
          409,
        );
      }
      const s = await source(marketFor(row.market, row.chainId), row.offerId);
      if (
        s.status !== 5 || s.digest !== row.sourceDigest || s.credit?.nominal !== "0" || !row.cancelHash
        || row.latest.terms.expiresAt <= Math.max(now(), s.now)
      ) throw fail("Original funds are not fully recovered or replacement expired.", 409);
      await receipt(
        marketFor(row.market, row.chainId),
        row.cancelHash,
        row.lender,
        encodeFunctionData({ abi: ABI, functionName: "cancelOffer", args: [BigInt(row.offerId)] }),
      );
      const fresh = visible(id, session(token));
      if (fresh.revision !== row.revision || fresh.attempt !== attempt) {
        throw fail("Replacement changed. Refresh.", 409);
      }
      return pack(fresh);
    },
    async submit({ envelope: e, signature }) {
      const config = checkEnvelope(e);
      if (typeof signature !== "string" || !/^0x[0-9a-f]+$/i.test(signature) || signature.length > 4098) {
        throw fail(
          "Invalid signature.",
        );
      }
      if (await client.getChainId() !== config.chainId) throw fail("Signature RPC is on the wrong chain.", 503);
      if (!await verify({ address: e.account, message: negotiationMessage(e), signature })) {
        throw fail(
          "Wallet signature does not match.",
          401,
        );
      }
      const nonceKey = `${e.account.toLowerCase()}:${e.nonce.toLowerCase()}`,
        requestHash = digest({ envelope: e, signature });
      const prior = db.prepare("SELECT hash,result FROM nonces WHERE key=?").get(nonceKey);
      if (prior) {
        if (prior.hash !== requestHash) throw fail("Nonce already used for different terms.", 409);
        return JSON.parse(prior.result);
      }
      let row = e.threadId ? visible(e.threadId, e.account) : null, s = null, linked = null;
      if (
        row
        && (row.market.toLowerCase() !== config.address.toLowerCase() || row.revision !== e.revision
          || row.latest.id !== e.proposalId
          || canonicalNegotiation(e.context)
            !== canonicalNegotiation({
              sourceDigest: row.sourceDigest,
              lender: row.lender,
              borrower: row.borrower,
              proposalTerms: row.latest.terms,
            }))
      ) throw fail("Conversation changed. Refresh before signing.", 409);
      if (!["login", "close"].includes(e.action)) {
        s = await source(config, row?.offerId ?? e.offerId);
        if (s.digest !== (row?.sourceDigest ?? e.sourceDigest)) throw fail("Source offer terms changed.", 409);
      }
      if (e.action === "cancelled") {
        if (!row.cancelAfterBlock || s.status !== 5) throw fail("Original offer is not cancelled.", 409);
        const r = await receipt(
          config,
          e.hash,
          row.lender,
          encodeFunctionData({ abi: ABI, functionName: "cancelOffer", args: [BigInt(row.offerId)] }),
        );
        if (r.blockNumber <= BigInt(row.cancelAfterBlock)) throw fail("Cancellation predates the agreed replacement.");
      }
      if (e.action === "bind") {
        if (s.status !== 5 || s.credit?.nominal !== "0" || !row.cancelHash) {
          throw fail(
            "Original cancellation or recovery is no longer confirmed.",
            409,
          );
        }
        await receipt(
          config,
          row.cancelHash,
          row.lender,
          encodeFunctionData({ abi: ABI, functionName: "cancelOffer", args: [BigInt(row.offerId)] }),
        );
        const t = row.latest.terms;
        const input = encodeFunctionData({
          abi: ABI,
          functionName: "createOffer",
          args: [
            row.borrower,
            BigInt(t.principal),
            BigInt(t.collateral),
            BigInt(t.interest),
            BigInt(t.durationDays) * 86400n,
            BigInt(t.expiresAt),
          ],
        });
        const r = await receipt(config, e.hash, row.lender, input);
        if (!row.fundAfterBlock || r.blockNumber <= BigInt(row.fundAfterBlock)) {
          throw fail(
            "Funding predates this replacement attempt.",
          );
        }
        const events = r.logs.filter((log) => same(log.address, config.address)).flatMap((log) => {
          try {
            const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
            return event.eventName === "OfferCreated" ? [event] : [];
          } catch {
            return [];
          }
        });
        if (events.length !== 1) throw fail("One verified replacement offer is required.");
        linked = await source(config, events[0].args.id.toString());
        if (
          !same(linked.lender, row.lender) || !same(linked.borrower, row.borrower)
          || canonicalNegotiation(linked.terms) !== canonicalNegotiation(t) || (linked.status === 1 && !linked.backed)
        ) throw fail("Replacement parties, terms or backing do not match.");
      }
      return transaction(() => {
        checkEnvelope(e);
        const duplicate = db.prepare("SELECT hash,result FROM nonces WHERE key=?").get(nonceKey);
        if (duplicate) {
          if (duplicate.hash !== requestHash) throw fail("Nonce conflict.", 409);
          return JSON.parse(duplicate.result);
        }
        if (
          db.prepare("SELECT count(*) n FROM nonces WHERE key LIKE ? AND at>?").get(
            `${e.account.toLowerCase()}:%`,
            now() - 60,
          ).n >= 12
        ) throw fail("Too many signed actions. Retry in a minute.", 429);
        let result;
        if (e.action === "login") {
          const token = randomBytes(32).toString("hex"), until = now() + 3600;
          db.prepare("DELETE FROM sessions WHERE until<=?").run(now());
          db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(digest(token), e.account.toLowerCase(), until);
          result = { origin, token, until, account: e.account };
        } else {
          if (row) {
            row = visible(e.threadId, e.account);
            if (row.revision !== e.revision || row.latest.id !== e.proposalId) {
              throw fail("Conversation changed. Refresh.", 409);
            }
          }
          if (e.action === "open") {
            sourceOpen(s);
            if (same(s.lender, e.account) || (!zero(s.borrower) && !same(s.borrower, e.account))) {
              throw fail("Only an eligible borrower can counter this offer.", 403);
            }
            if (e.responseBy >= s.terms.expiresAt) {
              throw fail("Respond-by time must precede the original offer expiry.");
            }
            const sourceKey = `${config.chainId}:${config.address.toLowerCase()}:${e.offerId}`;
            if (
              db.prepare("SELECT id FROM threads WHERE source=? AND borrower=? AND state!='closed'").get(
                sourceKey,
                e.account.toLowerCase(),
              )
            ) {
              throw fail("A conversation already exists. Open Negotiations to continue it.", 409);
            }
            row = {
              id: randomUUID(),
              market: config.address,
              chainId: config.chainId,
              offerId: e.offerId,
              sourceKey,
              sourceDigest: s.digest,
              original: s.terms,
              lender: s.lender,
              borrower: e.account,
              revision: 1,
              state: "open",
              createdAt: now(),
            };
          } else {
            if (e.action === "close") {
              if (["replacing", "recovering", "funding", "funded"].includes(row.state)) {
                throw fail("Replacement has started. Keep its recovery history and manage the onchain offer.", 409);
              }
              row.state = "closed";
              db.prepare("DELETE FROM selections WHERE thread=?").run(row.id);
            } else if (e.action === "counter" || e.action === "agree") {
              sourceOpen(s);
              if (row.state !== "open" || row.latest.responseBy <= Math.max(now(), s.now)) {
                throw fail("Proposal expired or already agreed. Close it before starting a new conversation.", 409);
              }
              if (e.action === "agree" && same(row.latest.author, e.account)) {
                throw fail("The other participant must agree.", 403);
              }
              if (e.action === "agree") {
                let selected = db.prepare("SELECT thread FROM selections WHERE source=?").get(row.sourceKey);
                if (selected && selected.thread !== row.id) {
                  const prior = get(selected.thread);
                  if (prior?.state === "agreed" && prior.latest.responseBy <= Math.max(now(), s.now)) {
                    db.prepare("DELETE FROM selections WHERE source=?").run(row.sourceKey);
                    selected = null;
                  }
                }
                if (selected && selected.thread !== row.id) {
                  throw fail("Another replacement has already been selected for this offer.", 409);
                }
                db.prepare("INSERT OR IGNORE INTO selections VALUES (?,?)").run(row.sourceKey, row.id);
                row.state = "agreed";
                row.agreedBy = e.account;
                row.agreedAt = now();
              }
            } else {
              if (!same(row.lender, e.account) && e.action !== "bind") {
                throw fail("Only the lender can replace this offer.", 403);
              }
              if (e.action === "start") {
                sourceOpen(s);
                if (row.state !== "agreed" || row.latest.responseBy <= Math.max(now(), s.now)) {
                  throw fail("Agreement expired or changed.", 409);
                }
                row.state = "replacing";
                row.cancelAfterBlock = s.blockNumber;
              } else if (e.action === "cancelled") {
                if (row.state !== "replacing") {
                  throw fail("Replacement step changed.", 409);
                }
                row.cancelHash = e.hash;
                row.state = "recovering";
              } else if (e.action === "prepare") {
                if (
                  row.state !== "recovering" || s.status !== 5 || s.credit?.nominal !== "0"
                  || row.latest.terms.expiresAt <= Math.max(now(), s.now)
                ) {
                  throw fail("Withdraw the original USDG credit in full before funding.", 409);
                }
                row.state = "funding";
                row.attempt = randomUUID();
                row.fundAfterBlock = s.blockNumber;
              } else if (e.action === "bind") {
                if (row.state !== "funding") {
                  throw fail("This replacement is not awaiting funding evidence.", 409);
                }
                row.state = "funded";
                row.replacement = {
                  id: linked.id,
                  hash: e.hash,
                  status: linked.status,
                  blockNumber: linked.blockNumber,
                  blockHash: linked.blockHash,
                };
              }
            }
            row.revision++;
          }
          if (e.action === "open" || e.action === "counter") {
            if (e.responseBy >= s.terms.expiresAt) {
              throw fail("Respond-by time must precede the original offer expiry.");
            }
            row.latest = {
              id: randomUUID(),
              author: e.account,
              terms: e.terms,
              responseBy: e.responseBy,
              createdAt: now(),
            };
          }
          row.updatedAt = now();
          db.prepare(
            "INSERT INTO threads(id,source,borrower,lender,revision,state,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state,data=excluded.data",
          ).run(
            row.id,
            row.sourceKey,
            row.borrower.toLowerCase(),
            row.lender.toLowerCase(),
            row.revision,
            row.state,
            JSON.stringify(row),
          );
          db.prepare("INSERT INTO events(thread,data) VALUES (?,?)").run(
            row.id,
            JSON.stringify({ at: now(), envelope: e, signature }),
          );
          result = pack(row);
        }
        db.prepare("INSERT INTO nonces VALUES (?,?,?,?)").run(nonceKey, requestHash, JSON.stringify(result), now());
        return result;
      });
    },
  };
  return service;
}

export function createNegotiationsHandler(service) {
  const rates = new Map();
  return async (req, res, headers = {}) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== "/api/p2p/negotiations") return false;
    const send = (status, data) => {
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        "Vary": "Authorization",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      if (req.method === "GET") {
        if (url.searchParams.has("offerId")) {
          send(
            200,
            await service.inspect(
              url.searchParams.get("market"),
              Number(url.searchParams.get("chainId")),
              url.searchParams.get("offerId"),
              token,
            ),
          );
        } else if (url.searchParams.has("attempt")) {
          send(200, await service.preflight(token, url.searchParams.get("id"), url.searchParams.get("attempt")));
        } else send(200, service.list(token, Object.fromEntries(url.searchParams)));
      } else if (req.method === "POST") {
        if (
          req.headers.origin !== service.origin || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")
        ) throw fail("Use this website to sign negotiations.", 403);
        const time = Date.now();
        for (const [ip, r] of rates) if (r.until < time) rates.delete(ip);
        const ip = req.socket.remoteAddress ?? "unknown", r = rates.get(ip) ?? { count: 0, until: time + 60000 };
        if (rates.size >= 10000 && !rates.has(ip) || ++r.count > 40) {
          throw fail("Too many requests. Retry in a minute.", 429);
        }
        rates.set(ip, r);
        let data = "";
        for await (const chunk of req) {
          data += chunk.toString("utf8");
          if (Buffer.byteLength(data) > 16384) throw fail("Signed action is too large.", 413);
        }
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw fail("Invalid JSON.");
        }
        keys(parsed, ["envelope", "signature"]);
        send(200, await service.submit(parsed));
      } else send(405, { error: "Use GET or POST." });
    } catch (error) {
      send(error.status ?? 503, {
        error: error.status
          ? error.message
          : "Negotiations unavailable. Refresh before retrying; a prior action may have been saved.",
      });
    }
    return true;
  };
}
