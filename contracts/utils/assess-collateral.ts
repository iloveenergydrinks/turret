import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, isAddress, parseAbi, type Address } from "viem";

const BPS = 10_000n;
export type StressCase = {
  collateralUsd6: bigint;
  debtUsd6: bigint;
  priceDropBps: number;
  slippageBps: number;
  sellFeeBps: number;
  gasUsd6: bigint;
  incentiveBps: number;
};

// A deliberately simple full-collateral sale stress, not a quote, oracle, or
// model of the current vault's partial-liquidation implementation. Dollar units
// have six decimals. Round proceeds down and required incentive up.
export function stressCollateral(input: StressCase) {
  for (const key of ["collateralUsd6", "debtUsd6", "gasUsd6"] as const) {
    if (typeof input[key] !== "bigint" || input[key] < 0n) throw new Error(`Invalid ${key}`);
  }
  for (const key of ["priceDropBps", "slippageBps", "sellFeeBps", "incentiveBps"] as const) {
    if (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 10_000) {
      throw new Error(`Invalid ${key}`);
    }
  }
  const shockedValue = input.collateralUsd6 * (BPS - BigInt(input.priceDropBps)) / BPS;
  const afterSlippage = shockedValue * (BPS - BigInt(input.slippageBps)) / BPS;
  const saleProceeds = afterSlippage * (BPS - BigInt(input.sellFeeBps)) / BPS;
  const netProceeds = saleProceeds > input.gasUsd6 ? saleProceeds - input.gasUsd6 : 0n;
  const debtShortfall = input.debtUsd6 > netProceeds ? input.debtUsd6 - netProceeds : 0n;
  const requiredIncentive = (input.debtUsd6 * BigInt(input.incentiveBps) + BPS - 1n) / BPS;
  return {
    shockedValueUsd6: shockedValue,
    netSaleProceedsUsd6: netProceeds,
    debtShortfallUsd6: debtShortfall,
    proceedsAfterDebtAndIncentiveUsd6: netProceeds - input.debtUsd6 - requiredIncentive,
    // Even a positive result cannot prove that a sale can execute or an oracle
    // cannot be manipulated; those require independent evidence.
    admission: "not-approved" as const,
  };
}

export type Evidence = {
  canonicalIdentity?: boolean;
  tokenBehaviorReviewed?: boolean;
  independentPricingReviewed?: boolean;
  oracleManipulationSimulated?: boolean;
  stressedUsdExitExecutedOnFork?: boolean;
  liquidationKeeperVerified?: boolean;
  segregatedCapitalReviewed?: boolean;
  lenderAccountingReviewed?: boolean;
  deploymentParametersReviewed?: boolean;
};
const requiredEvidence: Array<keyof Evidence> = [
  "canonicalIdentity", "tokenBehaviorReviewed", "independentPricingReviewed", "oracleManipulationSimulated",
  "stressedUsdExitExecutedOnFork", "liquidationKeeperVerified", "segregatedCapitalReviewed",
  "lenderAccountingReviewed", "deploymentParametersReviewed",
];
export function missingEvidence(evidence: Evidence = {}) {
  return requiredEvidence.filter(key => evidence[key] !== true);
}

export type TokenProbe = { codeExists: boolean; decimals: number | null; oraclePaused: boolean | null };
export function currentVaultBlockers(probe: TokenProbe) {
  const blockers: string[] = [];
  if (!probe.codeExists) blockers.push("No token bytecode found");
  if (probe.decimals !== 18) blockers.push("Existing vault requires an 18-decimal token");
  if (probe.oraclePaused === null) blockers.push("Existing vault requires Robinhood oraclePaused(); generic ERC-20s are not drop-in collateral");
  if (probe.oraclePaused === true) blockers.push("Token oracle reports paused");
  return blockers;
}

const tokenAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function oraclePaused() view returns (bool)",
]);

const v3Abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

// Discovery aid only: a pool and its factory can both be counterfeit. Factory
// registration and observation history do not establish oracle safety or exit depth.
export async function inspectV3Pool(client: ReturnType<typeof createPublicClient>, token: Address, pool: Address, quote: Address) {
  if (await client.getChainId() !== 4663) throw new Error("Expected Robinhood Chain 4663");
  const block = await client.getBlock();
  const read = (functionName: "token0" | "token1" | "factory" | "fee" | "liquidity") =>
    client.readContract({ address: pool, abi: v3Abi, functionName, blockNumber: block.number });
  const [token0, token1, factory, fee, liquidity] = await Promise.all([
    read("token0"), read("token1"), read("factory"), read("fee"), read("liquidity"),
  ]);
  if (typeof token0 !== "string" || typeof token1 !== "string" || typeof factory !== "string"
    || typeof fee !== "number" || typeof liquidity !== "bigint") throw new Error("Invalid pool response");
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(token, quote) || !(same(token0, token) && same(token1, quote) || same(token1, token) && same(token0, quote))) {
    throw new Error("Pool does not contain requested collateral and quote");
  }
  let factoryRegistrationMatches: boolean | null = null;
  try {
    const registeredPool = await client.readContract({
      address: factory as Address,
      abi: parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]),
      functionName: "getPool", args: [token, quote, fee], blockNumber: block.number,
    });
    factoryRegistrationMatches = same(registeredPool, pool);
  } catch { /* Null means this factory could not be checked with the V3 ABI. */ }
  let observationHistory1800sAvailable = false;
  try {
    const observations = await client.readContract({ address: pool, abi: v3Abi, functionName: "observe", args: [[1800, 0]], blockNumber: block.number });
    observationHistory1800sAvailable = observations[0].length === 2 && observations[1].length === 2;
  } catch { /* Unavailable is not evidence of a safe TWAP. */ }
  return {
    chainId: 4663, blockNumber: block.number, blockTimestamp: block.timestamp,
    token, quote, pool, factory, feePips: fee, activeLiquidityRaw: liquidity,
    factoryRegistrationMatches, observationHistory1800sAvailable,
    admission: "not-approved" as const,
    unchecked: ["factory-and-pool-bytecode", "oracle-manipulation-cost", "executable-sale-depth", "token-transfer-behavior", "independent-pricing"],
  };
}

export async function inspectToken(client: ReturnType<typeof createPublicClient>, token: Address) {
  if (await client.getChainId() !== 4663) throw new Error("Expected Robinhood Chain 4663");
  const block = await client.getBlock();
  const code = await client.getCode({ address: token, blockNumber: block.number });
  const read = async (functionName: "symbol" | "decimals" | "oraclePaused") => {
    try { return await client.readContract({ address: token, abi: tokenAbi, functionName, blockNumber: block.number }); }
    catch { return null; }
  };
  const [symbol, decimals, oraclePaused] = await Promise.all([read("symbol"), read("decimals"), read("oraclePaused")]);
  const probe = {
    codeExists: Boolean(code && code !== "0x"),
    decimals: typeof decimals === "number" ? decimals : null,
    oraclePaused: typeof oraclePaused === "boolean" ? oraclePaused : null,
  };
  return {
    chainId: 4663, blockNumber: block.number, blockTimestamp: block.timestamp, token,
    symbol: typeof symbol === "string" ? symbol.slice(0, 64) : null,
    ...probe, existingVaultBlockers: currentVaultBlockers(probe),
    admission: "not-approved",
    unchecked: missingEvidence(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if ((args.length === 2 || args.length === 6) && args[0] === "--token" && isAddress(args[1])) {
    const client = createPublicClient({ transport: http(process.env.COLLATERAL_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com", { timeout: 10000, retryCount: 1 }) });
    let result;
    if (args.length === 2) result = await inspectToken(client, args[1]);
    else if (args[2] === "--pool" && isAddress(args[3]) && args[4] === "--quote" && isAddress(args[5])) {
      result = await inspectV3Pool(client, args[1], args[3], args[5]);
    } else throw new Error("Invalid pool arguments");
    console.log(JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    return;
  }
  if (args.length) throw new Error("Usage: assess-collateral.ts [--token 0x... [--pool 0x... --quote 0x...]]");
  const registry = JSON.parse(await readFile(new URL("./collateral-candidates.json", import.meta.url), "utf8"));
  console.log(JSON.stringify({
    mode: "research-only", candidates: registry.candidates.map((candidate: { name: string; token: string | null; evidence: Evidence }) => ({ name: candidate.name, token: candidate.token, missingEvidence: missingEvidence(candidate.evidence), admission: "not-approved" })),
  }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Collateral inspection failed. Check arguments, chain and RPC connectivity. No transaction was sent."); process.exitCode = 1; });
}
