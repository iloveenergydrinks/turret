import test from "node:test";
import assert from "node:assert/strict";
import { alchemyNFTBase, createNFTAssets } from "./nft-assets.mjs";

const collection = `0x${"11".repeat(20)}`, owner = `0x${"22".repeat(20)}`;
const raw = { contract: { address: collection }, tokenType: "ERC721", tokenId: "0", name: "Cat #0",
  image: { pngUrl: "https://res.cloudinary.com/alchemyapi/image/upload/cat.png" } };
const options = { collections: [{ address: collection, name: "Cats", enabled: true }], baseUrl: "https://robinhood-mainnet.g.alchemy.com/nft/v3/test-only/" };
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
test("a 30-artwork grid shared by 100 viewers queues requests within the provider concurrency limit", async () => {
  let active = 0, maximum = 0, calls = 0;
  const service = createNFTAssets({ ...options, fetchImpl: async url => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (url.hostname.includes("alchemy.com")) return json({ ...raw, tokenId: url.searchParams.get("tokenId") });
    return new Response(Buffer.from([137,80,78,71,13,10,26,10]), { headers: { "content-type": "image/png" } });
  } });
  const results = await Promise.allSettled(Array.from({length: 100}, () => Array.from({length: 30}, (_, i) => service.image({collection, tokenId: String(i)}))).flat());
  assert.equal(results.filter(result => result.status === "rejected").length, 0, "ordinary gallery loads must not get busy errors");
  assert.equal(calls, 60, "shared viewers reuse metadata and image requests");
  assert(maximum <= 8, "upstream concurrency stays bounded");
});
test("excess distinct requests cannot create an unbounded queue, and queued work drains", async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const service = createNFTAssets({ ...options, fetchImpl: async url => {
    await gate; return json({ ...raw, tokenId: url.searchParams.get("tokenId") });
  } });
  const work = Promise.allSettled(Array.from({length: 100}, (_, i) => service.token({collection, tokenId: String(i)})));
  await new Promise(resolve => setImmediate(resolve)); resume();
  const results = await work, rejected = results.filter(result => result.status === "rejected");
  assert(rejected.length > 0 && rejected.length < results.length);
  assert(rejected.every(result => result.reason.status === 429));
  assert.equal((await service.token({collection, tokenId: "101"})).tokenId, "101");
});
test("only Robinhood Alchemy RPC URLs can supply the private NFT API base", () => {
  assert.equal(alchemyNFTBase(["https://robinhood-mainnet.g.alchemy.com/v2/test-only"]), options.baseUrl);
  assert.equal(alchemyNFTBase(["https://eth-mainnet.g.alchemy.com/v2/key", "https://evil.example/v2/key", "http://127.0.0.1/v2/key"]), null);
});
test("coalesces concurrent owner discovery and caches it for 30 seconds", async () => {
  let calls = 0, now = 0;
  const service = createNFTAssets({ ...options, now: () => now, fetchImpl: async url => {
    calls++; assert.equal(url.searchParams.get("owner"), owner); assert.deepEqual(url.searchParams.getAll("contractAddresses[]"), [collection]);
    return json({ ownedNfts: [raw], pageKey: "next-page" });
  } });
  const responses = await Promise.all(Array.from({ length: 100 }, () => service.list({ owner })));
  assert.equal(calls, 1); assert.equal(responses[0].items[0].tokenId, "0"); assert.equal(responses[0].nextPage, "next-page");
  await service.list({ owner }); assert.equal(calls, 1);
  now = 31_000; await service.list({ owner }); assert.equal(calls, 2);
});
test("provider cannot inject unsupported collections or ERC1155 assets", async () => {
  const service = createNFTAssets({ ...options, fetchImpl: async () => json({ ownedNfts: [raw, { ...raw, tokenType: "ERC1155" }, { ...raw, contract: { address: owner } }] }) });
  assert.equal((await service.list({ owner })).items.length, 1);
});
test("token metadata is tied to exact collection and token ID", async () => {
  const service = createNFTAssets({ ...options, fetchImpl: async () => json({ ...raw, tokenId: "1" }) });
  await assert.rejects(service.token({ collection, tokenId: "0" }), /identity/);
});
test("NFT images cannot proxy metadata-provided internal URLs or SVG", async () => {
  for (const pngUrl of ["http://127.0.0.1/secret", "https://169.254.169.254/latest", "https://evil.example/x", "https://user@res.cloudinary.com/x"]) {
    let calls = 0;
    const service = createNFTAssets({ ...options, fetchImpl: async () => { calls++; return json({ ...raw, image: { pngUrl } }); } });
    await assert.rejects(service.image({ collection, tokenId: "0" }), /unsupported/); assert.equal(calls, 1);
  }
  const service = createNFTAssets({ ...options, fetchImpl: async url => url.hostname.includes("alchemy.com") ? json(raw) : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) });
  await assert.rejects(service.image({ collection, tokenId: "0" }), /unsupported/);
});
test("artwork fetch rejects redirects, HTML masked as PNG and oversized responses", async () => {
  let calls = 0;
  const service = createNFTAssets({ ...options, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, "error"); calls++;
    return url.hostname.includes("alchemy.com") ? json(raw) : new Response("<html>not a PNG</html>", { headers: { "content-type": "image/png" } });
  } });
  await assert.rejects(service.image({ collection, tokenId: "0" }), /invalid/); assert.equal(calls, 2);
  const large = createNFTAssets({ ...options, fetchImpl: async () => new Response("{}", { headers: { "content-length": "3000000" } }) });
  await assert.rejects(large.token({ collection, tokenId: "0" }), /too large/);
});
test("upstream failure is unavailable, not a false empty wallet", async () => {
  const service = createNFTAssets({ ...options, fetchImpl: async () => new Response("rate limited", { status: 429 }) });
  await assert.rejects(service.list({ owner }), /temporarily unavailable/);
});
test("collection pagination sends the returned token offset and rejects looping or malformed cursors", async () => {
  const service = createNFTAssets({ ...options, fetchImpl: async url => {
    assert.equal(url.pathname.endsWith("getNFTsForContract"), true);
    assert.equal(url.searchParams.get("limit"), "30");
    const next = url.searchParams.get("startToken");
    return json({ nfts: [{ ...raw, tokenId: next || "0" }], pageKey: next ? undefined : "30" });
  } });
  const first = await service.list({ collection });
  assert.equal(first.nextPage, "30");
  const second = await service.list({ collection, pageKey: first.nextPage });
  assert.equal(second.items[0].tokenId, "30"); assert.equal(second.nextPage, null);
  for (const pageKey of [{ next: 30 }, "30", "<bad>"]) {
    const malformed = createNFTAssets({ ...options, fetchImpl: async () => json({ nfts: [raw], pageKey }) });
    await assert.rejects(malformed.list({ collection, pageKey: "30" }), /cursor/);
  }
});
