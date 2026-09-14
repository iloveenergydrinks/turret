import { DatabaseSync } from 'node:sqlite';
import { accountReceipts } from './accounting.mjs';

const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

/** Durable canonical history. Only the chain reader may call ingest; it is not an HTTP write API. */
export class CashbackLedger {
  #db;
  #policy;
  #startBlock;
  constructor({ path, policy, startBlock }) {
    if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error('Invalid start block');
    accountReceipts(policy, []);
    this.#db = new DatabaseSync(path);
    this.#policy = structuredClone(policy);
    this.#startBlock = startBlock;
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL,
        parentHash TEXT NOT NULL, timestamp INTEGER NOT NULL, receipts TEXT);
      CREATE TABLE IF NOT EXISTS publications (root TEXT PRIMARY KEY, throughBlock INTEGER NOT NULL, blockHash TEXT NOT NULL);
    `);
    const configured = this.#db.prepare('SELECT value FROM configuration WHERE id=1').get();
    const value = json({ policy, startBlock });
    if (configured && configured.value !== value) { this.#db.close(); throw new Error('Ledger configuration changed'); }
    if (!configured) this.#db.prepare('INSERT INTO configuration VALUES (1,?)').run(value);
  }

  head() {
    const row = this.#db.prepare('SELECT number, hash, timestamp FROM blocks ORDER BY number DESC LIMIT 1').get();
    return row ? { ...row } : null;
  }

  block(number) {
    const row = this.#db.prepare('SELECT number, hash, parentHash, timestamp FROM blocks WHERE number=?').get(number);
    return row ? { ...row } : null;
  }

  ingest(block) {
    const { number, hash, parentHash, timestamp, receipts } = block;
    if (!Number.isSafeInteger(number) || number < this.#startBlock || !hash || !parentHash
      || !Number.isSafeInteger(timestamp) || timestamp < 0 || !Array.isArray(receipts)
      || receipts.some(r => r.timestamp !== timestamp)) throw new Error('Invalid canonical block');
    const existing = this.block(number);
    if (existing?.hash === hash) return;
    if (existing && this.#db.prepare('SELECT 1 FROM publications WHERE throughBlock>=? LIMIT 1').get(number))
      throw new Error('Reorganization affects published entitlements; operator review required');
    const parent = this.block(number - 1);
    if ((number !== this.#startBlock && (!parent || parentHash !== parent.hash || timestamp < parent.timestamp))
      || (number === this.#startBlock && existing && parentHash !== existing.parentHash))
      throw new Error('Block is disconnected from canonical history');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) this.#db.prepare('DELETE FROM blocks WHERE number>=?').run(number);
      this.#db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?)').run(number, hash, parentHash, timestamp,
        receipts.length ? json(receipts) : null);
      if (receipts.length) this.accounts(); // Fail closed on incomplete or inconsistent loan accounting.
      for (const receipt of receipts) for (const event of receipt.events) {
        if (event.event === 'Published') this.protectPublication(event.root, event.throughBlock, event.blockHash);
      }
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  /** Append a log-complete historical range verified by the chain reader.
   * Event blocks and range boundaries are retained. Recovery inside a skipped
   * historical span fails closed; recent blocks still use contiguous ingest.
   */
  ingestRange({ from, to, blocks }) {
    const head = this.head();
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from
      || from !== (head ? head.number + 1 : this.#startBlock) || !Array.isArray(blocks)
      || blocks[0]?.number !== from || blocks.at(-1)?.number !== to)
      throw new Error('Disconnected historical range');
    let previous = head;
    for (const block of blocks) {
      if (!Number.isSafeInteger(block.number) || block.number < from || block.number > to
        || !block.hash || !block.parentHash || !Number.isSafeInteger(block.timestamp)
        || block.timestamp < 0 || !Array.isArray(block.receipts)
        || block.receipts.some(r => r.timestamp !== block.timestamp)
        || (previous && (block.number <= previous.number || block.timestamp < previous.timestamp
          || (block.number === previous.number + 1 && block.parentHash !== previous.hash))))
        throw new Error('Invalid historical range block');
      previous = block;
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.#db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?)');
      for (const block of blocks) insert.run(block.number,block.hash,block.parentHash,block.timestamp,
        block.receipts.length ? json(block.receipts) : null);
      this.accounts();
      for (const block of blocks) for (const receipt of block.receipts) for (const event of receipt.events)
        if (event.event === 'Published') this.protectPublication(event.root,event.throughBlock,event.blockHash);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }

  accounts() {
    const receipts = this.#db.prepare('SELECT receipts FROM blocks WHERE receipts IS NOT NULL ORDER BY number')
      .all().flatMap(row => JSON.parse(row.receipts));
    return accountReceipts(this.#policy, receipts, this.head()?.timestamp);
  }

  account(borrower) { return this.accounts().filter(row => row.borrower === borrower.toLowerCase()); }

  /** Called after a publication transaction is confirmed on the configured distributor. */
  protectPublication(root, throughBlock, blockHash) {
    if (this.block(throughBlock)?.hash !== blockHash) throw new Error('Publication is not anchored to canonical history');
    this.#db.prepare('INSERT OR IGNORE INTO publications VALUES (?,?,?)').run(root, throughBlock, blockHash);
  }

  close() { if (this.#db.isOpen) this.#db.close(); }
}
