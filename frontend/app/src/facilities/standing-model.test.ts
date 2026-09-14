// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { formatUnits } from "viem";
import { loadStandingConfig, loadStandingFacility, loadStandingPage, queueStandingRead, setupTerms, validateStandingConfig, type SetupDraft } from "./standing-model";
import { ZERO_HASH } from "./quotes.mjs";
const a = (n: number) => `0x${String(n).padStart(40, "0")}` as const;
const baseline = { schemaVersion: 1, chainId: 31337, blockNumber: "1", blockHash: ZERO_HASH, tokens: [3, 4].map(n => ({ address: a(n), runtimeHash: ZERO_HASH, implementationSlot: ZERO_HASH, beaconSlot: ZERO_HASH, decimals: n === 3 ? 6 : 18, checks: [] })) };
const config = { schemaVersion: 1 as const, chainId: 31337, factory: a(9), runtimeHash: ZERO_HASH, loanToken: a(3), startBlock: "1", collateral: [{ address: a(4), symbol: "PONS", name: "Pons", decimals: 18 }], baseline };
const entry = { chainId: 31337, address: a(1), lender: a(2), loanToken: a(3), collateralToken: a(4), feeRecipient: a(2), feeBps: "0", vaultImplementation: a(6), runtimeHash: ZERO_HASH, vaultImplementationHash: ZERO_HASH, collateralSymbol: "PONS", collateralDecimals: 18, loanDecimals: 6, startBlock: "2", factory: a(9) };
const c = () => validateStandingConfig(config, "localhost");
const respond = (data: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status })));
afterEach(() => { vi.unstubAllGlobals(); });
test("factory config cannot enable a local-chain factory on production, even with an empty public directory", () => {
  expect(c().factory).toBe(a(9)); expect(() => validateStandingConfig(config, "turret.capital")).toThrow(/network/);
});
test("missing feature differs from unavailable feature", async () => {
  respond({}, 404); expect(await loadStandingConfig()).toBeNull(); respond({}, 503); await expect(loadStandingConfig()).rejects.toThrow(/could not/);
});
test("standing directory rejects wrong factory, fee, token metadata and unrelated wallet filters", async () => {
  respond({ schemaVersion: 1, entries: [entry], nextCursor: null }); expect((await loadStandingPage(c())).entries).toEqual([entry]);
  for (const patch of [{ factory: a(8) }, { feeBps: "1" }, { collateralSymbol: "OTHER" }, { startBlock: "0" }, { feeRecipient: a(7) }]) {
    respond({ schemaVersion: 1, entries: [{ ...entry, ...patch }], nextCursor: null }); await expect(loadStandingPage(c())).rejects.toThrow();
  }
  respond({ schemaVersion: 1, entries: [entry], nextCursor: null }); await expect(loadStandingPage(c(), { lender: a(8) })).rejects.toThrow(/unexpected/);
});
test("directory pagination and specific-address resolution cannot silently repeat or substitute balances", async () => {
  respond({ schemaVersion: 1, entries: [entry, entry], nextCursor: null }); await expect(loadStandingPage(c())).rejects.toThrow();
  respond({ schemaVersion: 1, entries: [entry], nextCursor: "12" }); await expect(loadStandingPage(c(), { after: "12" })).rejects.toThrow();
  respond({ entry: { ...entry, address: a(8) } }); await expect(loadStandingFacility(c(), a(1))).rejects.toThrow(/different/);
});
const draft: SetupDraft = { budget: "1000", minimum: "10", maximum: "100", collateral: "200", interest: "5", days: "7" };
test("setup scales full-budget terms while preserving per-loan amounts, units and idle exposure limits", () => {
  const terms = setupTerms(draft, 18);
  expect(terms.limits.maxExposure).toBe(1_000_000000n); expect(terms.limits.maxDraw).toBe(100_000000n);
  expect(terms.limits.minInterestBps).toBe(500n); expect(terms.limits.minDuration).toBe(604800n);
  expect(terms.quote).toMatchObject({ collateral: "2000", interest: "50", capacity: "1000", minutes: "1440" });
  const token0 = setupTerms({ ...draft, budget: "10", minimum: "1", maximum: "3", collateral: "2", interest: "0" }, 0);
  expect(token0.quote.collateral).toBe("7"); expect(token0.quote.interest).toBe("0");
  expect(formatUnits(token0.limits.minCollateralPerPrincipalWad, 18)).toBe("0.000000666666666666");
});
test("setup rejects invalid ranges and unrepresentable collateral ratios before any wallet call", () => {
  for (const patch of [{ minimum: "101" }, { maximum: "1001" }, { interest: "-1" }, { days: "0" }, { days: "366" }, { days: "1.5" }, { budget: "1e3" }]) expect(() => setupTerms({ ...draft, ...patch }, 18)).toThrow();
  const almostMax = formatUnits((1n << 256n) - 1n, 6);
  expect(() => setupTerms({ ...draft, budget: almostMax, maximum: almostMax, collateral: almostMax, interest: "0.000001" }, 6)).toThrow(/contract amount limit/);
  expect(() => setupTerms({ ...draft, collateral: "0.000000000000000001", maximum: "100000000000000000000", budget: "100000000000000000000" }, 18)).toThrow(/range/);
});
test("directory work is bounded and queued requests from closed views are skipped", async () => {
  let active = 0, peak = 0; const release: Array<() => void> = [];
  const read = vi.fn(async () => { active++; peak = Math.max(active, peak); await new Promise<void>(resolve => release.push(resolve)); active--; return 1; });
  const first = queueStandingRead(read), second = queueStandingRead(read), skipped = queueStandingRead(read, () => false), last = queueStandingRead(read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)); release.splice(0).forEach(done => done());
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3)); release.splice(0).forEach(done => done());
  expect(await Promise.all([first, second, skipped, last])).toEqual([1, 1, null, 1]); expect(peak).toBe(2);
});
