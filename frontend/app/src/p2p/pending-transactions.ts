import { isAddress, type Address, type Hex } from "viem";

const validHash = (hash: unknown): hash is Hex => typeof hash === "string" && /^0x[0-9a-f]{64}$/i.test(hash);
export type PendingIntent = { from: Address; nonce: number; to: Address; input: Hex; value: string; submittedBlock: string };
export type PendingCall = Omit<PendingIntent, "nonce" | "submittedBlock">;
export type PendingRecord = { version: 1 | 2; hash: Hex; savedAt: number; intent?: PendingIntent; requested?: PendingCall };
const durableKey = (key: string) => key.toLowerCase().replace(":pending:", ":durable:");
export function validPendingIntent(value: unknown): value is PendingIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as PendingIntent;
  const uint = (n: unknown) => typeof n === "string" && /^(0|[1-9]\d{0,77})$/.test(n) && BigInt(n) < 2n ** 256n;
  return isAddress(intent.from ?? "", { strict: false }) && isAddress(intent.to ?? "", { strict: false })
    && Number.isSafeInteger(intent.nonce) && intent.nonce >= 0 && uint(intent.value) && uint(intent.submittedBlock)
    && typeof intent.input === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(intent.input) && intent.input.length <= 32_770;
}

/** Check persistence before asking a wallet to broadcast. Private data and keys are never stored. */
export function requirePendingStorage() {
  const key = "turret:p2p:storage-check";
  try {
    window.localStorage.setItem(key, "1");
    if (window.localStorage.getItem(key) !== "1") throw new Error();
    window.localStorage.removeItem(key);
  } catch { throw new Error("Browser storage is unavailable. Enable site storage before submitting so pending transactions can be recovered after reopening."); }
}

export function savePending(key: string, hash: Hex, intent?: PendingIntent, requested?: PendingCall) {
  if (!validHash(hash)) throw new Error("The wallet returned an invalid transaction hash.");
  if (intent && !validPendingIntent(intent)) throw new Error("The pending transaction intent is invalid.");
  if (requested && !validPendingIntent({ ...requested, nonce: 0, submittedBlock: "0" })) throw new Error("The requested transaction call is invalid.");
  // Rechecking a receipt must not erase the original nonce/call saved before a reload.
  const previous = window.localStorage.getItem(key.toLowerCase());
  let retained: PendingIntent | undefined;
  let retainedRequest: PendingCall | undefined;
  if (previous) {
    try {
      const parsed = JSON.parse(previous) as PendingRecord;
      if (parsed.hash === hash) {
        if (validPendingIntent(parsed.intent)) retained = parsed.intent;
        if (parsed.requested && validPendingIntent({ ...parsed.requested, nonce: 0, submittedBlock: "0" })) retainedRequest = parsed.requested;
      }
    } catch { /* Fresh submission will replace a hash-only compatibility record. */ }
  }
  const record: PendingRecord = { version: 2, hash, savedAt: Date.now(), ...(intent || retained ? { intent: intent ?? retained } : {}),
    ...(requested || retainedRequest ? { requested: requested ?? retainedRequest } : {}) };
  window.localStorage.setItem(key.toLowerCase(), JSON.stringify(record));
  // A cleared durable record must not be resurrected by an older tab's session mirror.
  window.localStorage.setItem(durableKey(key), "1");
  // Mirror the old format while existing tabs migrate to durable storage.
  try { sessionStorage.setItem(key, hash); } catch { /* Durable record already saved. */ }
}

/** Metadata enrichment is conditional on the same transaction still being current.
 * Unlike a fresh broadcast, a delayed RPC response cannot create or replace a record.
 */
export function updatePendingIntent(key: string, hash: Hex, intent: PendingIntent): boolean {
  const current = loadPendingRecord(key);
  if (!current || current.hash !== hash) return false;
  if (current.intent) return true;
  savePending(key, hash, intent);
  return true;
}

export function loadPendingRecord(key: string): PendingRecord | null {
  const raw = window.localStorage.getItem(key.toLowerCase());
  if (raw !== null) {
    try {
      const value = JSON.parse(raw) as PendingRecord;
      if ([1, 2].includes(value.version) && validHash(value.hash) && Number.isFinite(value.savedAt)
        && (value.intent === undefined || (value.version === 2 && validPendingIntent(value.intent)))
        && (value.requested === undefined || (value.version === 2 && validPendingIntent({ ...value.requested, nonce: 0, submittedBlock: "0" })))) return value;
    } catch { /* Do not silently replace a corrupt pending transaction with a new submission. */ }
    throw new Error("A saved pending transaction could not be read. Check its status in your wallet before repairing this browser’s site data.");
  }
  if (window.localStorage.getItem(durableKey(key)) === "1") return null;
  const legacy = sessionStorage.getItem(key);
  if (legacy !== null) {
    if (!validHash(legacy)) throw new Error("The previous transaction record is invalid. Check its status in your wallet.");
    savePending(key, legacy);
    return { version: 2, hash: legacy, savedAt: Date.now() };
  }
  return null;
}

export const loadPending = (key: string): Hex | null => loadPendingRecord(key)?.hash ?? null;

export function clearPending(key: string, hash: Hex) {
  // A newer record created by another tab must never be cleared by this receipt.
  if (loadPending(key) === hash) window.localStorage.removeItem(key.toLowerCase());
  try { if (sessionStorage.getItem(key) === hash) sessionStorage.removeItem(key); } catch { /* Optional compatibility mirror. */ }
}
