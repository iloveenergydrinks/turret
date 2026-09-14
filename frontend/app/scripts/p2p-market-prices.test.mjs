import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketPrices, PRICE_MARKETS, createMarketPricesHandler } from './p2p-market-prices.mjs';
const cash = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const amount = '1000000000000000000';
const markets = Object.values(PRICE_MARKETS).map(c => ({ version: 3, chainId: 4663, address: c.market, collateralToken: c.token,
  loanToken: cash, collateralDecimals: 18, loanDecimals: 6 }));
function fixture(options = {}) {
  let clock = Date.parse('2026-09-12T15:00:00Z'), calls = 0, reads = 0;
  const client = { getChainId: async () => 4663, getBlock: async () => ({ number: 100n, timestamp: BigInt(Math.floor(clock / 1000)) }),
    readContract: async ({ functionName }) => { reads++; return ({ description: 'RHSPY / USD', decimals: 8, oraclePaused: false,
      latestRoundData: [1n, 70000000000n, 0n, BigInt(Math.floor(clock / 1000) - 100000), 1n] })[functionName]; }, ...options.client };
  const fetchImpl = async (url, init) => { calls++; assert.equal(url.origin, 'https://aggregator-api.kyberswap.com');
    assert.equal(init.redirect, 'error'); const input = url.searchParams;
    return new Response(JSON.stringify({ code: 0, data: { routeSummary: { tokenIn: input.get('tokenIn'), tokenOut: cash,
      amountIn: input.get('amountIn'), amountOut: '690000000', route: [[{}]], ...options.route } } }), { status: options.status ?? 200 }); };
  const service = createMarketPrices({ client, markets, now: () => clock, fetchImpl: options.fetchImpl ?? fetchImpl });
  return { service, advance: ms => { clock += ms; }, counts: () => ({ calls, reads }) };
}
test('weekend reference is labeled historical while current sale quote remains available', async () => {
  const { service } = fixture(); const r = await service.get(PRICE_MARKETS.SPY.market, amount);
  assert.equal(r.referenceSession, 'closed'); assert.equal(r.reference.stale, true); assert.equal(r.reference.status, 'available');
  assert.equal(r.sale.status, 'available'); assert.equal(r.sale.executionVerified, false); assert.equal(r.informationalOnly, true);
});
test('200 simultaneous identical viewers share one quote and one reference read', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 200 }, () => f.service.get(PRICE_MARKETS.SPY.market, amount)));
  assert.deepEqual(f.counts(), { calls: 1, reads: 4 });
});
test('amount change requests exact size and expired data is refreshed', async () => {
  const f = fixture(); const a = await f.service.get(PRICE_MARKETS.SPY.market, amount);
  const b = await f.service.get(PRICE_MARKETS.SPY.market, '2000000000000000000');
  assert.notEqual(a.sale.amountIn, b.sale.amountIn); f.advance(31000);
  const c = await f.service.get(PRICE_MARKETS.SPY.market, amount);
  assert(c.sale.quotedAt > a.sale.quotedAt); assert.equal(f.counts().calls, 3);
});
test('arbitrary unique requests cannot flood upstream', async () => {
  const f = fixture(); const rows = await Promise.all(Array.from({ length: 100 }, (_, n) => f.service.get(PRICE_MARKETS.SPY.market, String(n + 1))));
  assert.equal(f.counts().calls, 2); assert.equal(rows.filter(r => r.sale.reason === 'busy').length, 98);
});
test('wrong market, precision, negative, zero and excessive amounts are rejected before upstream', async () => {
  const f = fixture(); for (const v of ['0', '-1', '1.1', '1e18', '01', '1'.repeat(78), '1000000000000000000001'])
    await assert.rejects(f.service.get(PRICE_MARKETS.SPY.market, v), /invalid_amount/);
  await assert.rejects(f.service.get(cash, amount), /unsupported_market/); assert.equal(f.counts().calls, 0);
});
for (const route of [{ tokenOut: PRICE_MARKETS.SPY.token }, { amountIn: '7' }, { amountOut: '0' }, { amountOut: 'NaN' }, { route: [] }])
  test(`rejects malformed upstream route ${JSON.stringify(route)}`, async () => {
    const { service } = fixture({ route }); assert.equal((await service.get(PRICE_MARKETS.SPY.market, amount)).sale.reason, 'invalid_quote');
  });
test('quote outage leaves historical reference available without fabricating a price', async () => {
  const { service } = fixture({ status: 503 }); const r = await service.get(PRICE_MARKETS.SPY.market, amount);
  assert.equal(r.reference.status, 'available'); assert.equal(r.sale.status, 'unavailable'); assert.equal(r.sale.amountOut, undefined);
});
test('paused or wrong-chain oracle cannot publish reference value', async () => {
  for (const client of [{ getChainId: async () => 1 }, { readContract: async () => true }]) {
    const { service } = fixture({ client }); const r = await service.get(PRICE_MARKETS.SPY.market, amount);
    assert.equal(r.reference.status, 'unavailable'); assert.equal(r.reference.priceRaw, undefined);
  }
});
test('HTTP interface rejects writes, duplicate parameters and user-selected upstreams', async () => {
  const { service } = fixture(); const handler = createMarketPricesHandler(service);
  for (const [method, url, expected] of [['POST', '/api/p2p/market-prices', 405], ['GET', '/api/p2p/market-prices?market=x&amount=1&url=https://evil', 400],
    ['GET', '/api/p2p/market-prices?market=x&market=y&amount=1', 400]]) {
    let status; await handler({ method, url }, { writeHead: s => { status = s; }, end: () => {} }); assert.equal(status, expected);
  }
});

test('quotes are renewed before the last five seconds of validity', async () => {
 const f = fixture(); const a = await f.service.get(PRICE_MARKETS.SPY.market, amount);
 f.advance(26000); const b = await f.service.get(PRICE_MARKETS.SPY.market, amount);
 assert(b.sale.expiresAt > a.sale.expiresAt); assert.equal(f.counts().calls, 2);
});
