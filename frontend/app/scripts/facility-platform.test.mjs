import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFacilityPlatform } from "./facility-platform.mjs";
import { ZERO_HASH } from "../src/facilities/quotes.mjs";

const address = n => `0x${String(n).padStart(40, "0")}`;
const entry = { chainId: 31337, address: address(1), lender: address(2), loanToken: address(3), collateralToken: address(4), feeRecipient: address(5),
  startBlock: "1", feeBps: "1000", vaultImplementation: address(6), runtimeHash: ZERO_HASH, vaultImplementationHash: ZERO_HASH };
const baseline = { schemaVersion: 1, chainId: 31337, blockNumber: "1", blockHash: ZERO_HASH,
  tokens: [3, 4].map(n => ({ address: address(n), runtimeHash: ZERO_HASH, implementationSlot: ZERO_HASH, beaconSlot: ZERO_HASH, decimals: n === 3 ? 6 : 18, checks: [] })) };
const config = { schemaVersion: 1, entries: [entry], baseline };
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "facility-platform-"));
  let platform;
  const server = createServer((req, res) => void platform(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  platform = createFacilityPlatform({ config, origin, databasePath: join(directory, "quotes.sqlite"), client: {}, ...overrides });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); platform.close(); await rm(directory, { recursive: true, force: true }); });
  return { origin };
}
test("empty release registry explicitly disables the API and leaves other routes alone", async t => {
  const { origin } = await fixture(t, { config: { schemaVersion: 1, entries: [], baseline: null }, databasePath: undefined });
  const result = await fetch(`${origin}/api/facility-quotes`);
  assert.equal(result.status, 503); assert.match((await result.json()).error, /not active/);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${origin}/borrow/p2p`)).status, 404);
});
test("active release requires a durable absolute path and rejects local chains at public origins", () => {
  assert.throws(() => createFacilityPlatform({ config, origin: "http://127.0.0.1", client: {} }));
  assert.throws(() => createFacilityPlatform({ config, origin: "https://turret.capital", databasePath: "/tmp/unused.sqlite", client: {} }), /network/);
  assert.throws(() => createFacilityPlatform({ config: { ...config, entries: [{ ...entry, runtimeHash: "invalid" }] }, origin: "http://127.0.0.1", client: {} }), /identity/);
});
test("incomplete bodies time out and an aborted request does not crash later requests", async t => {
  const { origin } = await fixture(t, { bodyTimeoutMs: 50 });
  const options = { method: "POST", headers: { origin, "content-type": "application/json", "content-length": "100" } };
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/api/facility-quotes`, options, res => { res.resume(); res.once("end", () => { resolve(res.statusCode); req.destroy(); }); });
    req.on("error", reject); req.write("{");
  });
  assert.equal(status, 408);
  await new Promise(resolve => {
    const req = httpRequest(`${origin}/api/facility-quotes`, options);
    req.on("error", () => resolve()); req.write("{"); setTimeout(() => req.destroy(new Error("test interrupted body")), 10);
  });
  const response = await fetch(`${origin}/api/facility-quotes`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{" });
  assert.equal(response.status, 400);
});
