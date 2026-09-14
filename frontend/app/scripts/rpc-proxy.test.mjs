import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

test("the production server isolates RPC reads from broken upstream CORS", async (t) => {
  const seen = [];
  let upstreamFailure = false;
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ headers: request.headers, body: JSON.parse(body) });
    if (upstreamFailure) {
      response.writeHead(429, { "Content-Type": "text/html" });
      response.end("Private upstream diagnostic");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ["*", "*"],
      "Set-Cookie": "upstream=must-not-be-forwarded",
    });
    const payload = JSON.parse(body);
    const answer = (rpc) => ({ jsonrpc: "2.0", id: rpc.id, result: "0x1237" });
    response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const server = spawn(process.execPath, ["scripts/serve-mvp.mjs"], {
    env: { ...process.env, PORT: String(port), DOCKYARD_RPC_URL: `http://127.0.0.1:${upstream.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill());
  await once(server.stdout, "data");
  const origin = `http://127.0.0.1:${port}`;
  const rpc = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
  const post = (body, extra = {}) => fetch(`${origin}/api/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extra },
    body: JSON.stringify(body), redirect: "manual",
  });
  const response = await post(rpc, { Cookie: "session=private", Authorization: "Bearer private" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, result: "0x1237" });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // The loan index also performs read-only warm-up requests. Identify the
  // browser request by its complete payload, independently of that traffic.
  const browserRead = seen.find(({ body }) => JSON.stringify(body) === JSON.stringify(rpc));
  assert.ok(browserRead, "the browser RPC was forwarded unchanged");
  assert.equal(browserRead.headers.origin, undefined);
  assert.equal(browserRead.headers.cookie, undefined);
  assert.equal(browserRead.headers.authorization, undefined);

  await t.test("rejects foreign origins, writes, oversized requests and invalid batches before forwarding", async () => {
    assert.equal((await post(rpc, { Origin: "https://unrelated.example" })).status, 403);
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "personal_sign", "debug_traceCall"]) {
      assert.equal((await post({ ...rpc, method })).status, 400);
    }
    assert.equal((await post([])).status, 400);
    assert.equal((await post([rpc, { ...rpc, method: "eth_sendRawTransaction" }])).status, 400);
    assert.equal((await post({ ...rpc, params: ["x".repeat(600_000)] })).status, 413);
    assert.equal((await fetch(`${origin}/api/rpc`, { redirect: "manual" })).status, 405);
    assert.equal(seen.filter(({ body }) => JSON.stringify(body) === JSON.stringify(rpc)).length, 1);
    assert.equal(seen.some(({ body }) => JSON.stringify(body).includes("eth_send") || JSON.stringify(body).includes("personal_sign")), false);
  });
  await t.test("preserves batch IDs and reports upstream outages without exposing diagnostics", async () => {
    const withoutParams = await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    assert.equal(withoutParams.status, 200, "Viem omits params for parameterless methods");
    const batch = await post([rpc, { ...rpc, id: "second" }]);
    assert.equal(batch.status, 200);
    assert.deepEqual((await batch.json()).map((item) => item.id), [1, "second"]);
    upstreamFailure = true;
    const failed = await post(rpc);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "RPC temporarily unavailable" });
  });
});
