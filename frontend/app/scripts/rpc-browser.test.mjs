// Run against a Robinhood Chain Next export. The synthetic wallet cannot sign;
// all chain data comes from a local RPC that deliberately has invalid CORS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("connected portfolio and wallet menu use same-origin RPC without ENS fallback", { timeout: 60_000 }, async (t) => {
  const app = process.env.DOCKYARD_STATIC_APP;
  const runtimePath = process.env.DOCKYARD_PLAYWRIGHT_MODULE;
  assert.ok(app && runtimePath, "Set DOCKYARD_STATIC_APP and DOCKYARD_PLAYWRIGHT_MODULE");
  const requests = [];
  const upstream = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", ["*", "*"]);
    response.setHeader("Access-Control-Allow-Methods", "POST");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    if (request.method === "OPTIONS") return response.writeHead(204).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const answer = (rpc) => {
      requests.push(rpc.method);
      const result = {
        eth_chainId: "0x1237", eth_blockNumber: "0x1234", eth_getCode: "0x", eth_getBalance: "0x0",
        eth_getBlockByNumber: {
          number: "0x1234", hash: `0x${"12".repeat(32)}`, parentHash: `0x${"11".repeat(32)}`,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, transactions: [], uncles: [],
          gasLimit: "0x1c9c380", gasUsed: "0x0", difficulty: "0x0", size: "0x100", baseFeePerGas: "0x1",
        },
      }[rpc.method];
      return { jsonrpc: "2.0", id: rpc.id, ...(result === undefined
        ? { error: { code: -32601, message: "No fixture data" } } : { result }) };
    };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const server = spawn(process.execPath, [resolve(app, "scripts/serve-mvp.mjs")], {
    env: { PATH: process.env.PATH, PORT: String(port), DOCKYARD_RPC_URL: upstreamUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  await once(server.stdout, "data");
  const runtime = await import(pathToFileURL(runtimePath).href);
  const browser = await (runtime.default ?? runtime).chromium.launch({ headless: true, channel: "chrome" });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext();
  const external = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if ([origin, upstreamUrl].includes(url.origin)) return route.continue();
    external.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.ethereum = {
      isMetaMask: true,
      on() {}, removeListener() {},
      async request({ method }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return ["0x000000000000000000000000000000000000dEaD"];
        if (method === "eth_chainId") return "0x1237";
        throw new Error(`Synthetic read-only wallet rejected ${method}`);
      },
    };
  });
  await page.goto(`${origin}/portfolio`);
  await page.getByRole("heading", { name: "Your Dockyard positions" }).waitFor();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: /MetaMask|Browser Wallet|Injected/ }).click().catch(async (error) => {
    throw new Error(`${error.message}\n${await page.locator("body").innerText()}`);
  });
  const account = page.getByRole("button", { name: /Open wallet menu for/ });
  await account.waitFor();
  await page.getByRole("heading", { name: /Some positions could not be loaded|No positions yet/ }).waitFor();
  await account.click();
  await page.getByText("Disconnect", { exact: true }).waitFor();
  // Include a reload: a reconnected wallet must not restart ENS polling.
  await page.reload();
  await account.waitFor();
  await page.getByRole("heading", { name: /Some positions could not be loaded|No positions yet/ }).waitFor();
  assert.deepEqual(external.filter((url) => /merkle|rpc\.mainnet/.test(url)), []);
  assert.ok(requests.includes("eth_getCode"), `Portfolio must read contracts through the production proxy: ${requests}`);
  assert.deepEqual(errors, []);

  const cors = await page.evaluate(async ({ upstreamUrl }) => {
    const options = { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) };
    let blocked = false;
    try { await fetch(upstreamUrl, options); } catch { blocked = true; }
    const proxied = await fetch("/api/rpc", options).then((response) => response.json());
    return { blocked, result: proxied.result };
  }, { upstreamUrl });
  assert.deepEqual(cors, { blocked: true, result: "0x1237" });
});
