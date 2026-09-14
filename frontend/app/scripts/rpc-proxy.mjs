import { createReadRpcFallback } from "../../../shared/rpc-fallback.mjs";

// Configured upstreams, read/simulation methods only. Wallet signing and broadcasting
// remain with the wallet provider. Never forward browser credentials or upstream
// headers: the public RPC has returned invalid duplicate CORS headers.
const METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance",
  "eth_getTransactionCount", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);
const MAX_BODY = 512 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;

function encodeResponse(body) {
  if (!Array.isArray(body)) {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > MAX_RESPONSE) throw new Error("RPC response too large");
    return encoded;
  }
  const parts = [];
  let size = 2;
  for (const item of body) {
    const encoded = JSON.stringify(item);
    size += Buffer.byteLength(encoded) + (parts.length ? 1 : 0);
    if (size > MAX_RESPONSE) throw new Error("RPC response too large");
    parts.push(encoded);
  }
  return `[${parts.join(",")}]`;
}

function validRequest(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.jsonrpc === "2.0" && METHODS.has(value.method)
    && (typeof value.id === "string" || Number.isSafeInteger(value.id))
    && (value.params === undefined || Array.isArray(value.params));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        chunks.length = 0;
        reject(Object.assign(new Error("Request too large"), { status: 413 }));
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createRpcProxy({ upstream = process.env.DOCKYARD_RPC_URL
  || process.env.NEXT_PUBLIC_CHAIN_RPC_URL
  || "https://rpc.mainnet.chain.robinhood.com/", fallbackUrls = (process.env.DOCKYARD_RPC_FALLBACK_URLS || "").split(",").filter(Boolean),
  timeout = 15_000, fetcher = globalThis.fetch } = {}) {
  const rpc = createReadRpcFallback({ urls: [upstream, ...fallbackUrls], timeoutMs: timeout, fetcher, maxResponseBytes: MAX_RESPONSE });
  let active = 0;
  let activeUpstream = 0;
  // Entries exist only until their upstream batch settles. This is deliberately
  // not a result cache: later "latest" calls and write-verification reads are fresh.
  // At most 32 active browser requests * 50 calls can create pending entries.
  const pending = new Map();
  async function forward(jobs, batchShape) {
    activeUpstream++;
    try {
      const calls = jobs.map(job => job.call);
      const data = await rpc.forward(batchShape ? calls : calls[0]);
      const results = Array.isArray(data) ? data : [data];
      const byId = new Map();
      const expectedIds = new Set(calls.map(call => call.id));
      if (results.length !== jobs.length) throw new Error("Invalid RPC response");
      for (const item of results) {
        if (!item || item.jsonrpc !== "2.0" || !expectedIds.has(item.id) || byId.has(item.id)
          || Object.hasOwn(item, "result") === Object.hasOwn(item, "error")
          || (Object.hasOwn(item, "error") && (!item.error || typeof item.error !== "object"
            || !Number.isSafeInteger(item.error.code) || typeof item.error.message !== "string"))) {
          throw new Error("Invalid RPC response");
        }
        byId.set(item.id, Object.hasOwn(item, "result") ? { result: item.result } : { error: item.error });
      }
      for (const job of jobs) {
        if (pending.get(job.key) === job) pending.delete(job.key);
        job.resolve(byId.get(job.call.id));
      }
    } catch (error) {
      for (const job of jobs) {
        if (pending.get(job.key) === job) pending.delete(job.key);
        job.reject(error);
      }
    } finally { activeUpstream--; }
  }
  return async (request, response, headers = {}) => {
    const send = (status, body) => {
      const encoded = encodeResponse(body);
      return response.writeHead(status, {
        ...headers, "Content-Type": "application/json", "Cache-Control": "no-store",
      }).end(encoded);
    };
    const fail = (status, message) => send(status, { error: message });
    if (request.method !== "POST") return fail(405, "Use POST");
    if (request.headers["sec-fetch-site"] === "cross-site") return fail(403, "Origin not allowed");
    if (request.headers.origin) {
      try {
        const origin = new URL(request.headers.origin);
        if (!["https:", "http:"].includes(origin.protocol) || origin.host !== request.headers.host) {
          return fail(403, "Origin not allowed");
        }
      } catch { return fail(403, "Origin not allowed"); }
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
      return fail(415, "Use application/json");
    }
    if (Number(request.headers["content-length"]) > MAX_BODY) return fail(413, "Request too large");
    if (active >= 32) return fail(503, "RPC busy; retry shortly");
    active++;
    try {
      let payload;
      try { payload = JSON.parse(await readBody(request)); }
      catch (error) { return fail(error.status || 400, "Invalid RPC request"); }
      const batch = Array.isArray(payload) ? payload : [payload];
      if (!batch.length || batch.length > 50 || !batch.every(validRequest)
        || new Set(batch.map(call => call.id)).size !== batch.length) {
        return fail(400, "Unsupported RPC request");
      }
      const keys = batch.map(call => JSON.stringify([call.method, call.params ?? []]));
      const newKeys = new Set(keys.filter(key => !pending.has(key)));
      // A shared failure can finish a browser request before its other upstream
      // batch. Bound those outstanding batches independently of browser slots.
      if (newKeys.size && (activeUpstream >= 32 || pending.size + newKeys.size > 1600)) {
        return fail(503, "RPC busy; retry shortly");
      }
      const jobs = [];
      const answers = batch.map((call, index) => {
        const key = keys[index];
        let job = pending.get(key);
        if (!job) {
          job = { key, call };
          job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
          pending.set(key, job);
          jobs.push(job);
        }
        return job.promise.then(answer => ({ jsonrpc: "2.0", id: call.id, ...answer }));
      });
      if (jobs.length) void forward(jobs, Array.isArray(payload));
      const results = await Promise.all(answers);
      send(200, Array.isArray(payload) ? results : results[0]);
    } catch (error) {
      // Do not expose upstream URLs, credentials, HTML error pages or internals.
      fail(error?.status === 503 ? 503 : 502, "RPC temporarily unavailable");
    } finally {
      active--;
    }
  };
}
