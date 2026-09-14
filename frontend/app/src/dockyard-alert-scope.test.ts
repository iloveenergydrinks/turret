import { afterEach, expect, test, vi } from "vitest";
vi.mock("./dockyard-config", async original => ({ ...await original<object>(), DOCKYARD_VAULT_ADDRESS: null }));
import { DOCKYARD_MARKETS } from "./dockyard-config";
import { alertsRequest, parseIsolatedAlertScopes, scopeMatches } from "./dockyard-alert-scope";
const engine = "0x3333333333333333333333333333333333333333";
const row = { engine, symbol: "CASHCAT", url: "https://alerts.example.test" };
const parse = (rows: unknown) => parseIsolatedAlertScopes(JSON.stringify(rows));
const scope = parse([row])[0]!;
const capabilities = { protocol: "isolated", vault: engine, collateral: scope.collateral, monitorReady: true, email: true };
afterEach(() => vi.unstubAllGlobals());
test("only known collateral symbols and nonzero engine addresses can be configured", () => {
  expect(parse([row])[0]!.collateral).toBe("0x020bfC650A365f8BB26819deAAbF3E21291018b4");
  for (const patch of [{ symbol: "OTHER" }, { symbol: "__proto__" }, { engine: "0x" }, { engine: `0x${"0".repeat(40)}` }]) {
    expect(() => parse([{ ...row, ...patch }])).toThrow();
  }
});
test("all ten stock pools can have distinct engine-bound warning subscriptions", () => {
  const rows=DOCKYARD_MARKETS.map((m,i)=>({engine:`0x${(i+1).toString(16).padStart(40,"0")}`,symbol:m.symbol,url:`https://alerts-${m.symbol.toLowerCase()}.example.test`}));
  const scopes=parse(rows);expect(scopes).toHaveLength(10);
  for(const [i,scope] of scopes.entries()){
    expect(scope.collateral).toBe(DOCKYARD_MARKETS[i]!.address);expect(scope.protocol).toBe("isolated");
    expect(scopeMatches(scope,{protocol:"stock",vault:scope.vault,collateral:scope.collateral})).toBe(false);
  }
});
test("rejects credentials, query parameters, fragments, and non-HTTPS services", () => {
  for (const url of ["http://alerts.test", "https://user:password@alerts.test", "https://alerts.test?secret=a",
    "https://alerts.test#token", "//alerts.test", "javascript:alert(1)"]) {
    expect(() => parse([{ ...row, url }])).toThrow();
  }
});
test("duplicate services, duplicate engines and stock overlaps fail closed", () => {
  expect(() => parse([row, row])).toThrow();
  expect(() => parse([row, { ...row, engine: "0x4444444444444444444444444444444444444444" }])).toThrow();
  expect(() => parseIsolatedAlertScopes(JSON.stringify([row]), row.url)).toThrow();
  expect(() => parseIsolatedAlertScopes(JSON.stringify([row]), "", engine)).toThrow();
});
test("service identity includes protocol, vault and collateral", () => {
  expect(scopeMatches(scope, capabilities)).toBe(true);
  for (const patch of [{ protocol: "stock" }, { vault: row.url }, { collateral: engine }]) {
    expect(scopeMatches(scope, { ...capabilities, ...patch })).toBe(false);
  }
});
test("identity mismatch stops contact data, tokens and signatures before transmission", async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => ({ ...capabilities, protocol: "stock" }) }));
  vi.stubGlobal("fetch", fetcher);
  await expect(alertsRequest("/verify", "sensitive-session", { token: "sensitive-token" }, undefined, scope)).rejects.toThrow(/does not match/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("body", expect.any(String));
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("sensitive");
});
test("requests use fixed endpoints and suppress redirects, cookies and referrers", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => capabilities }));
  vi.stubGlobal("fetch", fetcher);
  await alertsRequest("/verify", "", { token: "test" }, undefined, scope);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]).toEqual([`${row.url}/verify`, expect.objectContaining({
    method: "POST", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", body: '{"token":"test"}',
  })]);
  await expect(alertsRequest("https://evil.test", "", undefined, undefined, scope)).rejects.toThrow(/Unknown alert action/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
