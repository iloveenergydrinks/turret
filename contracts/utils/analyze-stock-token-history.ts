import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { classifyGap, parseRiskManifest, RiskConfig } from "./simulate-stock-token-risk";

export type HistoricalDataProvenance = {
  schemaVersion: 1;
  datasetKind: "historical" | "synthetic";
  sourceName: string;
  sourceUrl: string;
  license: string;
  retrievedAt: string;
  timezone: string;
  intervalMinutes: number;
  files: Record<string, { path: string; sha256: string }>;
};

export type HistoricalBar = {
  timestamp: number;
  session: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type HistoricalAnalysis = {
  symbol: string;
  observations: number;
  sessions: number;
  worstSessionGapBps: number;
  worstThirtyMinuteReturnBps: number;
  circuitBreakerMoveCount: number;
  sessionGapShortfallCount: number;
  thirtyMinuteShortfallCount: number;
  longestClosureMinutes: number;
};

const CSV_HEADER = "timestamp,session,open,high,low,close";

export function validateProvenance(
  provenance: HistoricalDataProvenance,
  expectedSymbols: string[],
  allowSynthetic = false,
): void {
  if (provenance.schemaVersion !== 1) throw new Error(`unsupported provenance schema: ${provenance.schemaVersion}`);
  if (provenance.datasetKind !== "historical" && provenance.datasetKind !== "synthetic") {
    throw new Error("datasetKind must be historical or synthetic");
  }
  if (provenance.datasetKind === "synthetic" && !allowSynthetic) {
    throw new Error("synthetic datasets require --allow-synthetic and never satisfy the historical-data gate");
  }
  if (!provenance.sourceName.trim()) throw new Error("sourceName is required");
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(provenance.sourceUrl);
  } catch {
    throw new Error("sourceUrl must be an HTTPS URL");
  }
  if (sourceUrl.protocol !== "https:") {
    throw new Error("sourceUrl must be an HTTPS URL");
  }
  if (!provenance.license.trim() || /^(unknown|tbd|none)$/i.test(provenance.license.trim())) {
    throw new Error("a concrete dataset license is required");
  }
  if (!Number.isFinite(Date.parse(provenance.retrievedAt))) throw new Error("retrievedAt must be an ISO timestamp");
  if (!provenance.timezone.trim()) throw new Error("timezone is required");
  if (
    !Number.isInteger(provenance.intervalMinutes) || provenance.intervalMinutes <= 0 || 30 % provenance.intervalMinutes
  ) {
    throw new Error("intervalMinutes must be a positive divisor of 30");
  }

  for (const symbol of expectedSymbols) {
    const file = provenance.files[symbol];
    if (!file?.path.trim()) throw new Error(`missing data file for ${symbol}`);
    if (!/^[0-9a-f]{64}$/i.test(file.sha256)) throw new Error(`invalid SHA-256 for ${symbol}`);
  }
  const unexpected = Object.keys(provenance.files).filter((symbol) => !expectedSymbols.includes(symbol));
  if (unexpected.length > 0) throw new Error(`unexpected symbols in provenance: ${unexpected.join(", ")}`);
}

export function parseHistoricalCsv(source: string): HistoricalBar[] {
  const lines = source.trim().split(/\r?\n/);
  if (lines[0] !== CSV_HEADER) throw new Error(`CSV header must be exactly: ${CSV_HEADER}`);
  if (lines.length < 2) throw new Error("CSV must contain at least one bar");

  const bars = lines.slice(1).map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 6) throw new Error(`line ${index + 2}: expected 6 columns`);
    const timestamp = Date.parse(columns[0]);
    const [open, high, low, close] = columns.slice(2).map(Number);
    if (!Number.isFinite(timestamp)) throw new Error(`line ${index + 2}: invalid timestamp`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(columns[1])) throw new Error(`line ${index + 2}: invalid session`);
    if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(`line ${index + 2}: OHLC values must be positive numbers`);
    }
    if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
      throw new Error(`line ${index + 2}: inconsistent OHLC range`);
    }
    return { timestamp, session: columns[1], open, high, low, close };
  });

  for (let index = 1; index < bars.length; ++index) {
    if (bars[index].timestamp <= bars[index - 1].timestamp) {
      throw new Error(`line ${index + 2}: timestamps must be strictly increasing`);
    }
  }
  return bars;
}

function returnBps(next: number, previous: number): number {
  return Math.round((next / previous - 1) * 10_000);
}

export function analyzeHistory(
  config: RiskConfig,
  bars: HistoricalBar[],
  intervalMinutes: number,
  startingBufferBps = 500,
  liquidationPenaltyBps = 1_000,
): HistoricalAnalysis {
  if (bars.length < 2) throw new Error(`${config.symbol}: at least two bars are required`);
  const thirtyMinuteBars = 30 / intervalMinutes;
  let worstSessionGapBps = 0;
  let worstThirtyMinuteReturnBps = 0;
  let circuitBreakerMoveCount = 0;
  let sessionGapShortfallCount = 0;
  let thirtyMinuteShortfallCount = 0;
  let longestClosureMinutes = 0;
  const sessions = new Set(bars.map((bar) => bar.session));
  const risk = { startingBufferBps, liquidationPenaltyBps };

  for (let index = 1; index < bars.length; ++index) {
    const previous = bars[index - 1];
    const current = bars[index];
    const elapsedMinutes = (current.timestamp - previous.timestamp) / 60_000;
    longestClosureMinutes = Math.max(longestClosureMinutes, Math.max(0, elapsedMinutes - intervalMinutes));

    const observedReturnBps = returnBps(current.close, previous.close);
    if (Math.abs(observedReturnBps) > config.maxOracleDeviationBps) circuitBreakerMoveCount++;

    if (current.session !== previous.session) {
      const gapBps = returnBps(current.open, previous.close);
      worstSessionGapBps = Math.min(worstSessionGapBps, gapBps);
      if (classifyGap(config, risk, gapBps).penaltyShortfall) sessionGapShortfallCount++;
    }

    if (index >= thirtyMinuteBars) {
      const reference = bars[index - thirtyMinuteBars];
      const isContinuousThirtyMinutes = current.session === reference.session
        && current.timestamp - reference.timestamp === 30 * 60_000;
      if (!isContinuousThirtyMinutes) continue;
      const thirtyMinuteReturnBps = returnBps(current.close, reference.close);
      worstThirtyMinuteReturnBps = Math.min(worstThirtyMinuteReturnBps, thirtyMinuteReturnBps);
      if (classifyGap(config, risk, thirtyMinuteReturnBps).penaltyShortfall) thirtyMinuteShortfallCount++;
    }
  }

  return {
    symbol: config.symbol,
    observations: bars.length,
    sessions: sessions.size,
    worstSessionGapBps,
    worstThirtyMinuteReturnBps,
    circuitBreakerMoveCount,
    sessionGapShortfallCount,
    thirtyMinuteShortfallCount,
    longestClosureMinutes,
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function percent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export async function main(): Promise<void> {
  const provenanceArgument = process.argv.find((argument, index) => index > 1 && !argument.startsWith("--"));
  if (!provenanceArgument) throw new Error("usage: analyze:stock-history -- <provenance.json> [--allow-synthetic]");

  const provenancePath = resolve(provenanceArgument);
  const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as HistoricalDataProvenance;
  const manifestSource = await readFile(resolve(__dirname, "../src/StockTokens/StockTokenConfig.sol"), "utf8");
  const configs = parseRiskManifest(manifestSource);
  validateProvenance(provenance, configs.map(({ symbol }) => symbol), process.argv.includes("--allow-synthetic"));

  const analyses: HistoricalAnalysis[] = [];
  for (const config of configs) {
    const file = provenance.files[config.symbol];
    const source = await readFile(resolve(dirname(provenancePath), file.path), "utf8");
    if (sha256(source) !== file.sha256.toLowerCase()) throw new Error(`${config.symbol}: SHA-256 mismatch`);
    analyses.push(analyzeHistory(config, parseHistoricalCsv(source), provenance.intervalMinutes));
  }

  console.log(`${provenance.sourceName} (${provenance.datasetKind}) — ${provenance.sourceUrl}`);
  console.table(analyses.map((analysis) => ({
    symbol: analysis.symbol,
    bars: analysis.observations,
    sessions: analysis.sessions,
    worst_gap: percent(analysis.worstSessionGapBps),
    worst_30m: percent(analysis.worstThirtyMinuteReturnBps),
    breaker_moves: analysis.circuitBreakerMoveCount,
    gap_shortfalls: analysis.sessionGapShortfallCount,
    thirty_minute_shortfalls: analysis.thirtyMinuteShortfallCount,
    longest_closure_minutes: analysis.longestClosureMinutes,
  })));
  console.log("Dataset provenance was verified. Parameter approval and independent review remain separate gates.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
