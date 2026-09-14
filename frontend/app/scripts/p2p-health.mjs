import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { captureTokenBaseline, inspectP2PHealth } from "../src/p2p/health-core.mjs";

export async function captureP2PBaseline(client, markets) {
  const chainId = await client.getChainId();
  if (markets.some(market => market.chainId !== chainId)) throw new Error("Wrong chain");
  const block = await client.getBlock();
  const tokens = new Map();
  for (const market of markets) {
    for (const address of [market.loanToken, market.collateralToken]) {
      if (!tokens.has(address.toLowerCase())) tokens.set(address.toLowerCase(), await captureTokenBaseline(client, address, block, market.address));
    }
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Chain changed");
  return { schemaVersion: 1, chainId, blockNumber: String(block.number), blockHash: block.hash, capturedAt: new Date().toISOString(),
    qualification: "Observed transfer/code baseline; exact source and administrator assessment is incomplete. Not an external audit.", tokens: [...tokens.values()] };
}

export async function monitorP2P(client, markets, baseline) {
  const chainId = await client.getChainId();
  if (markets.some(market => market.chainId !== chainId)) throw new Error("Wrong chain");
  const block = await client.getBlock();
  const results = [];
  // Sequential markets bound upstream load; token observations are shared at this block.
  for (const market of markets) results.push({ market: market.address, symbol: market.collateralSymbol,
    ...await inspectP2PHealth(client, market, baseline, block, chainId === 31337 ? Number(block.timestamp) * 1000 : Date.now()) });
  return { chainId, publicTransactions: 0, checkedAt: new Date().toISOString(), markets: results,
    healthy: results.every(result => result.status === "ok") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
    const registry = JSON.parse(await readFile(value("--registry") || new URL("../public/p2p-markets.json", import.meta.url)));
    // Optional operator-supplied local read-only transport; never exposed through HTTP.
    const client = value("--rpc-module") ? (await (await import(pathToFileURL(value("--rpc-module")))).readOnlyClient()).client
      : createPublicClient({ transport: http(process.env.DOCKYARD_RPC_URL || process.env.NEXT_PUBLIC_CHAIN_RPC_URL || "https://rpc.mainnet.chain.robinhood.com/", { retryCount: 1, timeout: 15000 }) });
    if (value("--capture")) {
      const baseline = await captureP2PBaseline(client, registry.markets);
      await writeFile(value("--capture"), JSON.stringify(baseline, null, 2) + "\n", { flag: "wx" });
      console.log(JSON.stringify({ candidateWritten: true, tokens: baseline.tokens.length, blockNumber: baseline.blockNumber, publicTransactions: 0 }));
    } else {
      const baseline = JSON.parse(await readFile(value("--baseline") || new URL("../public/p2p-token-baseline.json", import.meta.url)));
      const result = await monitorP2P(client, registry.markets, baseline);
      const encoded = JSON.stringify(result, null, 2) + "\n";
      if (value("--output")) await writeFile(value("--output"), encoded);
      console.log(encoded);
      if (!result.healthy) process.exitCode = 2;
    }
  } catch { console.error("P2P monitoring could not complete. No transactions were sent; upstream details are suppressed."); process.exitCode = 1; }
}
