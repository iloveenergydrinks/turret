import { DatabaseSync } from 'node:sqlite';
import { defaultWalletAvatar, normalizeWalletAddress, validateWalletAvatar } from '../../../shared/wallet-avatar.mjs';

export class ProfileError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class ProfileStore {
  constructor(path, { maxStoredImageBytes = 256 * 1024 * 1024, maxProfiles = 100_000 } = {}) {
    if (!Number.isSafeInteger(maxStoredImageBytes) || maxStoredImageBytes < 1 || maxStoredImageBytes > 4 * 1024 * 1024 * 1024) {
      throw new Error('Invalid public avatar storage limit');
    }
    if (!Number.isSafeInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 1_000_000) throw new Error('Invalid public profile count limit');
    this.maxStoredImageBytes = maxStoredImageBytes;
    this.maxProfiles = maxProfiles;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS profiles(address TEXT PRIMARY KEY, avatar TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(nonce TEXT PRIMARY KEY, address TEXT NOT NULL, avatar TEXT NOT NULL, revision INTEGER NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL, image BLOB);
      CREATE TABLE IF NOT EXISTS images(hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS challenge_expiry ON challenges(expires_at);
      CREATE TABLE IF NOT EXISTS rates(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);`);
  }
  profile(value) {
    const address = normalizeWalletAddress(value);
    const row = this.db.prepare('SELECT avatar,revision,updated_at FROM profiles WHERE address=?').get(address);
    return { address, avatar: row ? validateWalletAvatar(JSON.parse(row.avatar)) : defaultWalletAvatar(address),
      revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null };
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  rate(key, limit, windowMs, now) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT count,until FROM rates WHERE key=?').get(key);
      if (row && row.until > now && row.count >= limit) throw new ProfileError('Too many requests. Try again later.', 429);
      const current = row && row.until > now ? row : { count: 0, until: now + windowMs };
      this.db.prepare('INSERT OR REPLACE INTO rates VALUES (?,?,?)').run(key, current.count + 1, current.until);
    });
  }
  addChallenge(row) {
    this.transaction(() => {
      if (this.profile(row.address).revision !== row.revision) throw new ProfileError('Your avatar changed. Reload before saving.', 409);
      this.checkProfileCapacity(row.revision);
      const pending = this.db.prepare('SELECT count(*) AS count, COALESCE(sum(length(image)),0) AS bytes FROM challenges').get();
      if (pending.count >= 5_000 || pending.bytes + (row.image?.length ?? 0) > 32 * 1024 * 1024) {
        throw new ProfileError('Avatar saves are busy. Try again in a few minutes.', 429);
      }
      this.db.prepare('INSERT INTO challenges VALUES (?,?,?,?,?,?,?)')
        .run(row.nonce, row.address, JSON.stringify(row.avatar), row.revision, row.message, row.expiresAt, row.image ?? null);
    });
  }
  challenge(nonce) {
    const row = this.db.prepare('SELECT * FROM challenges WHERE nonce=?').get(nonce);
    return row ? { nonce: row.nonce, address: row.address, avatar: JSON.parse(row.avatar), revision: row.revision,
      message: row.message, expiresAt: row.expires_at, image: row.image ? Buffer.from(row.image) : null } : null;
  }
  image(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const row = this.db.prepare('SELECT bytes FROM images WHERE hash=?').get(hash);
    return row ? Buffer.from(row.bytes) : null;
  }
  discard(nonce) { this.db.prepare('DELETE FROM challenges WHERE nonce=?').run(nonce); }
  checkProfileCapacity(revision) {
    if (revision === 0 && this.db.prepare('SELECT count(*) AS count FROM profiles').get().count >= this.maxProfiles) {
      throw new ProfileError('The profile service is at capacity. Please try again later.', 429);
    }
  }
  commit(nonce, now) {
    return this.transaction(() => {
      const row = this.challenge(nonce);
      if (!row || row.expiresAt <= now) throw new ProfileError('Avatar signature expired or was already used.', 409);
      if (this.profile(row.address).revision !== row.revision) throw new ProfileError('Your avatar changed. Reload before saving.', 409);
      this.checkProfileCapacity(row.revision);
      const revision = row.revision + 1;
      if (row.avatar.kind === 'image') {
        if (row.image && !this.image(row.avatar.hash)) {
          const storedBytes = this.db.prepare('SELECT COALESCE(sum(length(bytes)),0) AS bytes FROM images').get().bytes;
          if (storedBytes + row.image.length > this.maxStoredImageBytes) {
            throw new ProfileError('Photo storage is full. Choose a generated avatar or try again later.', 429);
          }
          this.db.prepare('INSERT INTO images VALUES (?,?)').run(row.avatar.hash, row.image);
        }
        if (!this.image(row.avatar.hash)) throw new ProfileError('Avatar image is unavailable. Upload it again.', 409);
      }
      this.db.prepare('INSERT OR REPLACE INTO profiles VALUES (?,?,?,?)').run(row.address, JSON.stringify(row.avatar), revision, now);
      this.db.prepare('DELETE FROM challenges WHERE address=?').run(row.address);
      return this.profile(row.address);
    });
  }
  prune(now) {
    this.db.prepare('DELETE FROM challenges WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM rates WHERE until<=?').run(now);
  }
  close() { this.db.close(); }
}
