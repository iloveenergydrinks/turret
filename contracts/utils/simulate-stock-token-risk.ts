import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type RiskConfig = {
  symbol: string;
  mcrBps: number;
  maxOracleDeviationBps: number;
};

export type RiskScenario = {
  schemaVersion: 3;
  label: string;
  trials: number;
  seed: number;
  startingBufferBps: number;
  liquidationPenaltyBps: number;
  jumpProbabilityBps: number;
  jumpVolatilityBps: number;
  dailyDriftBps: number;
  dailyVolatilityBps: Record<string, number>;
  confirmationDeviationBps: number;
  confirmationWindowVolatilityBps: Record<string, number>;
  confirmationWindowJumpProbabilityBps: number;
  confirmationWindowJumpVolatilityBps: number;
  maxConfirmationWindows: number;
};

export type GapClassification = {
  collateralRatioBps: number;
  liquidatable: boolean;
  confirmationRequired: boolean;
  penaltyShortfall: boolean;
};

export type ConfirmationWindowClassification = {
  combinedReturnBps: number;
  collateralRatioBps: number;
  confirmationRestarts: boolean;
  confirmed: boolean;
  recoveredWithoutConfirmation: boolean;
  penaltyShortfallDuringDelay: boolean;
};

export type ConfirmationPathClassification = {
  resolution: "not-required" | "confirmed" | "recovered" | "unresolved";
  windowsUsed: number;
  restartCount: number;
  penaltyShortfallDuringDelay: boolean;
  worstCollateralRatioBps: number;
};

export type SimulationResult = RiskConfig & {
  trials: number;
  liquidationCount: number;
  delayedLiquidationCount: number;
  penaltyShortfallCount: number;
  confirmationRestartCount: number;
  confirmationRecoveryCount: number;
  confirmationShortfallCount: number;
  unresolvedConfirmationCount: number;
  averageConfirmationWindows: number;
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
    confirmationRequired: Math.abs(returnBps) > config.maxOracleDeviationBps,
    penaltyShortfall: collateralRatioBps < BPS + scenario.liquidationPenaltyBps,
  };
}

export function classifyConfirmationWindow(
  config: RiskConfig,
  scenario: Pick<
    RiskScenario,
    "startingBufferBps" | "liquidationPenaltyBps" | "confirmationDeviationBps"
  >,
  initialReturnBps: number,
  confirmationWindowReturnBps: number,
): ConfirmationWindowClassification {
  const initial = classifyGap(config, scenario, initialReturnBps);
  const combinedPriceBps = Math.max(
    0,
    Math.floor((BPS + initialReturnBps) * (BPS + confirmationWindowReturnBps) / BPS),
  );
  const combinedReturnBps = combinedPriceBps - BPS;
  const afterWindow = classifyGap(config, scenario, combinedReturnBps);
  const recoveredWithoutConfirmation = initial.confirmationRequired
    && Math.abs(combinedReturnBps) <= config.maxOracleDeviationBps;
  const confirmationRestarts = initial.confirmationRequired
    && !recoveredWithoutConfirmation
    && Math.abs(confirmationWindowReturnBps) > scenario.confirmationDeviationBps;

  return {
    combinedReturnBps,
    collateralRatioBps: afterWindow.collateralRatioBps,
    confirmationRestarts,
    confirmed: initial.confirmationRequired && !recoveredWithoutConfirmation && !confirmationRestarts,
    recoveredWithoutConfirmation,
    penaltyShortfallDuringDelay: initial.confirmationRequired
      && (initial.penaltyShortfall || afterWindow.penaltyShortfall),
  };
}

export function classifyConfirmationPath(
  config: RiskConfig,
  scenario: Pick<
    RiskScenario,
    "startingBufferBps" | "liquidationPenaltyBps" | "confirmationDeviationBps"
  >,
  initialReturnBps: number,
  confirmationWindowReturnsBps: number[],
): ConfirmationPathClassification {
  const initial = classifyGap(config, scenario, initialReturnBps);
  if (!initial.confirmationRequired) {
    return {
      resolution: "not-required",
      windowsUsed: 0,
      restartCount: 0,
      penaltyShortfallDuringDelay: false,
      worstCollateralRatioBps: initial.collateralRatioBps,
    };
  }

  let candidateReturnBps = initialReturnBps;
  let restartCount = 0;
  let penaltyShortfallDuringDelay = initial.penaltyShortfall;
  let worstCollateralRatioBps = initial.collateralRatioBps;

  for (let index = 0; index < confirmationWindowReturnsBps.length; ++index) {
    const window = classifyConfirmationWindow(
      config,
      scenario,
      candidateReturnBps,
      confirmationWindowReturnsBps[index],
    );
    penaltyShortfallDuringDelay = penaltyShortfallDuringDelay || window.penaltyShortfallDuringDelay;
    worstCollateralRatioBps = Math.min(worstCollateralRatioBps, window.collateralRatioBps);

    if (window.recoveredWithoutConfirmation) {
      return {
        resolution: "recovered",
        windowsUsed: index + 1,
        restartCount,
        penaltyShortfallDuringDelay,
        worstCollateralRatioBps,
      };
    }
    if (window.confirmationRestarts) {
      restartCount++;
      candidateReturnBps = window.combinedReturnBps;
      continue;
    }
    return {
      resolution: "confirmed",
      windowsUsed: index + 1,
      restartCount,
      penaltyShortfallDuringDelay,
      worstCollateralRatioBps,
    };
  }

  return {
    resolution: "unresolved",
    windowsUsed: confirmationWindowReturnsBps.length,
    restartCount,
    penaltyShortfallDuringDelay,
    worstCollateralRatioBps,
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
  const confirmationWindowVolatility = scenario.confirmationWindowVolatilityBps[config.symbol];
  if (!Number.isFinite(volatility)) throw new Error(`missing daily volatility for ${config.symbol}`);
  if (!Number.isFinite(confirmationWindowVolatility)) {
    throw new Error(`missing confirmation-window volatility for ${config.symbol}`);
  }
  if (
    !Number.isFinite(scenario.confirmationWindowJumpProbabilityBps)
    || !Number.isFinite(scenario.confirmationWindowJumpVolatilityBps)
  ) {
    throw new Error("missing confirmation-window jump assumptions");
  }
  if (!Number.isInteger(scenario.maxConfirmationWindows) || scenario.maxConfirmationWindows <= 0) {
    throw new Error("maxConfirmationWindows must be a positive integer");
  }
  if (!Number.isInteger(scenario.trials) || scenario.trials <= 0) throw new Error("trials must be a positive integer");

  const random = seededRandom(symbolSeed(scenario.seed, config.symbol));
  let liquidations = 0;
  let delayedLiquidations = 0;
  let penaltyShortfalls = 0;
  let confirmationRestarts = 0;
  let confirmationRecoveries = 0;
  let confirmationShortfalls = 0;
  let unresolvedConfirmations = 0;
  let totalConfirmationWindows = 0;
  let worstCollateralRatioBps = Number.POSITIVE_INFINITY;

  for (let trial = 0; trial < scenario.trials; ++trial) {
    let returnBps = scenario.dailyDriftBps + normal(random) * volatility;
    if (random() * BPS < scenario.jumpProbabilityBps) {
      returnBps += normal(random) * scenario.jumpVolatilityBps;
    }
    returnBps = Math.max(-9_900, Math.min(BPS, Math.round(returnBps)));

    const outcome = classifyGap(config, scenario, returnBps);
    const liquidationDelayed = outcome.liquidatable && outcome.confirmationRequired;
    if (outcome.liquidatable) liquidations++;
    if (liquidationDelayed) delayedLiquidations++;
    if (outcome.penaltyShortfall) penaltyShortfalls++;
    worstCollateralRatioBps = Math.min(worstCollateralRatioBps, outcome.collateralRatioBps);

    if (liquidationDelayed) {
      const windowReturnsBps: number[] = [];
      for (let window = 0; window < scenario.maxConfirmationWindows; ++window) {
        let windowReturnBps = normal(random) * confirmationWindowVolatility;
        if (random() * BPS < scenario.confirmationWindowJumpProbabilityBps) {
          windowReturnBps += normal(random) * scenario.confirmationWindowJumpVolatilityBps;
        }
        windowReturnsBps.push(Math.max(-9_900, Math.min(BPS, Math.round(windowReturnBps))));
      }
      const path = classifyConfirmationPath(config, scenario, returnBps, windowReturnsBps);
      if (path.restartCount > 0) confirmationRestarts++;
      if (path.resolution === "recovered") confirmationRecoveries++;
      if (path.resolution === "unresolved") unresolvedConfirmations++;
      if (path.penaltyShortfallDuringDelay) confirmationShortfalls++;
      totalConfirmationWindows += path.windowsUsed;
      worstCollateralRatioBps = Math.min(worstCollateralRatioBps, path.worstCollateralRatioBps);
    }
  }

  const rate = (count: number) => Math.round(count * BPS / scenario.trials);
  return {
    ...config,
    trials: scenario.trials,
    liquidationCount: liquidations,
    delayedLiquidationCount: delayedLiquidations,
    penaltyShortfallCount: penaltyShortfalls,
    confirmationRestartCount: confirmationRestarts,
    confirmationRecoveryCount: confirmationRecoveries,
    confirmationShortfallCount: confirmationShortfalls,
    unresolvedConfirmationCount: unresolvedConfirmations,
    averageConfirmationWindows: delayedLiquidations === 0 ? 0 : totalConfirmationWindows / delayedLiquidations,
    liquidationRateBps: rate(liquidations),
    delayedLiquidationRateBps: rate(delayedLiquidations),
    penaltyShortfallRateBps: rate(penaltyShortfalls),
    worstCollateralRatioBps,
  };
}

export function runSimulation(configs: RiskConfig[], scenario: RiskScenario): SimulationResult[] {
  if (scenario.schemaVersion !== 3) throw new Error(`unsupported scenario schema: ${scenario.schemaVersion}`);
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
    gap_shortfall: occurrence(result.penaltyShortfallCount, result.trials),
    delay_shortfall: occurrence(result.confirmationShortfallCount, result.trials),
    delay_restart: occurrence(result.confirmationRestartCount, result.trials),
    delay_recovery: occurrence(result.confirmationRecoveryCount, result.trials),
    unresolved: occurrence(result.unresolvedConfirmationCount, result.trials),
    avg_windows: result.averageConfirmationWindows.toFixed(2),
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
