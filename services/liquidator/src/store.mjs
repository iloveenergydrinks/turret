import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const encode = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: v.toString() } : v);
export const decode = value => JSON.parse(value, (_, v) => v && typeof v === 'object' && '$bigint' in v ? BigInt(v.$bigint) : v);
export const publicJson = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

export class Store {
  constructor(directory, identity) {
    this.owner = randomUUID();
    if (directory !== ':memory:') mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'keeper.sqlite'));
    if (directory !== ':memory:') chmodSync(join(directory, 'keeper.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions (collateral TEXT NOT NULL, borrower TEXT NOT NULL, PRIMARY KEY(collateral,borrower));
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
    const previous = this.get('identity');
    if (previous && encode(previous) !== encode(identity)) throw new Error('State identity mismatch; use the correct volume');
    if (!previous) this.set('identity', identity);
    // Legacy final records lack a trustworthy settlement time. Hold their costs
    // for one window after upgrade; persist the epoch so restarts do not reset it.
    this.atomic(() => {
      if (this.get('budgetAccountingEpoch') === undefined) this.set('budgetAccountingEpoch', Date.now());
    });
  }
  get(key) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? decode(row.value) : undefined; }
  set(key, value) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, encode(value)); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  acquireLease(now = Date.now()) {
    this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (row && row.owner !== this.owner && row.expires > now) throw new Error('Another keeper owns this volume');
      this.db.prepare('INSERT INTO lease VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(this.owner, now + 120000);
    });
  }
  renewLease(now = Date.now()) {
    const { changes } = this.db.prepare('UPDATE lease SET expires=? WHERE id=1 AND owner=? AND expires>?').run(now + 120000, this.owner, now);
    if (changes !== 1) throw new Error('Keeper lease lost');
  }
  assertLease(now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
    if (!row || row.owner !== this.owner || row.expires <= now) throw new Error('Keeper lease lost');
  }
  indexBatch(pairs, blockNumber, blockHash) {
    this.atomic(() => {
      this.assertLease();
      const statement = this.db.prepare('INSERT OR IGNORE INTO positions VALUES (?,?)');
      for (const { collateral, borrower } of pairs) statement.run(collateral.toLowerCase(), borrower.toLowerCase());
      this.set('cursor', { blockNumber, blockHash });
    });
  }
  positions() { return this.db.prepare('SELECT collateral,borrower FROM positions ORDER BY collateral,borrower').all(); }
  saveTx(tx) {
    this.assertLease();
    this.db.prepare('INSERT INTO transactions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,value=excluded.value').run(tx.id, tx.status, tx.createdAt, encode(tx));
  }
  transactions() { return this.db.prepare('SELECT value FROM transactions ORDER BY created').all().map(x => decode(x.value)); }
  pendingTx() { return this.transactions().find(tx => ['pending', 'blocked'].includes(tx.status)); }
  budgets(now = Date.now()) {
    let daily = 0n, inventory = 0n, gas = 0n;
    const legacyEpoch = this.get('budgetAccountingEpoch');
    for (const tx of this.transactions()) {
      const unresolved = tx.status !== 'confirmed' && tx.status !== 'reverted';
      const settledAt = Number.isSafeInteger(tx.settledAt) && tx.settledAt >= 0
        ? tx.settledAt : Math.max(tx.createdAt, legacyEpoch);
      const inWindow = unresolved || settledAt > now - 86400000;
      if (tx.status !== 'reverted' && tx.kind === 'liquidation') {
        const spent = unresolved ? tx.maxRepay : tx.actualRepay ?? tx.maxRepay;
        // Retained inventory cost is never reset automatically, including after a restart.
        if (tx.status !== 'confirmed' || tx.inventoryRecovered !== true) inventory += spent;
        if (inWindow) daily += spent;
      }
      if (inWindow) gas += unresolved ? tx.feeReserve : tx.actualGas ?? tx.feeReserve;
    }
    return { daily, inventory, gas };
  }
  close() {
    this.db.prepare('DELETE FROM lease WHERE owner=?').run(this.owner);
    this.db.close();
  }
}
