import { pathToFileURL } from "node:url";
import { createPublicClient, http, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

type SourceRecord = {
  chainId?: string | number;
  address?: string;
  runtimeMatch?: string | null;
  creationMatch?: string | null;
  verifiedAt?: string;
  runtimeBytecode?: { onchainBytecode?: string };
  compilation?: { language?: string; compilerVersion?: string; fullyQualifiedName?: string };
  sources?: Record<string, { content?: string }>;
};

/** Cross-checks a verification provider's record against a pinned chain read.
 * This does not independently compile the sources or approve collateral safety. */
export function sourceSummary(record: SourceRecord, token: Address, code: Hex) {
  if (String(record.chainId) !== "4663" || record.address?.toLowerCase() !== token.toLowerCase()) {
    throw new Error("Verification record identity mismatch");
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("Missing or invalid chain bytecode");
  if (record.runtimeBytecode?.onchainBytecode?.toLowerCase() !== code.toLowerCase()) {
    throw new Error("Verification record does not match current chain bytecode");
  }
  if (!["match", "exact_match"].includes(record.runtimeMatch ?? "")) throw new Error("No provider runtime match");
  const sources = Object.entries(record.sources ?? {}).map(([path, source]) => {
    if (typeof source.content !== "string" || source.content.length === 0) throw new Error("Missing source content");
    return { path, keccak256: keccak256(stringToHex(source.content)), characters: source.content.length };
  });
  if (sources.length === 0) throw new Error("No sources supplied");
  return {
    chainId: 4663, token, runtimeCodeHash: keccak256(code), runtimeBytes: (code.length - 2) / 2,
    providerRuntimeMatch: record.runtimeMatch, providerCreationMatch: record.creationMatch ?? null,
    providerVerifiedAt: record.verifiedAt ?? null,
    compilation: record.compilation ?? null, sources,
    independentCompilationPerformed: false, behaviorReviewComplete: false, admission: "not-approved" as const,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--token" || !isAddress(args[1])) throw new Error("Invalid arguments");
  const token = args[1];
  const client = createPublicClient({ transport: http(process.env.COLLATERAL_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", { timeout: 15000, retryCount: 1 }) });
  if (await client.getChainId() !== 4663) throw new Error("Wrong chain");
  const block = await client.getBlock();
  const code = await client.getCode({ address: token, blockNumber: block.number });
  const sourceUrl = `https://sourcify.dev/server/v2/contract/4663/${token}?fields=all`;
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Verification provider unavailable");
  const summary = sourceSummary(await response.json() as SourceRecord, token, code ?? "0x");
  console.log(JSON.stringify({ ...summary, blockNumber: String(block.number), blockTimestamp: String(block.timestamp), sourceUrl }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Source cross-check failed. Check token identity, chain bytecode and verification-provider availability. No transaction was sent.");
    process.exitCode = 1;
  });
}
