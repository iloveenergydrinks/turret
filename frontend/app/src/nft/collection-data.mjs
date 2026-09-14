// Informational market data only. This data never authorizes a loan or values collateral.
const SOURCES = { '0xe3b34c4bb0f12c82143745eee6a6cf4e3154b1fa': 'cashcatss', '0xf08c65564eb07d880021105489552080b08e4319': 'robinhood-punks' };
const TTL = 300_000, MAX_AGE = 3_600_000;
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
export function createNFTCollectionData({ collections, fetchImpl = fetch, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  async function one(collection) {
    const key = collection.address.toLowerCase(), id = SOURCES[key];
    const empty = { address: collection.address, volume24hUSD: null, floorETH: null, owners: null, fetchedAt: null, status: 'unavailable', sourceURL: id ? `https://www.coingecko.com/en/nft/${id}` : null };
    if (!id) return empty;
    const old = cache.get(key);
    if (old && old.retryAfter > now()) return old.value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      try {
        const response = await fetchImpl(`https://api.coingecko.com/api/v3/nfts/${id}`, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' } });
        if (!response.ok) throw Error('Provider unavailable');
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.length; if (size > 200_000) throw Error('Oversized response'); chunks.push(chunk); }
        const data = JSON.parse(await new Response(new Blob(chunks)).text());
        if (data.id !== id || data.contract_address?.toLowerCase() !== key || data.asset_platform_id !== 'robinhood') throw Error('Wrong collection identity');
        const value = { ...empty, volume24hUSD: number(data.volume_24h?.usd), floorETH: data.native_currency_symbol === 'ETH' ? number(data.floor_price?.native_currency) : null,
          owners: Number.isSafeInteger(data.number_of_unique_addresses) ? number(data.number_of_unique_addresses) : null, fetchedAt: new Date(now()).toISOString(), status: 'current' };
        cache.set(key, { value, successAt: now(), retryAfter: now() + TTL }); return value;
      } catch {
        const value = old?.successAt != null && now() - old.successAt < MAX_AGE ? { ...old.value, status: 'delayed' } : empty;
        cache.set(key, { value, successAt: old?.successAt, retryAfter: now() + 60_000 }); return value;
      } finally { pending.delete(key); }
    })();
    pending.set(key, work); return work;
  }
  return async () => ({ collections: await Promise.all(collections.filter(c => c.enabled).map(one)) });
}
