import { createFacilityQuoteBoard, createFacilityQuotesHandler, openFacilityQuoteStore, MAX_QUOTE_BYTES, QuoteBoardError } from "./facility-quotes.mjs";
import { createFacilityLoanIndex } from "./facility-loan-index.mjs";

function readBody(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0, finished = false;
    const finish = (error) => {
      if (finished) return; finished = true;
      clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted);
      // An aborted IncomingMessage may emit its socket error after the aborted event.
      request.once("error", () => {});
      if (error) { request.resume(); reject(error); } else resolve(Buffer.concat(parts));
    };
    const data = part => { size += part.length; if (size > MAX_QUOTE_BYTES) finish(new QuoteBoardError(413, "Quote is too large.")); else parts.push(part); };
    const end = () => finish(), failed = () => finish(new QuoteBoardError(400, "Unable to read the signed quote."));
    const aborted = () => finish(new QuoteBoardError(400, "Quote submission was interrupted."));
    const timer = setTimeout(() => finish(new QuoteBoardError(408, "Quote submission timed out.")), timeoutMs); timer.unref();
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
}

/** Node website mount. An empty registry disables new facilities without touching individual P2P loans.
 * Active quotes require an explicitly configured persistent database path and exact website origin.
 */
export function createFacilityPlatform({ config, client, origin, databasePath, bodyTimeoutMs = 10000, read, resolveEntry }) {
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)
    || !config || config.schemaVersion !== 1 || !Array.isArray(config.entries) || config.entries.length > 100
    || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 30000) throw new Error("Invalid facility service configuration.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (config.entries.some(entry => entry.chainId !== 4663 && !(local && entry.chainId === 31337))) throw new Error("Unsupported facility network.");
  let store, handler, loanIndex;
  if (config.entries.length || resolveEntry) {
    // Validate identities before creating the database; malformed releases fail startup.
    const options = { entries: config.entries, baseline: config.baseline, client, resolveEntry, ...(read ? { read } : {}) };
    createFacilityQuoteBoard({ ...options, store: null });
    store = openFacilityQuoteStore(databasePath);
    handler = createFacilityQuotesHandler({ board: createFacilityQuoteBoard({ ...options, store }), origin });
    try { loanIndex = createFacilityLoanIndex({ entries: config.entries, baseline: config.baseline, client, databasePath, resolveEntry }); }
    catch (error) { store.close(); throw error; }
  }
  let readingBodies = 0;
  const mount = async (request, response, securityHeaders = {}) => {
    const requestUrl = new URL(request.url || "/", origin);
    if (!["/api/facility-quotes", "/api/facility-loans"].includes(requestUrl.pathname)) return false;
    const json = (status, error) => { response.writeHead(status, { ...securityHeaders, "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify({ error })); };
    if (!handler) { json(503, "Reusable lending is not active here yet."); request.resume(); return true; }
    if (requestUrl.pathname === "/api/facility-loans") {
      if (request.method !== "GET") { json(405, "Use GET."); request.resume(); return true; }
      const params = requestUrl.searchParams, keys = [...params.keys()];
      if (keys.some(key => !["chainId", "facility", "account", "before"].includes(key)) || new Set(keys).size !== keys.length
        || !/^[1-9][0-9]{0,15}$/.test(params.get("chainId") ?? "") || params.has("before") && !/^[1-9][0-9]{0,77}$/.test(params.get("before"))) {
        json(400, "Invalid loan history query."); return true;
      }
      try {
        const value = await loanIndex.list({ chainId: Number(params.get("chainId")), facility: params.get("facility"), account: params.get("account"), before: params.get("before") ?? undefined });
        response.writeHead(200, { ...securityHeaders, "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value));
      } catch (error) { json(error.status === 400 ? 400 : 503, error.status === 400 ? error.message : "Loan history is unavailable. Keep known loans visible and retry."); }
      return true;
    }
    try {
      const method = request.method || "GET", headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      let body;
      if (method === "POST") {
        if (headers.get("origin") !== origin) throw new QuoteBoardError(403, "Publish from the configured website origin.");
        if (headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new QuoteBoardError(415, "Send application/json.");
        if (Number(headers.get("content-length")) > MAX_QUOTE_BYTES) throw new QuoteBoardError(413, "Quote is too large.");
        if (readingBodies >= 8) throw new QuoteBoardError(429, "Quote submissions are busy. Retry shortly.");
        readingBodies++;
        try { body = await readBody(request, bodyTimeoutMs); } finally { readingBodies--; }
      }
      const result = await handler(new Request(new URL(request.url || "/", origin), { method, headers, ...(body ? { body } : {}) }));
      response.writeHead(result.status, { ...securityHeaders, ...Object.fromEntries(result.headers) }); response.end(await result.text());
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(error instanceof QuoteBoardError ? error.status : 503,
        error instanceof QuoteBoardError ? error.message : "Quote directory is temporarily unavailable.");
    } finally { request.resume(); }
    return true;
  };
  mount.close = () => { loanIndex?.close(); store?.close(); };
  return mount;
}
