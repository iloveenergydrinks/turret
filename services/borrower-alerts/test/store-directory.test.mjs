import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";

test("a fresh nested database directory persists encrypted records across restart", () => {
  const root = mkdtempSync(join(tmpdir(), "alerts-fresh-volume-"));
  const path = join(root, "new-service", "state", "alerts.sqlite");
  const key = "ab".repeat(32);
  try {
    const first = new Store(path, key);
    first.put("fixture", "1", { value: "persisted" });
    first.db.close();
    const reopened = new Store(path, key);
    assert.deepEqual(reopened.get("fixture", "1"), { value: "persisted" });
    reopened.db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
