// Read-only AAPL weekend observations. Kraken xStocks are a different asset
// from Robinhood collateral: this book is never a collateral liquidation route.
const API = 'https://api.kraken.com/0/public/';
const MAX_BODY_BYTES = 256_000;
const MAX_PRICE = 1_000_000_000;
const MAX_AMOUNT = 1_000_000_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class KrakenObservationFault extends Error {
  constructor(code) { super(code); this.name = code; }
}
const fail = code => { throw new KrakenObservationFault(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value, maximum, allowZero = false) => {
  if (!(typeof value === 'number' || typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(value))) fail('KrakenMalformed');
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0) || number > maximum) fail('KrakenMalformed');
  return number;
};
const timestamp = (value, now) => {
  const at = positive(value, 10_000_000_000);
  if (at > now / 1000 + 2) fail('KrakenFutureTimestamp');
  return at;
};
const integerIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function configuration(input) {
  const config = {
    pair: 'AAPLxUSD', sellTokenAmounts: [1, 10, 100], depthLevels: 100,
    tradeCount: 100, maxTradeAgeSeconds: 60, timeoutMs: 5000, allowStaleTrade: false, ...input,
  };
  if (config.pair !== 'AAPLxUSD' || !integerIn(config.depthLevels, 1, 500)
    || !integerIn(config.tradeCount, 1, 1000) || !integerIn(config.timeoutMs, 100, 10000)
    || !integerIn(config.maxTradeAgeSeconds, 1, 300) || typeof config.allowStaleTrade !== 'boolean'
    || !Array.isArray(config.sellTokenAmounts) || !config.sellTokenAmounts.length || config.sellTokenAmounts.length > 16
    || config.sellTokenAmounts.some(amount => typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT)
    || new Set(config.sellTokenAmounts).size !== config.sellTokenAmounts.length) fail('KrakenInvalidConfiguration');
  return config;
}

async function readBody(response) {
  const length = response.headers?.get('content-length');
  if (length !== null && length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('KrakenMalformed');
  if (!response.body?.getReader) fail('KrakenMalformed');
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail('KrakenMalformed'); }
      parts.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(data));
  } catch (error) {
    if (error instanceof KrakenObservationFault) throw error;
    fail('KrakenMalformed');
  } finally { reader.releaseLock(); }
}

async function request(endpoint, config, count, fetcher, now) {
  const url = new URL(endpoint, API);
  url.search = new URLSearchParams({pair: config.pair, asset_class: 'tokenized_asset', count: String(count)}).toString();
  let response;
  try {
    response = await fetcher(url, {method: 'GET', redirect: 'error', cache: 'no-store',
      headers: {accept: 'application/json'}, signal: AbortSignal.timeout(config.timeoutMs)});
  } catch { fail('KrakenUnavailable'); }
  if (!response.ok) fail(response.status === 429 ? 'KrakenRateLimited' : 'KrakenUnavailable');
  if (response.redirected) fail('KrakenUnavailable');
  const body = await readBody(response), receivedAt = now();
  if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) fail('KrakenInvalidClock');
  if (!object(body) || !Array.isArray(body.error)) fail('KrakenMalformed');
  if (body.error.length) fail(body.error.some(error => typeof error === 'string' && /rate limit/i.test(error))
    ? 'KrakenRateLimited' : 'KrakenUnavailable');
  if (!object(body.result)) fail('KrakenMalformed');
  const pairs = Object.keys(body.result).filter(key => key !== 'last');
  // No arbitrary first-result fallback: a symbol typo cannot silently select another asset.
  if (pairs.length !== 1 || !/^AAPLx\/?USD$/i.test(pairs[0])) fail('KrakenPairMismatch');
  return {data: body.result[pairs[0]], receivedAt};
}

function levels(rows, side, count, now) {
  if (!Array.isArray(rows) || !rows.length || rows.length > count) fail('KrakenMalformed');
  const result = [];
  let ignoredZeroPriceBidLevels = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3) fail('KrakenMalformed');
    const level = {priceUsd: positive(row[0], MAX_PRICE, side === 'bid'), tokenAmount: positive(row[1], MAX_AMOUNT),
      updatedAt: timestamp(row[2], now)};
    // Kraken can include a final bid rounded/displayed as "0.00". It cannot
    // produce positive sale proceeds, so exclude only this unusable tail.
    // A zero best bid, zero ask or any positive bid after the tail is invalid.
    if (level.priceUsd === 0) {
      if (!result.length) fail('KrakenMalformed');
      ignoredZeroPriceBidLevels++;
      continue;
    }
    if (ignoredZeroPriceBidLevels) fail('KrakenMalformed');
    result.push(level);
  }
  for (let i = 1; i < result.length; i++) {
    if (side === 'bid' ? result[i].priceUsd >= result[i - 1].priceUsd
      : result[i].priceUsd <= result[i - 1].priceUsd) fail('KrakenUnorderedBook');
  }
  return {levels: result, ignoredZeroPriceBidLevels};
}

function sellBook(bids, tokenAmount, midUsd) {
  let remaining = tokenAmount, filledTokenAmount = 0, filledGrossProceedsUsd = 0, levelsUsed = 0;
  for (const level of bids) {
    const amount = Math.min(remaining, level.tokenAmount);
    filledTokenAmount += amount;
    filledGrossProceedsUsd += amount * level.priceUsd;
    remaining = Math.max(0, remaining - amount);
    levelsUsed++;
    if (remaining === 0) break;
  }
  const fullyFilled = remaining === 0;
  return {tokenAmount, fullyFilled, filledTokenAmount, unfilledTokenAmount: remaining, levelsUsed,
    filledGrossProceedsUsd,
    // A partial book fill must not look like a complete sale quote.
    grossProceedsUsd: fullyFilled ? filledGrossProceedsUsd : null,
    averagePriceUsd: fullyFilled ? filledGrossProceedsUsd / tokenAmount : null,
    slippageBps: fullyFilled ? (1 - filledGrossProceedsUsd / (tokenAmount * midUsd)) * 10000 : null};
}

/**
 * Fetch Depth and Trades for the AAPL xStock pilot. All amounts are Kraken
 * token units, not Robinhood token amounts or an assumed number of shares.
 * Prices/proceeds are approximate telemetry and exclude trading fees.
 * now returns milliseconds; wait is injectable for deterministic tests.
 */
export async function requestKrakenWeekendSnapshot(input = {}, fetcher = fetch, now = Date.now, wait = sleep) {
  const config = configuration(input), startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) fail('KrakenInvalidClock');
  const depth = await request('Depth', config, config.depthLevels, fetcher, now);
  // Keep these public REST requests at least one second apart, including on a fast network.
  await wait(Math.max(0, 1100 - (now() - startedAt)));
  const trades = await request('Trades', config, config.tradeCount, fetcher, now);
  const receivedAt = trades.receivedAt;
  if (depth.receivedAt < startedAt || receivedAt < depth.receivedAt || receivedAt - startedAt > config.timeoutMs * 2 + 2000) fail('KrakenCollectionStale');
  if (!object(depth.data)) fail('KrakenMalformed');
  const bidBook = levels(depth.data.bids, 'bid', config.depthLevels, receivedAt);
  const bids = bidBook.levels;
  const asks = levels(depth.data.asks, 'ask', config.depthLevels, receivedAt).levels;
  const bidUsd = bids[0].priceUsd, askUsd = asks[0].priceUsd;
  if (bidUsd >= askUsd) fail('KrakenCrossedBook');
  if (!Array.isArray(trades.data) || !trades.data.length || trades.data.length > config.tradeCount) fail('KrakenMalformed');
  let latestTrade;
  for (const row of trades.data) {
    if (!Array.isArray(row) || row.length < 6 || row.length > 7 || !['b', 's'].includes(row[3]) || !['m', 'l'].includes(row[4])) fail('KrakenMalformed');
    const trade = {priceUsd: positive(row[0], MAX_PRICE), tokenAmount: positive(row[1], MAX_AMOUNT), at: timestamp(row[2], receivedAt)};
    if (!latestTrade || trade.at > latestTrade.at) latestTrade = trade;
  }
  const tradeAgeSeconds = (receivedAt - latestTrade.at * 1000) / 1000;
  const fresh = tradeAgeSeconds < config.maxTradeAgeSeconds;
  if (!fresh && !config.allowStaleTrade) fail('KrakenStaleTrade');
  const midUsd = (bidUsd + askUsd) / 2;
  return {source: 'kraken-xstocks', pair: config.pair, observationOnly: true,
    fresh, reason: fresh ? null : 'KrakenStaleTrade', maxTradeAgeSeconds: config.maxTradeAgeSeconds,
    collateralLiquidationEvidence: false, priceUnit: 'USD per AAPLx token', amountUnit: 'AAPLx token',
    feesIncluded: false, startedAt, receivedAt, depthReceivedAt: depth.receivedAt, tradesReceivedAt: trades.receivedAt,
    bidUsd, askUsd, midUsd, spreadBps: (askUsd - bidUsd) / midUsd * 10000,
    latestTradeAt: latestTrade.at, latestTradePriceUsd: latestTrade.priceUsd, tradeAgeSeconds,
    tradeMidDivergenceBps: Math.abs(latestTrade.priceUsd - midUsd) / midUsd * 10000,
    // Level timestamps describe changes to resting orders, not feed heartbeats.
    bookTimestampIsHeartbeat: false, ignoredZeroPriceBidLevels: bidBook.ignoredZeroPriceBidLevels, bids, asks,
    sellQuotes: config.sellTokenAmounts.map(amount => sellBook(bids, amount, midUsd))};
}
