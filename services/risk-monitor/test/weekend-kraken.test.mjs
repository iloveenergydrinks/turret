import test from 'node:test';
import assert from 'node:assert/strict';
import {requestKrakenWeekendSnapshot} from '../src/weekend-kraken.mjs';

const NOW = 1_788_627_000_000;
const rowTime = NOW / 1000;
const book = () => ({error: [], result: {AAPLxUSD: {
  bids: [['99', '2', rowTime - 3600], ['98', '3', rowTime - 3600]],
  asks: [['101', '1', rowTime - 3600], ['102', '4', rowTime - 3600]],
}}});
const trades = () => ({error: [], result: {AAPLxUSD: [
  ['100', '1', rowTime - 5, 'b', 'm', '', 1], ['100', '1', rowTime - 1, 's', 'l', '', 2],
], last: '1788626999000000000'}});
function fixture({depth = book(), recent = trades(), respond, time = NOW} = {}) {
  const calls = [], waits = [];
  let clock = time;
  const fetcher = async (url, options) => {
    calls.push({url, options, at: clock});
    if (respond) return respond(url, options);
    return new Response(JSON.stringify(url.pathname.endsWith('/Depth') ? depth : recent));
  };
  return {calls, waits, run: (config = {}) => requestKrakenWeekendSnapshot(config, fetcher,
    () => clock, async milliseconds => { waits.push(milliseconds); clock += milliseconds; })};
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('samples exact AAPL pair, uses real trade freshness, and walks observed bids for each requested token amount', async () => {
  const f = fixture(), result = await f.run({sellTokenAmounts: [1, 4, 6]});
  assert.equal(result.bidUsd, 99); assert.equal(result.askUsd, 101); assert.equal(result.midUsd, 100);
  assert.equal(result.spreadBps, 200); assert.equal(result.latestTradeAt, rowTime - 1);
  close(result.tradeAgeSeconds, 2.1); assert.equal(result.receivedAt, NOW + 1100);
  assert.equal(result.depthReceivedAt, NOW); assert.equal(result.bookTimestampIsHeartbeat, false);
  assert.equal(result.observationOnly, true); assert.equal(result.collateralLiquidationEvidence, false);
  assert.equal(result.amountUnit, 'AAPLx token'); assert.equal(result.feesIncluded, false);
  assert.equal(result.sellQuotes[0].grossProceedsUsd, 99); close(result.sellQuotes[0].slippageBps, 100);
  assert.equal(result.sellQuotes[1].grossProceedsUsd, 394); assert.equal(result.sellQuotes[1].levelsUsed, 2);
  assert.equal(result.sellQuotes[2].fullyFilled, false); assert.equal(result.sellQuotes[2].filledTokenAmount, 5);
  assert.equal(result.sellQuotes[2].unfilledTokenAmount, 1); assert.equal(result.sellQuotes[2].grossProceedsUsd, null);
  assert.equal(result.sellQuotes[2].slippageBps, null);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.waits, [1100]);
  for (const {url, options} of f.calls) {
    assert.equal(url.origin, 'https://api.kraken.com');
    assert.equal(url.searchParams.get('pair'), 'AAPLxUSD');
    assert.equal(url.searchParams.get('asset_class'), 'tokenized_asset');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal); assert.deepEqual(options.headers, {accept: 'application/json'});
  }
});

test('rejects stale trades despite a newly received book or a fresh cursor', async () => {
  const recent = trades(); recent.result.AAPLxUSD.forEach(row => { row[2] = rowTime - 60; });
  recent.result.last = String((rowTime + 1) * 1e9);
  await assert.rejects(fixture({recent}).run(), {name: 'KrakenStaleTrade'});
  const observation = await fixture({recent}).run({allowStaleTrade: true});
  assert.equal(observation.fresh, false); assert.equal(observation.reason, 'KrakenStaleTrade');
  assert.equal(observation.latestTradeAt, rowTime - 60); assert.equal(observation.receivedAt, NOW + 1100);
  assert.equal(observation.bidUsd, 99);
});

test('rejects at the freshness boundary and accepts a bounded configurable freshness limit', async () => {
  const recent = trades(); recent.result.AAPLxUSD.forEach(row => { row[2] = rowTime - 58.9; });
  await assert.rejects(fixture({recent}).run(), {name: 'KrakenStaleTrade'});
  assert.equal((await fixture({recent}).run({maxTradeAgeSeconds: 61})).latestTradeAt, rowTime - 58.9);
});

test('never selects an unrelated, missing or ambiguous returned pair', async () => {
  for (const key of ['AAPLUSD', 'NVDAxUSD', 'XXBTZUSD']) {
    const depth = book(); depth.result = {[key]: depth.result.AAPLxUSD};
    await assert.rejects(fixture({depth}).run(), {name: 'KrakenPairMismatch'});
  }
  const depth = book(); depth.result.extra = depth.result.AAPLxUSD;
  await assert.rejects(fixture({depth}).run(), {name: 'KrakenPairMismatch'});
  const canonical = book(); canonical.result = {'AAPLx/USD': canonical.result.AAPLxUSD};
  assert.equal((await fixture({depth: canonical}).run()).pair, 'AAPLxUSD');
});

test('rejects missing, unordered, duplicate, crossed and locked books', async () => {
  for (const mutate of [
    depth => { depth.result.AAPLxUSD.bids = []; },
    depth => { delete depth.result.AAPLxUSD.asks; },
    depth => { depth.result.AAPLxUSD.bids.reverse(); },
    depth => { depth.result.AAPLxUSD.asks.reverse(); },
    depth => { depth.result.AAPLxUSD.bids[1][0] = '99'; },
    depth => { depth.result.AAPLxUSD.bids[0][0] = '102'; },
    depth => { depth.result.AAPLxUSD.bids[0][0] = '101'; },
  ]) { const depth = book(); mutate(depth); await assert.rejects(fixture({depth}).run()); }
});

test('excludes live Kraken zero-price bid tails without treating them as usable sale depth', async () => {
  const depth = book();
  depth.result.AAPLxUSD.bids.push(['0.00', '100.000000', rowTime - 3600]);
  const sample = await fixture({depth}).run({sellTokenAmounts: [4, 6]});
  assert.equal(sample.ignoredZeroPriceBidLevels, 1);
  assert.equal(sample.bids.length, 2);
  assert.equal(sample.sellQuotes[0].grossProceedsUsd, 394);
  assert.equal(sample.sellQuotes[1].fullyFilled, false);
  assert.equal(sample.sellQuotes[1].filledTokenAmount, 5);
  assert.equal(sample.sellQuotes[1].unfilledTokenAmount, 1);
  assert.equal(sample.sellQuotes[1].grossProceedsUsd, null);
  for (const mutate of [
    value => { value.result.AAPLxUSD.bids.unshift(['0.00', '1', rowTime]); },
    value => { value.result.AAPLxUSD.bids.splice(1, 0, ['0.00', '1', rowTime]); },
    value => { value.result.AAPLxUSD.asks.push(['0.00', '1', rowTime]); },
    value => { value.result.AAPLxUSD.bids.push(['-0.01', '1', rowTime]); },
  ]) {
    const invalid = book(); mutate(invalid);
    await assert.rejects(fixture({depth: invalid}).run(), {name: 'KrakenMalformed'});
  }
});

test('rejects nonpositive, nonfinite, unbounded or nonnumeric prices and quantities', async () => {
  for (const value of ['NaN', 'Infinity', '-1', '0', '', ' ', '0x10', null, true, {}, '1e3', 1e10]) {
    for (const index of [0, 1]) {
      const depth = book(); depth.result.AAPLxUSD.bids[0][index] = value;
      await assert.rejects(fixture({depth}).run(), {name: 'KrakenMalformed'});
      const recent = trades(); recent.result.AAPLxUSD[0][index] = value;
      await assert.rejects(fixture({recent}).run(), {name: 'KrakenMalformed'});
    }
  }
});

test('rejects future data timestamps, empty trades and oversized responses', async () => {
  const depth = book(); depth.result.AAPLxUSD.bids[0][2] = rowTime + 10;
  await assert.rejects(fixture({depth}).run(), {name: 'KrakenFutureTimestamp'});
  const recent = trades(); recent.result.AAPLxUSD[0][2] = rowTime + 10;
  await assert.rejects(fixture({recent}).run(), {name: 'KrakenFutureTimestamp'});
  recent.result.AAPLxUSD = [];
  await assert.rejects(fixture({recent}).run(), {name: 'KrakenMalformed'});
  await assert.rejects(fixture().run({depthLevels: 1}), {name: 'KrakenMalformed'});
  await assert.rejects(fixture().run({tradeCount: 1}), {name: 'KrakenMalformed'});
  for (const response of [new Response('x'.repeat(256001)), new Response('{}', {headers: {'content-length': '256001'}}), new Response('{')]) {
    await assert.rejects(fixture({respond: () => response}).run(), {name: 'KrakenMalformed'});
  }
});

test('normalizes HTTP, timeout, JSON and Kraken errors without leaking response content', async () => {
  for (const [respond, name] of [
    [() => new Response('private upstream body', {status: 429}), 'KrakenRateLimited'],
    [() => new Response('private upstream body', {status: 500}), 'KrakenUnavailable'],
    [() => new Response(null, {status: 302, headers: {location: 'https://example.com'}}), 'KrakenUnavailable'],
    [() => { throw new Error('private internal network error'); }, 'KrakenUnavailable'],
    [() => new Response(JSON.stringify({error: ['EAPI:Rate limit exceeded']})), 'KrakenRateLimited'],
    [() => new Response(JSON.stringify({error: ['EQuery:Unknown asset pair'], result: {}})), 'KrakenUnavailable'],
  ]) await assert.rejects(fixture({respond}).run(), {name, message: name});
});

test('rejects invalid configuration before any network request', async () => {
  for (const config of [
    {pair: 'AAPLUSD'}, {pair: 'NVDAxUSD'}, {depthLevels: 0}, {depthLevels: 501}, {tradeCount: 1001},
    {timeoutMs: 99}, {timeoutMs: 10001}, {maxTradeAgeSeconds: 301}, {maxTradeAgeSeconds: 0}, {allowStaleTrade: 'true'},
    {sellTokenAmounts: []}, {sellTokenAmounts: [1, 1]}, {sellTokenAmounts: ['1']}, {sellTokenAmounts: [Infinity]},
    {sellTokenAmounts: [0]}, {sellTokenAmounts: [-1]}, {sellTokenAmounts: [1e10]},
  ]) { const f = fixture(); await assert.rejects(f.run(config), {name: 'KrakenInvalidConfiguration'}); assert.equal(f.calls.length, 0); }
});

test('rejects a clock rollback and collection that outlives both bounded requests', async () => {
  for (const shift of [-1, 20000]) {
    let clock = NOW;
    const fetcher = async url => new Response(JSON.stringify(url.pathname.endsWith('/Depth') ? book() : trades()));
    await assert.rejects(requestKrakenWeekendSnapshot({}, fetcher, () => clock, async () => { clock += shift; }),
      {name: 'KrakenCollectionStale'});
  }
});
