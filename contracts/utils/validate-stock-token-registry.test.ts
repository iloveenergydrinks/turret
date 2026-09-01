import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest, validateRegistry } from "./validate-stock-token-registry";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}`;

function fixture(count = 10) {
  const manifest = Array.from({ length: count }, (_, index) => ({
    symbol: `TEST${index}`,
    token: address(index * 3 + 1),
    primaryFeed: address(index * 3 + 2),
    secondaryFeed: address(index * 3 + 3),
  }));
  const assets = manifest.map((entry) => ({
    tokenSymbol: entry.symbol,
    status: "ASSET_STATUS_ACTIVE",
    pendingMultiplier: "",
    deployments: [{ chainId: 4663, contractAddress: entry.token }],
  }));
  const feeds = manifest.map((entry) => ({
    name: `Robinhood ${entry.symbol} / USD`,
    proxyAddress: entry.primaryFeed,
    secondaryProxyAddress: entry.secondaryFeed,
    heartbeat: 86_400,
    threshold: 0.5,
    decimals: 8,
  }));
  return { manifest, assets, feeds };
}

test("parses token and both oracle addresses from the Solidity manifest", () => {
  const entries = parseManifest(`configs[0] = _config(
    "AAPL",
    0x0000000000000000000000000000000000000001,
    0x0000000000000000000000000000000000000002,
    0x0000000000000000000000000000000000000003,
    175
  );`);
  assert.deepEqual(entries, [{
    symbol: "AAPL",
    token: address(1),
    primaryFeed: address(2),
    secondaryFeed: address(3),
  }]);
});

test("accepts a complete registry match", () => {
  const { manifest, assets, feeds } = fixture();
  assert.deepEqual(validateRegistry(manifest, assets, feeds), []);
});

test("fails closed on inactive assets, pending multipliers, and feed drift", () => {
  const { manifest, assets, feeds } = fixture();
  assets[0].status = "ASSET_STATUS_INACTIVE";
  assets[1].pendingMultiplier = "2.0";
  feeds[2].proxyAddress = address(999);
  feeds[3].heartbeat = 3_600;
  feeds[4].decimals = 18;

  const errors = validateRegistry(manifest, assets, feeds);
  assert.ok(errors.some((error) => error.includes("TEST0: Robinhood asset is not active")));
  assert.ok(errors.some((error) => error.includes("TEST1: Robinhood asset has a pending multiplier")));
  assert.ok(errors.some((error) => error.includes("TEST2: primary feed differs")));
  assert.ok(errors.some((error) => error.includes("TEST3: expected 86400s heartbeat")));
  assert.ok(errors.some((error) => error.includes("TEST4: expected 8 feed decimals")));
});
