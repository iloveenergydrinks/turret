// Read-only RPC failover. Provider URLs and raw transport errors never escape.
export const READ_RPC_METHODS = Object.freeze([
  'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getLogs',
  'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
]);
const allowed = new Set(READ_RPC_METHODS);
const unavailable = () => Object.assign(new Error('RPC temporarily unavailable'), { name: 'RpcUnavailableError', status: 503, code: -32002 });
const invalid = () => Object.assign(new Error('Unsupported RPC request'), { name: 'RpcInputError', status: 400, code: -32600 });
const reverted = error => error.code === 3 || /execution reverted|\brevert(?:ed)?\b|invalid opcode|out of gas/i.test(error.message);
const infrastructure = error => !reverted(error) && ([-32603, -32002, -32005].includes(error.code)
  || /rate.?limit|too many requests|temporarily unavailable|service unavailable|upstream unavailable|overloaded|request timed out|request timeout/i.test(error.message));
function safeError(error) {
  const value = { code: error.code, message: reverted(error) ? 'execution reverted' : 'RPC request rejected' };
  // Preserve ABI revert bytes for viem/custom-error decoding, without copying
  // provider diagnostics, request objects, URLs or credentials into responses.
  const data = typeof error.data === 'string' ? error.data : error.data?.data ?? error.data?.originalError?.data;
  if (typeof data === 'string' && /^0x[0-9a-f]*$/i.test(data)) value.data = data;
  return value;
}
function validatePayload(payload) {
  const batch = Array.isArray(payload), calls = batch ? payload : [payload];
  if (!calls.length || calls.length > 50 || !calls.every(call => call && typeof call === 'object' && !Array.isArray(call)
    && call.jsonrpc === '2.0' && allowed.has(call.method)
    && (typeof call.id === 'string' || Number.isSafeInteger(call.id))
    && (call.params === undefined || Array.isArray(call.params)))
    || new Set(calls.map(call => call.id)).size !== calls.length) throw invalid();
  if (Buffer.byteLength(JSON.stringify(payload)) > 512 * 1024) throw invalid();
  return { batch, calls };
}

export function createReadRpcFallback({ urls, chainId = 4663, timeoutMs = 10000,
  fetcher = globalThis.fetch, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 4 || !Number.isSafeInteger(chainId) || chainId < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || typeof fetcher !== 'function') throw invalid();
  const providers = [...new Set(urls)].map(value => {
    let url; try { url = new URL(value); } catch { throw invalid(); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw invalid();
    return { url: url.href, verifiedUntil: 0, retryAfter: 0 };
  });
  let nextId = 0;
  async function exchange(provider, payload, signal) {
    const response = await fetcher(provider.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload), redirect: 'error', signal });
    const requestRejected = !response.ok && [400, 405, 413, 422].includes(response.status);
    if (!response.ok && !requestRejected) { await response.body?.cancel(); throw unavailable(); }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) { await reader.cancel(); throw unavailable(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw Object.assign(unavailable(), { noFailover: requestRejected }); }
    const calls = Array.isArray(payload) ? payload : [payload], rows = Array.isArray(data) ? data : [data];
    if (rows.length !== calls.length || Array.isArray(payload) !== Array.isArray(data)) throw Object.assign(unavailable(), { noFailover: requestRejected });
    const expected = new Set(calls.map(call => call.id)), seen = new Set();
    for (const row of rows) {
      if (!row || row.jsonrpc !== '2.0' || !expected.has(row.id) || seen.has(row.id)
        || Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')
        || (Object.hasOwn(row, 'error') && (!row.error || typeof row.error !== 'object'
          || !Number.isSafeInteger(row.error.code) || typeof row.error.message !== 'string'))) throw Object.assign(unavailable(), { noFailover: requestRejected });
      if (requestRejected && !row.error) throw Object.assign(unavailable(), { noFailover: true });
      seen.add(row.id);
    }
    return rows;
  }
  async function forward(payload) {
    const { batch, calls } = validatePayload(payload), answers = new Map();
    let pending = calls;
    // Preserve cooldown deadlines on a total outage: a browser request burst
    // must not turn every unavailable response into another upstream retry.
    const available = providers.filter(provider => provider.retryAfter <= Date.now());
    for (const provider of available) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        if (provider.verifiedUntil <= Date.now() && !pending.some(call => call.method === 'eth_chainId')) {
          const [proof] = await exchange(provider, { jsonrpc: '2.0', id: 'chain-check', method: 'eth_chainId', params: [] }, signal);
          if (proof.error || typeof proof.result !== 'string' || !/^0x[0-9a-f]+$/i.test(proof.result)
            || BigInt(proof.result) !== BigInt(chainId)) throw unavailable();
          provider.verifiedUntil = Date.now() + 60000;
        }
        const rows = await exchange(provider, batch ? pending : pending[0], signal);
        const byId = new Map(rows.map(row => [row.id, row]));
        // A cached chain check must never mask a wrong eth_chainId response.
        for (const call of pending) {
          const row = byId.get(call.id);
          if (call.method === 'eth_chainId' && Object.hasOwn(row, 'result')
            && (typeof row.result !== 'string' || !/^0x[0-9a-f]+$/i.test(row.result) || BigInt(row.result) !== BigInt(chainId))) throw unavailable();
          if (call.method === 'eth_chainId' && Object.hasOwn(row, 'result')) provider.verifiedUntil = Date.now() + 60000;
          if (call.method === 'eth_chainId' && row.error && provider.verifiedUntil <= Date.now()) throw unavailable();
        }
        const remaining = [];
        for (const call of pending) {
          const row = byId.get(call.id);
          if (row.error && infrastructure(row.error)) remaining.push(call);
          else answers.set(call.id, row.error ? { jsonrpc: '2.0', id: call.id, error: safeError(row.error) } : { jsonrpc: '2.0', id: call.id, result: row.result });
        }
        pending = remaining;
        if (!pending.length) {
          const response = batch ? calls.map(call => answers.get(call.id)) : answers.get(calls[0].id);
          if (Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes) throw Object.assign(unavailable(), { noFailover: true });
          provider.retryAfter = 0; return response;
        }
        provider.retryAfter = Date.now() + 10000;
      } catch (error) {
        if (error.noFailover) throw unavailable();
        provider.verifiedUntil = 0; provider.retryAfter = Date.now() + 10000;
      }
    }
    throw unavailable();
  }
  async function request({ method, params } = {}) {
    const response = await forward({ jsonrpc: '2.0', id: ++nextId, method, params });
    if (response.error) throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  }
  return { request, forward };
}
