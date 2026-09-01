import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  classifyConfirmationWindow,
  classifyGap,
  parseRiskManifest,
  RiskScenario,
  runSimulation,
  simulateBranch,
} from "./simulate-stock-token-risk";

const scenario: RiskScenario = {
  schemaVersion: 2,
  label: "test",
  trials: 1_000,
  seed: 42,
  startingBufferBps: 500,
  liquidationPenaltyBps: 1_000,
  jumpProbabilityBps: 100,
  jumpVolatilityBps: 1_200,
  dailyDriftBps: 0,
  dailyVolatilityBps: { NVDA: 340 },
  confirmationDeviationBps: 500,
  confirmationWindowVolatilityBps: { NVDA: 95 },
  confirmationWindowJumpProbabilityBps: 1_000,
  confirmationWindowJumpVolatilityBps: 800,
};

const nvda = { symbol: "NVDA", mcrBps: 20_000, maxOracleDeviationBps: 2_000 };

test("classifies the exact oracle cutoff without rounding it into a delayed liquidation", () => {
  assert.deepEqual(classifyGap(nvda, scenario, -2_000), {
    collateralRatioBps: 16_400,
    liquidatable: true,
    confirmationRequired: false,
    penaltyShortfall: false,
  });
  assert.equal(classifyGap(nvda, scenario, -2_001).confirmationRequired, true);
  assert.equal(classifyGap(nvda, scenario, -5_000).penaltyShortfall, true);
});

test("seeded simulations are reproducible", () => {
  assert.deepEqual(simulateBranch(nvda, scenario), simulateBranch(nvda, scenario));
});

test("models confirmation, material drift, recovery, and blocked shortfall", () => {
  const confirmed = classifyConfirmationWindow(nvda, scenario, -5_000, 100);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.penaltyShortfallDuringDelay, true);

  const restarted = classifyConfirmationWindow(nvda, scenario, -5_000, 600);
  assert.equal(restarted.confirmationRestarts, true);
  assert.equal(restarted.confirmed, false);

  const recovered = classifyConfirmationWindow(nvda, scenario, -5_000, 6_000);
  assert.equal(recovered.recoveredWithoutConfirmation, true);
  assert.equal(recovered.confirmationRestarts, false);
});

test("fails closed when an asset volatility assumption is missing", () => {
  assert.throws(
    () => simulateBranch({ ...nvda, symbol: "AAPL" }, scenario),
    /missing daily volatility for AAPL/,
  );
});

test("parses all reviewed risk parameters from the Solidity manifest", async () => {
  const source = await readFile(resolve(__dirname, "../src/StockTokens/StockTokenConfig.sol"), "utf8");
  const configs = parseRiskManifest(source);

  assert.equal(configs.length, 10);
  assert.deepEqual(configs[0], { symbol: "AAPL", mcrBps: 17_500, maxOracleDeviationBps: 1_500 });
  assert.deepEqual(configs[5], nvda);
  assert.deepEqual(configs[9], { symbol: "TSLA", mcrBps: 25_000, maxOracleDeviationBps: 2_500 });
});

test("runs all ten branches only with complete explicit assumptions", async () => {
  const source = await readFile(resolve(__dirname, "../src/StockTokens/StockTokenConfig.sol"), "utf8");
  const scenarioSource = await readFile(resolve(__dirname, "stock-risk-scenario.sandcastle.json"), "utf8");
  const completeScenario = JSON.parse(scenarioSource) as RiskScenario;
  const results = runSimulation(parseRiskManifest(source), { ...completeScenario, trials: 100 });

  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.trials === 100));
});
