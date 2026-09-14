import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as reservePort } from "node:net";
import { readFile, writeFile, mkdir, mkdtemp, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, keccak256 } from "viem";
import { foundry } from "viem/chains";
import { captureTokenBaseline } from "../../src/p2p/health-core.mjs";
import { createFacilityPlatform } from "../facility-platform.mjs";

// Dedicated disposable chain, never a fork or an external RPC. No private key is read.
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const output = join(root, "output/memecoin-switch-20260912/facility-browser");
await mkdir(output, { recursive: true });
const run = await mkdtemp(join(output, "run-"));
const freePort = async () => { const server = reservePort(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const rpcPort = await freePort(), uiPort = await freePort(), origin = `http://127.0.0.1:${uiPort}`, rpcUrl = `http://127.0.0.1:${rpcPort}`;
const anvil = spawn(join(homedir(), ".foundry/bin/anvil"), ["--host", "127.0.0.1", "--port", String(rpcPort), "--chain-id", "31337", "--block-time", "1", "--silent"], { stdio: "ignore" });
let server, platform, vite, stopping = false;
const stop = async () => { if (stopping) return; stopping = true; vite?.kill("SIGTERM"); anvil.kill("SIGTERM"); if (server) { server.closeAllConnections(); server.close(); } platform?.close(); };
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
try {
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl, { retryCount: 0 }), pollingInterval: 100 });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = await client.getChainId() === 31337; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 40)); }
  if (!ready || !/anvil/i.test(await client.request({ method: "web3_clientVersion" }))) throw new Error("Dedicated Anvil did not start.");
  const [lender, borrower, fees] = await createWalletClient({ transport: http(rpcUrl), chain: foundry }).getAddresses();
  const wallet = account => createWalletClient({ account, chain: foundry, transport: http(rpcUrl), pollingInterval: 100 });
  const receipt = async hash => { const value = await client.waitForTransactionReceipt({ hash }); if (value.status !== "success") throw new Error("Local fixture transaction failed."); return value; };
  const artifact = async (file, name = file) => JSON.parse(await readFile(join(root, `contracts/p2p/out/${file}.sol/${name}.json`), "utf8"));
  const [token, facility] = await Promise.all([artifact("V3TestSupport", "V3TestToken"), artifact("TurretLenderFacility")]);
  const deploy = async (art, args) => (await receipt(await wallet(lender).deployContract({ abi: art.abi, bytecode: art.bytecode.object, args }))).contractAddress;
  const loanToken = await deploy(token, ["TEST USDG", 6]), collateralToken = await deploy(token, ["TEST MEME", 18]);
  const limits = { maxExposure: 1000_000000n, minDraw: 1_000000n, maxDraw: 300_000000n, minDuration: 86400n, maxDuration: 2592000n, maxQuoteLifetime: 3600n, minCollateralPerPrincipalWad: 10n ** 30n, minInterestBps: 100n };
  const address = await deploy(facility, [loanToken, collateralToken, lender, fees, 1000n, limits]);
  const write = (address, functionName, args) => wallet(lender).writeContract({ address, abi: token.abi, functionName, args }).then(receipt);
  await write(loanToken, "mint", [lender, 1000_000000n]);
  await write(loanToken, "mint", [borrower, 10_000000n]);
  await write(collateralToken, "mint", [borrower, 2000n * 10n ** 18n]);
  const block = await client.getBlock(), vaultImplementation = await client.readContract({ address, abi: facility.abi, functionName: "vaultImplementation" });
  const baseline = { schemaVersion: 1, chainId: 31337, blockNumber: String(block.number), blockHash: block.hash,
    tokens: await Promise.all([loanToken, collateralToken].map(a => captureTokenBaseline(client, a, block, address))) };
  const entry = { chainId: 31337, address, lender, loanToken, collateralToken, feeRecipient: fees, feeBps: "1000", vaultImplementation,
    runtimeHash: keccak256(await client.getCode({ address })), vaultImplementationHash: keccak256(await client.getCode({ address: vaultImplementation })),
    collateralSymbol: "TESTMEME", collateralDecimals: 18, loanDecimals: 6, startBlock: String(block.number) };
  const config = { schemaVersion: 1, entries: [entry], baseline };
  const fixture = { config, accounts: { lender, borrower, fees }, origin, rpcUrl, runDirectory: run };
  const reads = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_call", "eth_estimateGas", "eth_getTransactionCount", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]);
  const writes = new Set(["eth_sendTransaction", "eth_signTypedData_v4"]);
  server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (await platform(req, res)) return;
      if (req.method === "GET" && req.url === "/test-fixture") return send(200, fixture);
      if (req.method === "GET" && req.url === "/facility-markets.json") return send(200, config);
      if (req.method !== "POST" || !["/api/rpc", "/test-wallet-rpc"].includes(req.url)) return send(404, { error: "Local test route not found." });
      const signing = req.url === "/test-wallet-rpc";
      if (signing && req.headers.origin !== origin) return send(403, { error: "Test wallet requests require the local browser origin." });
      const chunks = []; let bytes = 0;
      for await (const part of req) { bytes += part.length; if (bytes > 65536) return send(413, { error: "Test request too large." }); chunks.push(part); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), calls = Array.isArray(body) ? body : [body];
      if (calls.length > 50 || calls.some(call => !(signing ? writes : reads).has(call.method))) return send(400, { error: "Unsupported local RPC method." });
      if (signing && calls.some(call => ![lender, borrower].some(account => account.toLowerCase() === String(call.method === "eth_sendTransaction" ? call.params?.[0]?.from : call.params?.[0]).toLowerCase()))) return send(403, { error: "Unknown test wallet." });
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (signing) await appendFile(join(run, "wallet-events.jsonl"), JSON.stringify({ at: new Date().toISOString(), calls, result }) + "\n");
      send(response.status, result);
    } catch (error) { if (!res.headersSent) send(500, { error: error.message }); else res.end(); }
  });
  platform = createFacilityPlatform({ config, client, origin, databasePath: join(run, "facility.sqlite") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const backend = `http://127.0.0.1:${server.address().port}`;
  const require = createRequire(import.meta.url), vitePackage = createRequire(require.resolve("vitest/package.json")).resolve("vite/package.json");
  vite = spawn(process.execPath, [join(dirname(vitePackage), "bin/vite.js"), "--config", fileURLToPath(new URL("vite.config.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, FACILITY_BROWSER_BACKEND: backend, FACILITY_BROWSER_PORT: String(uiPort) }, stdio: "inherit" });
  vite.once("exit", () => void stop());
  await writeFile(join(run, "fixture.json"), JSON.stringify(fixture, null, 2) + "\n");
  await writeFile(join(output, "current.json"), JSON.stringify({ runDirectory: run, origin, rpcUrl, pid: process.pid, anvilPid: anvil.pid, vitePid: vite.pid }, null, 2) + "\n");
  console.log(`Local chain browser fixture: ${origin}\nEvidence: ${run}`);
} catch (error) { await stop(); throw error; }
