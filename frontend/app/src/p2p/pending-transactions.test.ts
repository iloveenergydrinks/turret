// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from "vitest";
import { clearPending, loadPending, loadPendingRecord, requirePendingStorage, savePending, updatePendingIntent } from "./pending-transactions";
const hash = `0x${"1".repeat(64)}` as const;
const second = `0x${"2".repeat(64)}` as const;
const key = "turret:p2p:pending:31337:0xA:0xB";
beforeEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); sessionStorage.clear(); });
test("a fresh browser session recovers the original wallet's pending hash", () => {
  requirePendingStorage(); savePending(key, hash); sessionStorage.clear();
  expect(loadPending(key)).toBe(hash);
  expect(loadPending(key.replace("0xB", "0xC"))).toBeNull();
  clearPending(key, hash); expect(loadPending(key)).toBeNull();
});
test("a stale receipt never clears a newer transaction from another tab", () => {
  savePending(key, hash); savePending(key, second); clearPending(key, hash);
  expect(loadPending(key)).toBe(second);
});
test("migrates existing session-only pending hashes", () => {
  sessionStorage.setItem(key, hash); expect(loadPending(key)).toBe(hash);
  sessionStorage.clear(); expect(loadPending(key)).toBe(hash);
});
test("corrupt pending state and unavailable storage block new submissions", () => {
  window.localStorage.setItem(key.toLowerCase(), "{}"); expect(() => loadPending(key)).toThrow(/could not be read/);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
  expect(requirePendingStorage).toThrow(/storage is unavailable/);
});
test("preserves the original sender, nonce and call when a fresh session resumes a receipt", () => {
  const intent = { from: `0x${"11".repeat(20)}`, nonce: 7, to: `0x${"22".repeat(20)}`, input: "0x1234", value: "0", submittedBlock: "10" } as const;
  savePending(key, hash, intent); sessionStorage.clear(); savePending(key, hash);
  expect(loadPendingRecord(key)?.intent).toEqual(intent);
  savePending(key, second); expect(loadPendingRecord(key)?.intent).toBeUndefined();
});
test("late metadata never restores a cleared record or overwrites another transaction", () => {
  const intent = { from: `0x${"11".repeat(20)}`, nonce: 7, to: `0x${"22".repeat(20)}`, input: "0x1234", value: "0", submittedBlock: "10" } as const;
  savePending(key, hash); clearPending(key, hash);
  // Simulate another tab retaining the old compatibility mirror after durable clearing.
  sessionStorage.setItem(key, hash);
  expect(loadPending(key)).toBeNull();
  expect(updatePendingIntent(key, hash, intent)).toBe(false);
  savePending(key, second);
  expect(updatePendingIntent(key, hash, intent)).toBe(false);
  expect(loadPendingRecord(key)).toMatchObject({ hash: second });
  expect(loadPendingRecord(key)?.intent).toBeUndefined();
  expect(updatePendingIntent(key, second, intent)).toBe(true);
});
test("keeps requested calldata when nonce discovery has to wait until another session", () => {
  const requested = { from: `0x${"11".repeat(20)}`, to: `0x${"22".repeat(20)}`, input: "0x1234", value: "0" } as const;
  savePending(key, hash, undefined, requested); sessionStorage.clear();
  expect(loadPendingRecord(key)?.requested).toEqual(requested);
  updatePendingIntent(key, hash, { ...requested, nonce: 7, submittedBlock: "10" });
  expect(loadPendingRecord(key)?.requested).toEqual(requested);
  const pendingKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)).filter(value => value?.startsWith("turret:p2p:pending:"));
  expect(pendingKeys).toEqual([key.toLowerCase()]);
});
