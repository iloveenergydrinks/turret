// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { amount, loadFacilityLoans, loadFacilityQuotes, loadFacilityRegistry, validateRegistry, type FacilityMarket } from "./ui-model";
import { quoteDigest, ZERO_ADDRESS, ZERO_HASH, type SignedQuote } from "./quotes.mjs";
const address = (n: number) => `0x${String(n).padStart(40, "0")}` as const;
const market: FacilityMarket = { chainId: 31337, address: address(1), lender: address(2), loanToken: address(3), collateralToken: address(4), feeRecipient: address(5),
  feeBps: "1000", vaultImplementation: address(6), runtimeHash: ZERO_HASH, vaultImplementationHash: ZERO_HASH,
  collateralSymbol: "MEME", collateralDecimals: 18, loanDecimals: 6, startBlock: "1" };
const registry = { schemaVersion: 1, entries: [market], baseline: { schemaVersion: 1, chainId: 31337, blockNumber: "1", blockHash: ZERO_HASH,
  tokens: [3, 4].map(n => ({ address: address(n), runtimeHash: ZERO_HASH, implementationSlot: ZERO_HASH, beaconSlot: ZERO_HASH, decimals: n === 3 ? 6 : 18, checks: [] })) } };
function listing() {
  const envelope: SignedQuote = { schemaVersion: 1, chainId: 31337, facility: market.address, signature: "0x", quote: {
    epoch: "1", nonce: "1", borrower: ZERO_ADDRESS, capacity: "300000000", minDraw: "1000000", collateralForCapacity: "600000000000000000000",
    interestForCapacity: "15000000", duration: "604800", validAfter: String(Math.floor(Date.now() / 1000)), expiresAt: String(Math.floor(Date.now() / 1000) + 600) } };
  return { chainId: 31337, facility: market.address, status: "checked", checkedAt: Date.now(), capacity: "300000000", quotes: [{ id: quoteDigest(envelope), envelope,
    availability: { status: "available", borrowerEligible: true, capacity: "300000000", minDraw: "1000000", maxDraw: "300000000" } }] };
}
const response = (data: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(data), { status })));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test("registry binds token units and deployments and admits a local chain only at loopback hosts", () => {
  expect(validateRegistry(registry, "127.0.0.1").entries[0]).toEqual(market);
  expect(() => validateRegistry(registry, "turret.capital")).toThrow(/network/);
  expect(() => validateRegistry({ ...registry, entries: [market, market] }, "localhost")).toThrow(/asset details/);
  expect(() => validateRegistry({ ...registry, entries: [{ ...market, collateralDecimals: 6 }] }, "localhost")).toThrow(/asset details/);
  expect(() => validateRegistry({ ...registry, entries: [{ ...market, loanToken: address(99) }] }, "localhost")).toThrow(/qualified/);
  expect(() => validateRegistry({ ...registry, entries: [{ ...market, chainId: 4663 }] }, "localhost")).toThrow();
});
test("a missing feature registry is disabled, while an unavailable registry is an error", async () => {
  response({}, 404); expect((await loadFacilityRegistry()).entries).toEqual([]);
  response({}, 503); await expect(loadFacilityRegistry()).rejects.toThrow(/Unable to load/);
});
test("amount parsing preserves exact token units and rejects rounding, exponent notation and zero", () => {
  expect(amount("1.000001", 6)).toBe(1000001n);
  expect(amount("123", 0)).toBe(123n);
  for (const value of ["0", "-1", "1e6", "1.0000001", " 1", "01", "1,000"]) expect(() => amount(value, 6)).toThrow();
  expect(() => amount("1.1", 0)).toThrow();
  expect(() => amount(String(2n ** 256n), 0)).toThrow();
});
test("verified listing parses exact capacities and sends the connected borrower filter", async () => {
  response(listing());
  const data = await loadFacilityQuotes(market, address(8));
  expect(data.capacity).toBe(300_000000n); expect(data.quotes[0]!.availability.minDraw).toBe(1_000000n);
  expect(vi.mocked(fetch).mock.calls[0]![0]).toContain(`account=${address(8)}`);
});
test.each(["stale", "future", "other chain", "other facility", "changed terms", "excess capacity", "ineligible", "RPC failure"])("rejects %s instead of presenting borrowable funds", async mode => {
  const data = listing();
  if (mode === "stale") data.checkedAt -= 30000;
  if (mode === "future") data.checkedAt += 60000;
  if (mode === "other chain") data.chainId = 4663;
  if (mode === "other facility") data.facility = address(9);
  if (mode === "changed terms") data.quotes[0]!.envelope.quote.interestForCapacity = "30000000";
  if (mode === "excess capacity") data.quotes[0]!.availability.capacity = "300000001";
  if (mode === "ineligible") data.quotes[0]!.availability.borrowerEligible = false;
  response(data, mode === "RPC failure" ? 503 : 200);
  await expect(loadFacilityQuotes(market)).rejects.toThrow();
});

function history() {
  return { schemaVersion: 1, chainId: 31337, facility: market.address, account: address(8), checkedAt: Date.now(), historyEpoch: 0,
    complete: true, status: "ready", blockNumber: "100", blockHash: ZERO_HASH, indexedThrough: "100", nextCursor: null as string | null,
    rows: [{ id: "1", borrower: address(8), principal: "1000000", interest: "100000", dueAt: "1800000000", status: 2 }] };
}
test("loan history preserves repaid loans and explicit incomplete indexing", async () => {
  const data = history(); response(data);
  expect((await loadFacilityLoans(market, address(8))).rows[0]).toMatchObject({ id: 1n, status: 2, principal: 1000000n });
  response({ ...data, complete: false, status: "syncing", indexedThrough: "50" });
  expect((await loadFacilityLoans(market, address(8))).indexComplete).toBe(false);
});
test.each(["wrong wallet", "another borrower's loan", "duplicate id", "bad cursor", "contradictory completeness", "stale", "unavailable"])("rejects loan history with %s", async mode => {
  const data = history();
  if (mode === "wrong wallet") data.account = address(9);
  if (mode === "another borrower's loan") data.rows[0]!.borrower = address(9);
  if (mode === "duplicate id") data.rows.push(data.rows[0]!);
  if (mode === "bad cursor") data.nextCursor = "2";
  if (mode === "contradictory completeness") data.indexedThrough = "50";
  if (mode === "stale") data.checkedAt -= 30000;
  response(data, mode === "unavailable" ? 503 : 200);
  await expect(loadFacilityLoans(market, address(8))).rejects.toThrow();
});
