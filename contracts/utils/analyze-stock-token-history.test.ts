import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeHistory,
  HistoricalDataProvenance,
  parseHistoricalCsv,
  validateProvenance,
} from "./analyze-stock-token-history";

const provenance: HistoricalDataProvenance = {
  schemaVersion: 1,
  datasetKind: "historical",
  sourceName: "Licensed test fixture",
  sourceUrl: "https://data.example.test/stocks",
  license: "Test fixture license",
  retrievedAt: "2026-09-01T00:00:00Z",
  timezone: "America/New_York",
  intervalMinutes: 5,
  files: { NVDA: { path: "nvda.csv", sha256: "a".repeat(64) } },
};

const csv = `timestamp,session,open,high,low,close
2026-08-31T19:55:00Z,2026-08-31,200,201,199,200
2026-09-01T13:30:00Z,2026-09-01,150,152,149,151
2026-09-01T13:35:00Z,2026-09-01,151,152,140,141
2026-09-01T13:40:00Z,2026-09-01,141,142,130,131
2026-09-01T13:45:00Z,2026-09-01,131,132,120,121
2026-09-01T13:50:00Z,2026-09-01,121,122,110,111
2026-09-01T13:55:00Z,2026-09-01,111,112,100,101
2026-09-01T14:00:00Z,2026-09-01,101,102,79,80`;

test("requires licensed, checksummed provenance and rejects synthetic data by default", () => {
  assert.doesNotThrow(() => validateProvenance(provenance, ["NVDA"]));
  assert.throws(
    () => validateProvenance({ ...provenance, datasetKind: "synthetic" }, ["NVDA"]),
    /never satisfy the historical-data gate/,
  );
  assert.doesNotThrow(() => validateProvenance({ ...provenance, datasetKind: "synthetic" }, ["NVDA"], true));
  assert.throws(() => validateProvenance({ ...provenance, license: "TBD" }, ["NVDA"]), /license/);
  assert.throws(
    () => validateProvenance({ ...provenance, files: {} }, ["NVDA"]),
    /missing data file for NVDA/,
  );
});

test("parses canonical OHLC bars and rejects unsorted or inconsistent data", () => {
  assert.equal(parseHistoricalCsv(csv).length, 8);
  assert.throws(() => parseHistoricalCsv(csv.replace("149,151", "152,151")), /inconsistent OHLC range/);
  const unsorted = csv.replace("2026-09-01T13:35:00Z", "2026-08-30T13:35:00Z");
  assert.throws(() => parseHistoricalCsv(unsorted), /strictly increasing/);
});

test("measures historical gaps, thirty-minute loss, closures, and risk events", () => {
  const analysis = analyzeHistory(
    { symbol: "NVDA", mcrBps: 20_000, maxOracleDeviationBps: 2_000 },
    parseHistoricalCsv(csv),
    5,
  );

  assert.equal(analysis.observations, 8);
  assert.equal(analysis.sessions, 2);
  assert.equal(analysis.worstSessionGapBps, -2_500);
  assert.equal(analysis.worstThirtyMinuteReturnBps, -4_702);
  assert.ok(analysis.circuitBreakerMoveCount > 0);
  assert.equal(analysis.sessionGapShortfallCount, 0);
  assert.equal(analysis.thirtyMinuteShortfallCount, 1);
  assert.equal(analysis.longestClosureMinutes, 1_050);
});
