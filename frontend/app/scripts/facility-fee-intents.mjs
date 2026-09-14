import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { auditFeeJournal } from "./facility-fee-audit.mjs";
import { same } from "../src/facilities/quotes.mjs";

const json = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = value => createHash("sha256").update(json(stable(value))).digest("hex");
const hashPattern = /^0x[0-9a-f]{64}$/i;

/** One authoritative durable file per treasury. Never copy it to concurrent operators.
 * This module never signs or sends. A signing intent stays locked across process crashes,
 * wallet rejection and unknown broadcasts; elapsed time is never evidence of cancellation.
 */
export function openFacilityFeeIntents(path, { config, journal, client }) {
  if (!isAbsolute(path) || !config || !journal || !client) throw new Error("Invalid fee intent store configuration.");
  config = JSON.parse(json(config)); journal = JSON.parse(json(journal));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 3000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS fee_journal (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fee_intents (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS fee_one_active ON fee_intents((1)) WHERE state IN ('reserved','signing','submitted');`);
  // Checkpoint, admitted contracts and initial source receipts cannot change on reopen.
  const identity = fingerprint({ config, journal });
  const transaction = action => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  try {
    transaction(() => {
      const row = db.prepare("SELECT identity FROM fee_journal WHERE id=1").get();
      if (row && row.identity !== identity) throw new Error("Fee journal identity changed. Reopen with its original configuration and checkpoint.");
      if (!row) db.prepare("INSERT INTO fee_journal VALUES(1,?,0,?)").run(identity, json(journal));
    });
  } catch (error) { db.close(); throw error; }
  const snapshot = () => {
    const row = db.prepare("SELECT revision,payload FROM fee_journal WHERE id=1").get();
    return { revision: row.revision, journal: JSON.parse(row.payload) };
  };
  const get = id => {
    const row = db.prepare("SELECT payload FROM fee_intents WHERE id=?").get(id);
    if (!row) throw new Error("Unknown fee intent.");
    return JSON.parse(row.payload);
  };
  const active = () => {
    const row = db.prepare("SELECT payload FROM fee_intents WHERE state IN ('reserved','signing','submitted')").get();
    return row ? JSON.parse(row.payload) : null;
  };
  const update = intent => db.prepare("UPDATE fee_intents SET state=?,payload=? WHERE id=?").run(intent.state, json(intent), intent.id);
  const requireState = (id, state) => { const intent = get(id); if (intent.state !== state) throw new Error(`Fee intent is ${intent.state}, expected ${state}.`); return intent; };
  const requireRevision = revision => { if (snapshot().revision !== revision) throw new Error("Fee journal changed during verification. Audit again."); };
  const audit = saved => auditFeeJournal({ config, client, journal: saved.journal });
  const verifyTransaction = async (intent, hash) => {
    if (!hashPattern.test(hash)) throw new Error("Invalid remittance transaction hash.");
    if (await client.getChainId() !== config.chainId) throw new Error("Fee submission chain mismatch.");
    const tx = await client.getTransaction({ hash });
    if (!same(tx.hash, hash) || !same(tx.from, config.treasury) || !same(tx.to, config.router)
      || String(tx.nonce) !== intent.nonce || tx.value !== 0n || !same(tx.input, intent.plan.data)) throw new Error("Transaction does not match the reserved treasury intent.");
    return tx;
  };
  return {
    close: () => db.close(), get, active, snapshot,
    async reserve() {
      const saved = snapshot(), report = await audit(saved);
      if (!report.plan || !report.sourceCollectionIds.length) throw new Error("No unassigned fees to reserve.");
      return transaction(() => {
        requireRevision(saved.revision);
        if (active()) throw new Error("A treasury fee intent is already active. Recover it before reserving another.");
        const intent = JSON.parse(json({ id: randomUUID(), state: "reserved", createdAt: Date.now(), sourceCollectionIds: report.sourceCollectionIds,
          gross: report.gross, plan: report.plan, auditBlock: report.blockNumber, auditHash: report.blockHash }));
        db.prepare("INSERT INTO fee_intents VALUES(?,?,?)").run(intent.id, intent.state, json(intent));
        return intent;
      });
    },
    cancelReserved(id) {
      return transaction(() => { const intent = requireState(id, "reserved"); intent.state = "cancelled"; update(intent); return intent; });
    },
    async beginSigning(id) {
      const before = requireState(id, "reserved"), saved = snapshot(), report = await audit(saved);
      if (!report.readyToForward || fingerprint(report.sourceCollectionIds) !== fingerprint(before.sourceCollectionIds)
        || String(report.gross) !== before.gross || fingerprint(report.plan) !== fingerprint(before.plan)) throw new Error("Reserved fees, balance or allowance changed. Resolve them before signing.");
      const nonce = await client.getTransactionCount({ address: config.treasury, blockTag: "pending" });
      if (!Number.isSafeInteger(nonce) || nonce < 0 || Date.now() - report.checkedAt >= 30000) throw new Error("Treasury nonce or audit is unavailable.");
      return transaction(() => {
        requireRevision(saved.revision); const intent = requireState(id, "reserved");
        Object.assign(intent, { state: "signing", nonce: String(nonce), auditBlock: String(report.blockNumber), auditHash: report.blockHash });
        update(intent); return intent;
      });
    },
    async recordSubmission(id, hash) {
      const before = get(id);
      if (!["signing", "submitted"].includes(before.state)) throw new Error("Fee intent has not entered signing.");
      await verifyTransaction(before, hash);
      return transaction(() => {
        const intent = get(id);
        if (!["signing", "submitted"].includes(intent.state)) throw new Error("Fee intent changed during submission recovery.");
        // A replacement is permitted only with the same sender, nonce and exact call.
        Object.assign(intent, { state: "submitted", hash: hash.toLowerCase() }); update(intent); return intent;
      });
    },
    async confirm(id) {
      const before = requireState(id, "submitted"), saved = snapshot();
      await verifyTransaction(before, before.hash);
      const next = { ...saved.journal, remittances: [...saved.journal.remittances, { hash: before.hash, collectionIds: before.sourceCollectionIds }] };
      // Full transfer attribution, canonicality, confirmations and router counter audit.
      const report = await auditFeeJournal({ config, client, journal: next });
      return transaction(() => {
        requireRevision(saved.revision); const intent = requireState(id, "submitted");
        if (intent.hash !== before.hash) throw new Error("Remittance changed during confirmation.");
        db.prepare("UPDATE fee_journal SET revision=revision+1,payload=? WHERE id=1").run(json(next));
        Object.assign(intent, { state: "confirmed", confirmedAt: Date.now(), confirmationBlock: String(report.blockNumber), confirmationHash: report.blockHash });
        update(intent); return intent;
      });
    },
  };
}
