import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Encrypt contacts, signatures' nonces, and delivery bodies at rest. The key must
// survive restarts but must not live on the database volume or in the repository.
export class Store {
  constructor(path, key) {
    if (!/^[a-f0-9]{64}$/i.test(key ?? "")) throw new Error("ALERTS_DATA_KEY must be 32 random bytes in hex");
    this.key = Buffer.from(key, "hex");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(kind,id))",
    );
  }
  put(kind, id, value) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const body = Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    this.db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)").run(kind, id, body);
  }
  decode(body) {
    const data = Buffer.from(body, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  }
  get(kind, id) {
    const row = this.db.prepare("SELECT body FROM records WHERE kind=? AND id=?").get(kind, id);
    return row ? this.decode(row.body) : null;
  }
  all(kind) {
    return this.db.prepare("SELECT id,body FROM records WHERE kind=?").all(kind).map((row) => ({
      id: row.id,
      ...this.decode(row.body),
    }));
  }
  delete(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  close() {
    this.db.close();
  }
}
