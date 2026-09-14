import { isAddress } from "viem";

const uint = value => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const allowedImageHosts = new Set(["res.cloudinary.com", "nft2-cdn.alchemy.com", "nft-cdn.alchemy.com"]);
export function alchemyNFTBase(rpcUrls) {
  for (const value of rpcUrls) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "robinhood-mainnet.g.alchemy.com" && /^\/v2\/[^/]+$/.test(url.pathname)
        && !url.username && !url.password && !url.port) {
        url.pathname = url.pathname.replace("/v2/", "/nft/v3/") + "/"; url.search = ""; url.hash = "";
        return url.href;
      }
    } catch { /* Not a compatible Alchemy endpoint. */ }
  }
  return null;
}

/** Metadata is informational. No provider-reported ownership or floor price authorizes a loan. */
export function createNFTAssets({ collections, baseUrl, fetchImpl = fetch, now = Date.now }) {
  const registry = new Map(collections.map(x => [x.address.toLowerCase(), x]));
  const cache = new Map(), images = new Map(), pending = new Map();
  const waiting = [];
  let active = 0, imageBytes = 0;
  async function acquire() {
    if (active < 8) { active++; return; }
    if (waiting.length >= 64) throw fail("NFT data is busy. Retry shortly.", 429);
    await new Promise((resolve, reject) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(fail("NFT data is busy. Retry shortly.", 503));
      }, 15_000);
      waiting.push(entry);
    });
  }
  function release() {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active--;
  }
  async function limited(url, maxBytes, accept) {
    await acquire();
    try {
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(12_000), headers: { Accept: accept } });
      if (!response.ok) throw fail("NFT data provider is temporarily unavailable.", 503);
      if (Number(response.headers.get("content-length")) > maxBytes) throw fail("NFT response is too large.", 502);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw fail("NFT response is too large.", 502);
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), type: response.headers.get("content-type")?.split(";")[0] };
    } finally { release(); }
  }
  async function cached(key, get, ttl = 30_000) {
    const old = cache.get(key);
    if (old && old.until > now()) return old.value;
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 100) throw fail("NFT data is busy. Retry shortly.", 429);
    const work = (async () => {
      try {
        const value = await get();
        if (ttl > 0) {
          if (cache.size >= 1000) cache.delete(cache.keys().next().value);
          cache.set(key, { until: now() + ttl, value });
        }
        return value;
      } finally { pending.delete(key); }
    })();
    pending.set(key, work); return work;
  }
  async function api(method, params) {
    if (!baseUrl) throw fail("NFT discovery is not configured.", 503);
    const url = new URL(method, baseUrl);
    for (const [key, value] of params) url.searchParams.append(key, value);
    const { bytes } = await limited(url, 2_000_000, "application/json");
    try { return JSON.parse(bytes.toString("utf8")); } catch { throw fail("NFT data provider returned invalid data.", 502); }
  }
  function selected(collection) {
    const config = typeof collection === "string" && registry.get(collection.toLowerCase());
    if (!config) throw fail("Choose a supported NFT collection.");
    return config;
  }
  function item(raw) {
    const collection = registry.get(raw?.contract?.address?.toLowerCase());
    if (!collection || !uint(raw.tokenId) || raw.tokenType !== "ERC721") return null;
    return { collection: collection.address, collectionName: collection.name, tokenId: raw.tokenId,
      name: typeof raw.name === "string" ? raw.name.slice(0, 160) : `${collection.name} #${raw.tokenId}`,
      image: `/api/p2p/nft/image?collection=${collection.address}&tokenId=${raw.tokenId}` };
  }
  async function metadata(collection, tokenId) {
    const config = selected(collection);
    if (!uint(tokenId)) throw fail("Invalid NFT token ID.");
    return cached(`token:${config.address.toLowerCase()}:${tokenId}`, async () => {
      const raw = await api("getNFTMetadata", [["contractAddress", config.address], ["tokenId", tokenId], ["tokenType", "ERC721"]]);
      if (!item(raw) || raw.contract.address.toLowerCase() !== config.address.toLowerCase() || raw.tokenId !== tokenId) {
        throw fail("NFT metadata identity does not match.", 502);
      }
      // Cache only fields we use, never arbitrary multi-megabyte token metadata.
      const image = {};
      for (const key of ["pngUrl", "cachedUrl"]) if (typeof raw.image?.[key] === "string" && raw.image[key].length <= 2048) image[key] = raw.image[key];
      return { contract: { address: config.address }, tokenId, tokenType: "ERC721", name: item(raw).name, image };
    });
  }
  return {
    async list({ owner, collection, pageKey } = {}) {
      if (owner && !isAddress(owner, { strict: false })) throw fail("Invalid wallet address.");
      if (!owner && !collection) throw fail("Choose a collection or wallet.");
      if (pageKey && (pageKey.length > 512 || !/^[a-zA-Z0-9_=+:/.-]+$/.test(pageKey))) throw fail("Invalid NFT page.");
      const configs = collection ? [selected(collection)] : collections.filter(x => x.enabled);
      return cached(`list:${owner?.toLowerCase() || ""}:${collection?.toLowerCase() || ""}:${pageKey || ""}`, async () => {
        const params = [["withMetadata", "true"]];
        if (owner) {
          params.push(["owner", owner], ["pageSize", "30"]);
          for (const config of configs) params.push(["contractAddresses[]", config.address]);
          if (pageKey) params.push(["pageKey", pageKey]);
        } else {
          params.push(["contractAddress", configs[0].address], ["limit", "30"]);
          if (pageKey) params.push(["startToken", pageKey]);
        }
        const raw = await api(owner ? "getNFTsForOwner" : "getNFTsForContract", params);
        const rows = owner ? raw.ownedNfts : raw.nfts;
        if (!Array.isArray(rows) || rows.length > 30) throw fail("NFT discovery returned an invalid page.", 502);
        const nextPage = raw.pageKey ?? null;
        if (nextPage !== null && (typeof nextPage !== "string" || !nextPage || nextPage.length > 512
          || !/^[a-zA-Z0-9_=+:/.-]+$/.test(nextPage) || nextPage === pageKey)) throw fail("NFT discovery returned an invalid page cursor.", 502);
        const items = rows.map(item).filter(Boolean).filter(x => configs.some(c => c.address.toLowerCase() === x.collection.toLowerCase()));
        return { items, nextPage, checkedAt: new Date(now()).toISOString() };
      });
    },
    async token({ collection, tokenId }) { return item(await metadata(collection, tokenId)); },
    async image({ collection, tokenId }) {
      selected(collection);
      if (!uint(tokenId)) throw fail("Invalid NFT token ID.");
      const key = `${collection.toLowerCase()}:${tokenId}`;
      const old = images.get(key);
      if (old && old.until > now()) return old;
      return cached(`image:${key}`, async () => {
        const raw = await metadata(collection, tokenId);
        const value = raw.image?.pngUrl || raw.image?.cachedUrl;
        let url;
        try { url = new URL(value); } catch { throw fail("NFT artwork is unavailable.", 404); }
        if (url.protocol !== "https:" || !allowedImageHosts.has(url.hostname) || url.username || url.password || url.port) {
          throw fail("NFT artwork source is unsupported.", 404);
        }
        const result = await limited(url, 2_000_000, "image/png,image/webp,image/jpeg");
        if (!["image/png", "image/webp", "image/jpeg", "image/gif"].includes(result.type)) throw fail("NFT artwork format is unsupported.", 415);
        // Never serve HTML/SVG or arbitrary NFT metadata URLs through this origin.
        const magic = result.bytes.subarray(0, 12);
        const valid = result.type === "image/png" ? magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          : result.type === "image/jpeg" ? magic[0] === 255 && magic[1] === 216
          : result.type === "image/gif" ? /^GIF8[79]a/.test(magic.toString())
          : magic.subarray(0,4).toString() === "RIFF" && magic.subarray(8,12).toString() === "WEBP";
        if (!valid) throw fail("NFT artwork is invalid.", 415);
        if (old) { imageBytes -= old.bytes.length; images.delete(key); }
        while (images.size && imageBytes + result.bytes.length > 32_000_000) {
          const first = images.keys().next().value; imageBytes -= images.get(first).bytes.length; images.delete(first);
        }
        const saved = { ...result, until: now() + 3_600_000 };
        images.set(key, saved); imageBytes += result.bytes.length; return saved;
      }, 0);
    },
  };
}

export function createNFTAssetsHandler(service) {
  return async (request, response, headers = {}) => {
    const url = new URL(request.url || "/", "http://localhost");
    const method = { "/api/p2p/nft/assets": "list", "/api/p2p/nft/token": "token", "/api/p2p/nft/image": "image" }[url.pathname];
    if (!method) return false;
    try {
      if (request.method !== "GET") throw fail("Use GET.", 405);
      const data = await service[method](Object.fromEntries(url.searchParams));
      if (method === "image") {
        response.writeHead(200, { ...headers, "Content-Type": data.type, "Content-Length": data.bytes.length,
          "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" });
        response.end(data.bytes);
      } else {
        response.writeHead(200, { ...headers, "Content-Type": "application/json", "Cache-Control": "private, max-age=15" });
        response.end(JSON.stringify(data));
      }
    } catch (error) {
      response.writeHead(error.status || 503, { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: error.status ? error.message : "NFT data is temporarily unavailable. Retry shortly." }));
    }
    return true;
  };
}
