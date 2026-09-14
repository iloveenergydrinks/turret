import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { keccak256, parseAbi } from "viem";
import { isAccount, same, uint } from "../src/facilities/quotes.mjs";
import { validateFacilityEntry } from "../src/facilities/reader.mjs";

const abi = parseAbi([
  "event LoanOpened(uint256 indexed id,address indexed borrower,bytes32 indexed quoteDigest,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 dueAt,address vault)",
  "function nextLoanId() view returns (uint256)",
  "function loans(uint256) view returns (address borrower,address vault,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 dueAt,uint256 lenderCredit,uint256 feeCredit,uint256 collateralCredit,uint8 status,bool defaultAcknowledged)",
]);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const keyNumber = value => uint(String(value)).toString().padStart(78, "0");
const blockHeader = block => {
  if (!block || typeof block.number !== "bigint" || block.number < 0n || !hash(block.hash)) throw fail("Invalid loan history block.");
  return { number: block.number, hash: block.hash.toLowerCase() };
};

/** Durable discovery of every opened loan, including repaid/defaulted loans with withdrawal credits.
 * Current terms are read from the contract on each returned page. Token qualification does not gate recovery.
 */
export function createFacilityLoanIndex({ entries, baseline, client, databasePath, pageBlocks = 10000n, maxPages = 4, retainedCheckpoints = 16, resolveEntry }) {
  if (!Array.isArray(entries) || entries.length > 100 || !isAbsolute(databasePath) || typeof pageBlocks !== "bigint" || pageBlocks < 1n || pageBlocks > 100000n
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 16 || !Number.isInteger(retainedCheckpoints) || retainedCheckpoints < 1 || retainedCheckpoints > 64) throw new Error("Invalid facility loan index configuration.");
  const registry = new Map();
  for (const entry of entries) {
    validateFacilityEntry(entry, baseline); const startBlock = uint(entry.startBlock), key = `${entry.chainId}:${entry.address.toLowerCase()}`;
    if (registry.has(key)) throw new Error("Duplicate indexed facility.");
    registry.set(key, { ...structuredClone(entry), startBlock, key, binding: JSON.stringify([entry.chainId, entry.address.toLowerCase(), entry.runtimeHash.toLowerCase(), entry.lender.toLowerCase(), String(startBlock)]) });
  }
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath, { timeout: 3000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS facility_history_meta (facility TEXT PRIMARY KEY, binding TEXT NOT NULL, revision INTEGER NOT NULL, checkpoints TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS facility_history_loans (facility TEXT NOT NULL, id TEXT NOT NULL, borrower TEXT NOT NULL, opened_block TEXT NOT NULL, PRIMARY KEY(facility,id));
    CREATE INDEX IF NOT EXISTS facility_history_account ON facility_history_loans(facility,borrower,id);
    CREATE INDEX IF NOT EXISTS facility_history_blocks ON facility_history_loans(facility,opened_block);`);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("PRAGMA table_info(facility_history_meta)").all().some(column => column.name === "history_epoch")) db.exec("ALTER TABLE facility_history_meta ADD COLUMN history_epoch INTEGER NOT NULL DEFAULT 0");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  const metadata = db.prepare("SELECT * FROM facility_history_meta WHERE facility=?");
  const saveMeta = db.prepare("INSERT INTO facility_history_meta(facility,binding,revision,checkpoints,history_epoch) VALUES(?,?,?,?,?) ON CONFLICT(facility) DO UPDATE SET revision=excluded.revision,checkpoints=excluded.checkpoints,history_epoch=excluded.history_epoch");
  const truncate = db.prepare("DELETE FROM facility_history_loans WHERE facility=? AND opened_block>?");
  const put = db.prepare("INSERT INTO facility_history_loans VALUES(?,?,?,?)");
  const ownerPage = db.prepare("SELECT id,borrower FROM facility_history_loans WHERE facility=? AND id<? ORDER BY id DESC LIMIT 21");
  const borrowerPage = db.prepare("SELECT id,borrower FROM facility_history_loans WHERE facility=? AND borrower=? AND id<? ORDER BY id DESC LIMIT 21");
  const pending = new Map(); let active = 0, activeListings = 0;
  const canonical = async number => {
    const block = blockHeader(await client.getBlock({ blockNumber: number }));
    if (block.number !== number) throw fail("RPC returned a different loan history block."); return block;
  };
  function savedState(entry) {
    const saved = metadata.get(entry.key);
    if (!saved) return { revision: 0, historyEpoch: 0, checkpoints: [] };
    if (saved.binding !== entry.binding) throw fail("Loan history configuration changed; use a separately rebuilt index.");
    const checkpoints = JSON.parse(saved.checkpoints);
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1 || !Number.isSafeInteger(saved.history_epoch) || saved.history_epoch < 0 || !Array.isArray(checkpoints) || checkpoints.length > retainedCheckpoints) throw fail("Invalid loan history checkpoint.");
    let previousBlock = entry.startBlock - 1n, previousId = 0n;
    for (const point of checkpoints) {
      if (uint(point.number) <= previousBlock || !hash(point.hash) || uint(point.lastId) < previousId) throw fail("Invalid loan history checkpoint.");
      previousBlock = uint(point.number); previousId = uint(point.lastId);
    }
    return { revision: saved.revision, historyEpoch: saved.history_epoch, checkpoints };
  }
  async function perform(entry) {
    if (await client.getChainId() !== entry.chainId) throw fail("Loan history RPC chain mismatch.");
    const raw = await client.getBlock(), target = blockHeader(raw);
    if (target.number < entry.startBlock || typeof raw.timestamp !== "bigint" || Math.abs(Date.now() - Number(raw.timestamp) * 1000) >= 30000) throw fail("Current loan history state is unavailable.");
    const code = await client.getCode({ address: entry.address, blockNumber: target.number });
    if (!code || !same(keccak256(code), entry.runtimeHash)) throw fail("Loan history contract identity changed.");
    const saved = savedState(entry); let chosen = -1;
    for (let i = saved.checkpoints.length - 1; i >= 0; i--) {
      const point = saved.checkpoints[i];
      if (uint(point.number) <= target.number && same((await canonical(uint(point.number))).hash, point.hash)) { chosen = i; break; }
    }
    let checkpoints = saved.checkpoints.slice(0, chosen + 1);
    const checkpoint = checkpoints.at(-1), rewindTo = checkpoint ? uint(checkpoint.number) : entry.startBlock - 1n;
    let through = rewindTo, lastId = checkpoint ? uint(checkpoint.lastId) : 0n;
    const discovered = [];
    for (let page = 0; page < maxPages && through < target.number; page++) {
      const fromBlock = through + 1n, toBlock = fromBlock + pageBlocks - 1n < target.number ? fromBlock + pageBlocks - 1n : target.number;
      const end = await canonical(toBlock);
      const logs = await client.getLogs({ address: entry.address, event: abi[0], strict: true, fromBlock, toBlock });
      if (!Array.isArray(logs) || logs.length > 20000) throw fail("Loan history event page is too large.");
      const positions = new Set(), hashes = new Map();
      for (const log of logs) {
        if (!same(log.address, entry.address) || log.removed || log.eventName !== "LoanOpened" || typeof log.blockNumber !== "bigint" || log.blockNumber < fromBlock || log.blockNumber > toBlock
          || !hash(log.blockHash) || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || typeof log.args?.id !== "bigint" || !isAccount(log.args.borrower)) throw fail("Invalid loan history event.");
        const position = `${log.blockNumber}:${log.logIndex}`;
        if (positions.has(position) || hashes.has(log.blockNumber) && !same(hashes.get(log.blockNumber), log.blockHash)) throw fail("Inconsistent loan history events.");
        positions.add(position); hashes.set(log.blockNumber, log.blockHash);
      }
      for (const [number, hash] of hashes) if (!same((await canonical(number)).hash, hash)) throw fail("Chain changed during loan discovery.");
      logs.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
      for (const log of logs) {
        if (log.args.id !== lastId + 1n) throw fail("Loan history is missing an opening event.");
        lastId = log.args.id; discovered.push({ id: lastId, borrower: log.args.borrower.toLowerCase(), block: log.blockNumber });
      }
      const next = await client.readContract({ address: entry.address, abi, functionName: "nextLoanId", blockNumber: toBlock });
      if (next !== lastId + 1n) throw fail("Loan history does not match the contract loan count.");
      if (!same((await canonical(toBlock)).hash, end.hash) || !same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed during loan discovery.");
      through = toBlock; checkpoints = [...checkpoints, { number: String(through), hash: end.hash, lastId: String(lastId) }].slice(-retainedCheckpoints);
    }
    if (!same((await canonical(target.number)).hash, target.hash)) throw fail("Chain changed while checking loan history.");
    const historyEpoch = saved.historyEpoch + (chosen < saved.checkpoints.length - 1 ? 1 : 0);
    const result = { blockNumber: String(target.number), blockHash: target.hash, blockTimestamp: String(raw.timestamp), indexedThrough: String(through), complete: through === target.number, historyEpoch };
    if (through === rewindTo && chosen === saved.checkpoints.length - 1 && saved.revision > 0) return { ...result, revision: saved.revision };
    // Compare-and-swap protects separate processes sharing the SQLite volume, in addition to local coalescing.
    db.exec("BEGIN IMMEDIATE");
    try {
      if ((metadata.get(entry.key)?.revision ?? 0) !== saved.revision) throw fail("Loan history updated concurrently. Retry.");
      truncate.run(entry.key, rewindTo < 0n ? "" : keyNumber(rewindTo));
      for (const row of discovered) put.run(entry.key, keyNumber(row.id), row.borrower, keyNumber(row.block));
      saveMeta.run(entry.key, entry.binding, saved.revision + 1, JSON.stringify(checkpoints), historyEpoch); db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { ...result, revision: saved.revision + 1 };
  }
  async function sync(entry) {
    if (pending.has(entry.key)) return pending.get(entry.key);
    if (active >= 4) throw fail("Loan history checks are busy. Retry shortly.");
    active++; const result = perform(entry).finally(() => { active--; pending.delete(entry.key); }); pending.set(entry.key, result); return result;
  }
  return {
    async list({ chainId, facility, account, before }) {
      if (activeListings >= 8) throw fail("Loan history requests are busy. Retry shortly.");
      activeListings++;
      try {
      let entry = registry.get(`${chainId}:${String(facility).toLowerCase()}`);
      if (!entry && resolveEntry) {
        const resolved = await resolveEntry(chainId, facility); validateFacilityEntry(resolved, baseline);
        const startBlock = uint(resolved.startBlock), key = `${chainId}:${resolved.address.toLowerCase()}`;
        entry = { ...resolved, startBlock, key, binding: JSON.stringify([resolved.chainId, resolved.address.toLowerCase(), resolved.runtimeHash.toLowerCase(), resolved.lender.toLowerCase(), String(startBlock)]) };
      }
      if (!entry || !isAccount(account)) throw fail("Invalid facility or wallet.", 400);
      let cursor; try { cursor = before === undefined ? (1n << 256n) - 1n : uint(before); } catch { throw fail("Invalid loan page.", 400); }
      if (cursor < 1n) throw fail("Invalid loan page.", 400);
      const snapshot = await sync(entry), owner = same(account, entry.lender);
      const candidates = owner ? ownerPage.all(entry.key, keyNumber(cursor)) : borrowerPage.all(entry.key, account.toLowerCase(), keyNumber(cursor));
      const rows = await Promise.all(candidates.slice(0, 20).map(async row => {
        const id = uint(BigInt(row.id).toString());
        const loan = await client.readContract({ address: entry.address, abi, functionName: "loans", args: [id], blockNumber: BigInt(snapshot.blockNumber) });
        if (!Array.isArray(loan) || loan.length !== 11 || !same(loan[0], row.borrower) || !isAccount(loan[1]) || ![1, 2, 3].includes(loan[9])
          || [loan[2], loan[4], loan[5]].some(v => typeof v !== "bigint" || v < 0n)) throw fail("Loan history row could not be verified.");
        return { id: String(id), borrower: loan[0], principal: String(loan[2]), interest: String(loan[4]), dueAt: String(loan[5]), status: loan[9] };
      }));
      if (!same((await canonical(BigInt(snapshot.blockNumber))).hash, snapshot.blockHash) || metadata.get(entry.key)?.revision !== snapshot.revision
        || Math.abs(Date.now() - Number(snapshot.blockTimestamp) * 1000) >= 30000) throw fail("Loan history changed or became stale during pagination. Retry.");
      const { revision, blockTimestamp, ...publicSnapshot } = snapshot;
      return { schemaVersion: 1, chainId: entry.chainId, facility: entry.address, account: account.toLowerCase(), ...publicSnapshot,
        checkedAt: Date.now(), status: snapshot.complete ? "ready" : "syncing", rows, nextCursor: candidates.length > 20 ? rows.at(-1).id : null };
      } finally { activeListings--; }
    },
    close() { db.close(); },
  };
}
