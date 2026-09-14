import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNFTPlatform } from "./nft-platform.mjs";
const config = { version: 1, chainId: 4663, address: `0x${"11".repeat(20)}`, loanToken: `0x${"22".repeat(20)}`, loanDecimals: 6,
  runtimeHash: `0x${"33".repeat(32)}`, startBlock: "1", rpcUrl: "/api/rpc", collections: [{ address: `0x${"44".repeat(20)}`, enabled: true, name: "Cats" }] };
test("absent deployment leaves existing production routes untouched", async () => {
  assert.equal(await createNFTPlatform({ config: null })({}, {}), false);
});
test("server composition serves the NFT board with a separate persistence directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nft-platform-"));
  try {
    const handler = createNFTPlatform({ config, client: {}, origin: "https://turret.capital", directory, rpcUrls: [] });
    let status, body;
    const response = { writeHead: code => { status = code; }, end: value => { body = value; } };
    assert.equal(await handler({ method: "GET", url: "/api/p2p/nft/requests", headers: {} }, response), true);
    assert.equal(status, 200); assert.deepEqual(JSON.parse(body).requests, []);
    assert.equal(await handler({ method: "GET", url: "/api/p2p/requests", headers: {} }, response), false);
    await handler({ method: "GET", url: `/api/p2p/nft/assets?collection=${config.collections[0].address}`, headers: {} }, response);
    assert.equal(status, 503); assert.match(JSON.parse(body).error, /not configured/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("invalid launch config fails startup instead of serving a different chain or NFT identity", () => {
  const options = { config, client: {}, origin: "https://turret.capital", directory: "/tmp/test", rpcUrls: [] };
  for (const change of [{ chainId: 1 }, { loanDecimals: 18 }, { collections: [...config.collections, ...config.collections] }, { runtimeHash: "0x" }]) {
    assert.throws(() => createNFTPlatform({ ...options, config: { ...config, ...change } }), /Invalid NFT release/);
  }
});
