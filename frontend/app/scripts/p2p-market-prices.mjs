import { parseAbi } from 'viem';
import { sessionAt } from '../../../services/risk-monitor/src/calendar.mjs';

// Display-only market data. These observations never sign proofs or authorize loans.
export const PRICE_MARKETS = Object.freeze({
  SPY: { market: '0x9C1eC6c0C5Ff43307EaA58408ff9674A5D4d7D09', token: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
    feeds: ['0x319724394D3A0e3669269846abE664Cd621f9f6A', '0xa68CA83408bE3f78d1c58a82081c619e9d21486d'] },
  QQQ: { market: '0xd41B87Ca091cbbf35dF36Aad9153d94248003163', token: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
    feeds: ['0x80901d846d5D7B030F26B480776EE3b29374C2ae', '0x41ed2c58611790af0760e31e80Bb427e4e83D603'] },
});
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const abi = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)', 'function description() view returns (string)', 'function oraclePaused() view returns (bool)']);
const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const unavailable = reason => ({ status: 'unavailable', reason });

export function createMarketPrices({ client, markets, fetchImpl = fetch, now = Date.now, quoteTtlMs = 30_000 }) {
  const enabled = Object.entries(PRICE_MARKETS).filter(([, config]) => markets.some(m => m.version === 3 && !m.legacy
    && m.chainId === 4663 && same(m.address, config.market) && same(m.collateralToken, config.token)
    && same(m.loanToken, USDG) && m.collateralDecimals === 18 && m.loanDecimals === 6));
  const cache = new Map(), pending = new Map();
  let active = 0, tokens = 2, refilledAt = now();
  async function cached(key, ttl, work) {
    const hit = cache.get(key);
    if (hit && now() >= hit.at && now() - hit.at < hit.ttl
      && (!hit.value.expiresAt || now() < hit.value.expiresAt * 1000 - (key.startsWith("quote:") ? 5000 : 0))) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const promise = work().catch(() => unavailable('provider_unavailable')).then(value => {
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), ttl: value.status === 'unavailable' ? 5000 : ttl, value });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  }
  async function reference(symbol, config) {
    return cached(`reference:${symbol}`, 60_000, async () => {
      const seconds = Math.floor(now() / 1000);
      if (await client.getChainId() !== 4663) return unavailable('wrong_chain');
      const block = await client.getBlock();
      if (Math.abs(seconds - Number(block.timestamp)) > 60) return unavailable('chain_head_unavailable');
      const read = (address, functionName) => client.readContract({ address, abi, functionName, blockNumber: block.number });
      if (await read(config.token, 'oraclePaused')) return unavailable('oracle_paused');
      for (const feed of config.feeds) {
        try {
          const [round, decimals, description] = await Promise.all([
            read(feed, 'latestRoundData'), read(feed, 'decimals'), read(feed, 'description')]);
          const updatedAt = Number(round[3]);
          if (!new RegExp(`^(?:RH|Robinhood )?${symbol}\\s*/\\s*USD$`).test(description) || decimals !== 8
            || round[1] <= 0n || round[0] === 0n || !Number.isSafeInteger(updatedAt) || updatedAt <= 0
            || updatedAt > Number(block.timestamp)) continue;
          return { status: 'available', source: 'Chainlink', feed, priceRaw: round[1].toString(), decimals,
            currency: 'USD', updatedAt, checkedAt: seconds, blockNumber: block.number.toString(), heartbeatSeconds: 86400 };
        } catch { /* Try the published secondary read proxy; never manufacture a reference price. */ }
      }
      return unavailable('reference_unavailable');
    });
  }
  async function quote(symbol, config, amount) {
    return cached(`quote:${symbol}:${amount}`, quoteTtlMs, async () => {
      const at = now(); tokens = Math.min(2, tokens + Math.max(0, at - refilledAt) / 1000); refilledAt = at;
      if (active >= 2 || tokens < 1) return unavailable('busy');
      tokens -= 1; active += 1;
      try {
        const url = new URL('https://aggregator-api.kyberswap.com/robinhood/api/v1/routes');
        url.search = new URLSearchParams({ tokenIn: config.token, tokenOut: USDG, amountIn: amount, gasInclude: 'false' }).toString();
        const response = await fetchImpl(url, { headers: { 'x-client-id': 'turret-p2p-market-data', 'User-Agent': 'Turret/1.0' },
          signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) return unavailable('quote_unavailable');
        // Bound streamed bytes before parsing upstream data.
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 131072) { await reader.cancel(); return unavailable('invalid_quote'); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const route = data?.data?.routeSummary;
        if (data.code !== 0 || !same(route?.tokenIn, config.token) || !same(route?.tokenOut, USDG)
          || route?.amountIn !== amount || !/^[1-9][0-9]{0,77}$/.test(route?.amountOut ?? '')
          || BigInt(route.amountOut) >= 1n << 256n || !Array.isArray(route.route) || !route.route.length) return unavailable('invalid_quote');
        const quotedAt = Math.floor(at / 1000), expiresAt = Math.floor((at + quoteTtlMs) / 1000);
        if (now() >= at + quoteTtlMs) return unavailable('quote_expired');
        return { status: 'available', source: 'Kyber', amountIn: amount, amountOut: route.amountOut,
          currency: 'USDG', decimals: 6, quotedAt, expiresAt, gasIncluded: false, executionVerified: false };
      } finally { active -= 1; }
    });
  }
  return {
    async get(market, amount) {
      const entry = enabled.find(([, config]) => same(market, config.market));
      if (!entry) throw Object.assign(new Error('unsupported_market'), { status: 400 });
      if (!/^[1-9][0-9]{0,21}$/.test(amount ?? '') || BigInt(amount) > 1000n * 10n ** 18n)
        throw Object.assign(new Error('invalid_amount'), { status: 400 });
      const [symbol, config] = entry;
      const [ref, sale] = await Promise.all([reference(symbol, config), quote(symbol, config, amount)]);
      const seconds = Math.floor(now() / 1000), session = sessionAt(seconds, 'equities-24x5');
      return { schemaVersion: 1, market: config.market, symbol, collateralAmount: amount, observedAt: seconds,
        informationalOnly: true, referenceSession: session.open ? 'open' : session.reason === 'calendar_expired' ? 'unknown' : 'closed',
        reference: ref.status === 'available' ? { ...ref, ageSeconds: Math.max(0, seconds - ref.updatedAt),
          stale: seconds - ref.updatedAt > ref.heartbeatSeconds } : ref,
        sale: sale.status === 'available' && seconds >= sale.expiresAt ? unavailable('quote_expired') : sale };
    },
  };
}

export function createMarketPricesHandler(service) {
  return async (request, response, headers = {}) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/api/p2p/market-prices') return false;
    const send = (status, body) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'GET') { send(405, { error: 'method_not_allowed' }); return true; }
    if (url.search.length > 160 || [...url.searchParams.keys()].length !== 2
      || !url.searchParams.has('market') || !url.searchParams.has('amount')) { send(400, { error: 'invalid_request' }); return true; }
    try { send(200, await service.get(url.searchParams.get('market'), url.searchParams.get('amount'))); }
    catch (error) { send(error.status === 400 ? 400 : 503, { error: error.status === 400 ? error.message : 'prices_unavailable' }); }
    return true;
  };
}
