import assert from "node:assert/strict";
import { test } from "node:test";
import { currentVaultBlockers, inspectToken, inspectV3Pool, missingEvidence, stressCollateral } from "./assess-collateral";
const dollars = (n: bigint) => n * 1_000_000n;
const baseline = { collateralUsd6: dollars(100n), debtUsd6: dollars(70n), priceDropBps: 5000, slippageBps: 0, sellFeeBps: 0, gasUsd6: 0n, incentiveBps: 0 };

test("70% LTV and a 50% gap leave $20 of debt unsupported even before costs", () => {
  const result = stressCollateral(baseline);
  assert.equal(result.netSaleProceedsUsd6, dollars(50n));
  assert.equal(result.debtShortfallUsd6, dollars(20n));
  assert.equal(result.admission, "not-approved");
});
test("fees, slippage and gas worsen the gap; incentive is not lender income", () => {
  const result = stressCollateral({ ...baseline, slippageBps: 500, sellFeeBps: 300, gasUsd6: 750000n, incentiveBps: 500 });
  assert.equal(result.netSaleProceedsUsd6, 45_325000n);
  assert.equal(result.debtShortfallUsd6, 24_675000n);
  assert.equal(result.proceedsAfterDebtAndIncentiveUsd6, -28_175000n);
});
test("a full wipeout cannot produce negative proceeds or recovery", () => {
  const result = stressCollateral({ ...baseline, priceDropBps: 10000, gasUsd6: dollars(1n) });
  assert.equal(result.netSaleProceedsUsd6, 0n); assert.equal(result.debtShortfallUsd6, dollars(70n));
});
test("proceeds round down and incentive rounds up", () => {
  const result = stressCollateral({ ...baseline, collateralUsd6: 11n, debtUsd6: 1n, priceDropBps: 1, incentiveBps: 1 });
  assert.equal(result.netSaleProceedsUsd6, 10n); assert.equal(result.proceedsAfterDebtAndIncentiveUsd6, 8n);
});
test("invalid stress assumptions are rejected", () => {
  for (const priceDropBps of [-1,10001,1.5,NaN]) assert.throws(() => stressCollateral({ ...baseline, priceDropBps }));
  assert.throws(() => stressCollateral({ ...baseline, debtUsd6: -1n }));
});
test("higher headline market cap cannot bypass any evidence requirement", () => {
  assert.equal(missingEvidence({}).length, 9);
  assert.equal(missingEvidence({ canonicalIdentity: true }).length, 8);
  assert.ok(missingEvidence({}).includes("stressedUsdExitExecutedOnFork"));
});
test("ordinary ERC-20 lacks current stock-vault interface", () => {
  assert.match(currentVaultBlockers({codeExists:true, decimals:18, oraclePaused:null}).join(" "), /oraclePaused/);
});
test("wrong decimals, missing code and paused token are explicit blockers", () => {
  assert.equal(currentVaultBlockers({codeExists:false, decimals:6, oraclePaused:true}).length, 3);
  assert.deepEqual(currentVaultBlockers({codeExists:true, decimals:18, oraclePaused:false}), []);
  // Interface compatibility is deliberately not a listing approval.
  assert.equal(missingEvidence({}).length, 9);
});

const token = "0x0000000000000000000000000000000000000001" as const;
type InspectorClient = Parameters<typeof inspectToken>[0];
test("inspection rejects a different chain before reading the token", async () => {
  const client = { getChainId: async () => 1 } as unknown as InspectorClient;
  await assert.rejects(inspectToken(client, token), /Expected Robinhood Chain/);
});
test("inspection pins all reads to one block and never approves a compatible token", async () => {
  const reads: bigint[] = [];
  const client = {
    getChainId: async () => 4663,
    getBlock: async () => ({ number: 123n, timestamp: 456n }),
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => { reads.push(blockNumber); return "0x6000"; },
    readContract: async ({ blockNumber, functionName }: { blockNumber: bigint; functionName: string }) => {
      reads.push(blockNumber);
      return { symbol: "TEST", decimals: 18, oraclePaused: false }[functionName];
    },
  } as unknown as InspectorClient;
  const result = await inspectToken(client, token);
  assert.deepEqual(reads, [123n, 123n, 123n, 123n]);
  assert.equal(result.blockTimestamp, 456n);
  assert.deepEqual(result.existingVaultBlockers, []);
  assert.equal(result.admission, "not-approved");
  assert.equal(result.unchecked.length, 9);
});
test("failed token reads remain unknown and cannot silently pass interface checks", async () => {
  const client = {
    getChainId: async () => 4663,
    getBlock: async () => ({ number: 123n, timestamp: 456n }),
    getCode: async () => "0x",
    readContract: async () => { throw new Error("unavailable"); },
  } as unknown as InspectorClient;
  const result = await inspectToken(client, token);
  assert.equal(result.symbol, null);
  assert.equal(result.decimals, null);
  assert.equal(result.oraclePaused, null);
  assert.equal(result.existingVaultBlockers.length, 3);
  assert.equal(result.admission, "not-approved");
});

const pool = "0x0000000000000000000000000000000000000002" as const;
const quote = "0x0000000000000000000000000000000000000003" as const;
const factory = "0x0000000000000000000000000000000000000004" as const;
function poolClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ functionName: string; blockNumber: bigint; args?: unknown }> = [];
  const values: Record<string, unknown> = {
    token0: token, token1: quote, factory, fee: 10000, liquidity: 100n,
    getPool: pool, observe: [[1n, 2n], [3n, 4n]], ...overrides,
  };
  const client = {
    getChainId: async () => 4663,
    getBlock: async () => ({ number: 123n, timestamp: 456n }),
    readContract: async (request: typeof calls[number]) => {
      calls.push(request);
      if (values[request.functionName] instanceof Error) throw values[request.functionName];
      return values[request.functionName];
    },
  } as unknown as InspectorClient;
  return { client, calls };
}
test("pool reads use one block; passing discovery checks never approves collateral", async () => {
  const { client, calls } = poolClient();
  const result = await inspectV3Pool(client, token, pool, quote);
  assert.equal(result.factoryRegistrationMatches, true);
  assert.equal(result.observationHistory1800sAvailable, true);
  assert.equal(result.admission, "not-approved");
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.blockNumber === 123n));
  assert.deepEqual(calls.find(call => call.functionName === "observe")?.args, [[1800, 0]]);
});
test("reversed token order is valid but unrelated or same-token pairs are rejected", async () => {
  await inspectV3Pool(poolClient({token0: quote, token1: token}).client, token, pool, quote);
  await assert.rejects(inspectV3Pool(poolClient({token1: factory}).client, token, pool, quote), /does not contain/);
  await assert.rejects(inspectV3Pool(poolClient().client, token, pool, token), /does not contain/);
});
test("unsupported factory and failed observation reads remain unverified", async () => {
  const { client } = poolClient({getPool: new Error("revert"), observe: new Error("OLD")});
  const result = await inspectV3Pool(client, token, pool, quote);
  assert.equal(result.factoryRegistrationMatches, null);
  assert.equal(result.observationHistory1800sAvailable, false);
  assert.equal(result.admission, "not-approved");
});
test("mismatched registry and incomplete history cannot pass checks", async () => {
  const result = await inspectV3Pool(poolClient({getPool: token, observe: [[1n], [2n]], liquidity: 0n}).client, token, pool, quote);
  assert.equal(result.factoryRegistrationMatches, false);
  assert.equal(result.observationHistory1800sAvailable, false);
  assert.equal(result.activeLiquidityRaw, 0n);
  assert.equal(result.admission, "not-approved");
});
test("pool inspection refuses the wrong chain", async () => {
  await assert.rejects(inspectV3Pool({getChainId: async () => 1} as unknown as InspectorClient, token, pool, quote), /Expected Robinhood Chain/);
});
