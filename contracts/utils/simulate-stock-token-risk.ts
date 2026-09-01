import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type RiskConfig = {
  symbol: string;
  mcrBps: number;
  maxOracleDeviationBps: number;
};

export type RiskScenario = {
  schemaVersion: 1;
  label: string;
  trials: number;
  seed: number;
  startingBufferBps: number;
  liquidationPenaltyBps: number;
  jumpProbabilityBps: number;
  jumpVolatilityBps: number;
  dailyDriftBps: number;
  dailyVolatilityBps: Record<string, number>;
};

export type GapClassification = {
  collateralRatioBps: number;
  liquidatable: boolean;
  confirmationRequired: boolean;
  penaltyShortfall: boolean;
};

export type SimulationResult = RiskConfig & {
  trials: number;
  liquidationCount: number;
  delayedLiquidationCount: number;
  penaltyShortfallCount: number;
  liquidationRateBps: number;
  delayedLiquidationRateBps: number;
  penaltyShortfallRateBps: number;
  worstCollateralRatioBps: number;
};

const BPS = 10_000;

export function parseRiskManifest(source: string): RiskConfig[] {
  const configs: RiskConfig[] = [];
  const configPattern =
    /_config\(\s*"([A-Z]+)"\s*,\s*0x[0-9a-fA-F]{40}\s*,\s*0x[0-9a-fA-F]{40}\s*,\s*0x[0-9a-fA-F]{40}\s*,\s*([\d_]+)\s*,\s*[\d_]+\s*,\s*[\d_]+\s*,\s*[\d_]+\s*,\s*([\d_]+)\s*\)/g;

  for (const match of source.matchAll(configPattern)) {
    configs.push({
      symbol: match[1],
      mcrBps: Number(match[2].replace(/_/g, "")) * 100,
      maxOracleDeviationBps: Number(match[3].replace(/_/g, "")),
    });
  }
  return configs;
}

export function classifyGap(
  config: RiskConfig,
  scenario: Pick<RiskScenario, "startingBufferBps" | "liquidationPenaltyBps">,
  returnBps: number,
): GapClassification {
  const startingCollateralRatioBps = config.mcrBps + scenario.startingBufferBps;
  const collateralRatioBps = Math.max(0, Math.floor(startingCollateralRatioBps * (BPS + returnBps) / BPS));
  const liquidatable = collateralRatioBps < config.mcrBps;
  return {
    collateralRatioBps,
    liquidatable,
    confirmationRequired: liquidatable && Math.abs(returnBps) > config.maxOracleDeviationBps,
    penaltyShortfall: collateralRatioBps < BPS + scenario.liquidationPenaltyBps,
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function normal(random: () => number): number {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function symbolSeed(seed: number, symbol: string): number {
  let result = seed >>> 0;
  for (const character of symbol) result = Math.imul(result ^ character.charCodeAt(0), 16_777_619);
  return result >>> 0;
}

export function simulateBranch(config: RiskConfig, scenario: RiskScenario): SimulationResult {
  const volatility = scenario.dailyVolatilityBps[config.symbol];
  if (!Number.isFinite(volatility)) throw new Error(`missing daily volatility for ${config.symbol}`);
  if (!Number.isInteger(scenario.trials) || scenario.trials <= 0) throw new Error("trials must be a positive integer");

  const random = seededRandom(symbolSeed(scenario.seed, config.symbol));
  let liquidations = 0;
  let delayedLiquidations = 0;
  let penaltyShortfalls = 0;
  let worstCollateralRatioBps = Number.POSITIVE_INFINITY;

  for (let trial = 0; trial < scenario.trials; ++trial) {
    let returnBps = scenario.dailyDriftBps + normal(random) * volatility;
    if (random() * BPS < scenario.jumpProbabilityBps) {
      returnBps += normal(random) * scenario.jumpVolatilityBps;
    }
    returnBps = Math.max(-9_900, Math.min(BPS, Math.round(returnBps)));

    const outcome = classifyGap(config, scenario, returnBps);
    if (outcome.liquidatable) liquidations++;
    if (outcome.confirmationRequired) delayedLiquidations++;
    if (outcome.penaltyShortfall) penaltyShortfalls++;
    worstCollateralRatioBps = Math.min(worstCollateralRatioBps, outcome.collateralRatioBps);
  }

  const rate = (count: number) => Math.round(count * BPS / scenario.trials);
  return {
    ...config,
    trials: scenario.trials,
    liquidationCount: liquidations,
    delayedLiquidationCount: delayedLiquidations,
    penaltyShortfallCount: penaltyShortfalls,
    liquidationRateBps: rate(liquidations),
    delayedLiquidationRateBps: rate(delayedLiquidations),
    penaltyShortfallRateBps: rate(penaltyShortfalls),
    worstCollateralRatioBps,
  };
}

export function runSimulation(configs: RiskConfig[], scenario: RiskScenario): SimulationResult[] {
  if (scenario.schemaVersion !== 1) throw new Error(`unsupported scenario schema: ${scenario.schemaVersion}`);
  if (configs.length !== 10) throw new Error(`expected 10 Stock Token branches, found ${configs.length}`);
  return configs.map((config) => simulateBranch(config, scenario));
}

function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function occurrence(count: number, trials: number): string {
  return `${(count * 100 / trials).toFixed(4)}% (${count})`;
}

export async function main(): Promise<void> {
  const manifestSource = await readFile(resolve(__dirname, "../src/StockTokens/StockTokenConfig.sol"), "utf8");
  const scenario = JSON.parse(
    await readFile(resolve(__dirname, "stock-risk-scenario.sandcastle.json"), "utf8"),
  ) as RiskScenario;
  const results = runSimulation(parseRiskManifest(manifestSource), scenario);

  console.log(scenario.label);
  console.log(`trials=${scenario.trials} seed=${scenario.seed} start_buffer=${percent(scenario.startingBufferBps)}`);
  console.table(results.map((result) => ({
    symbol: result.symbol,
    MCR: percent(result.mcrBps),
    cutoff: percent(result.maxOracleDeviationBps),
    liquidated: occurrence(result.liquidationCount, result.trials),
    delayed: occurrence(result.delayedLiquidationCount, result.trials),
    shortfall: occurrence(result.penaltyShortfallCount, result.trials),
    worst_CR: percent(result.worstCollateralRatioBps),
  })));
  console.log("Synthetic screening only. Do not use these results as production calibration or historical evidence.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
