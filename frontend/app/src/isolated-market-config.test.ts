import { expect, test, vi } from "vitest";
vi.mock("./dockyard-config", async (original) => ({ ...await original<object>(), DOCKYARD_VAULT_ADDRESS: "0x9999999999999999999999999999999999999999" }));
import { DOCKYARD_MARKETS } from "./dockyard-config";
import { ISOLATED_ASSETS } from "./isolated-assets";
import { parseIsolatedMarkets } from "./isolated-market-config";
const addr = (x: string) => `0x${x.repeat(40)}`;
const hash = `0x${"ab".repeat(32)}`;
const row = {
  chainId: 4663,
  symbol: "AAPL",
  engine: addr("1"),
  pool: addr("2"),
  collateral: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  primary: addr("4"),
  secondary: addr("5"),
  hashes: { engine: hash, pool: hash, collateral: hash, primary: hash, secondary: hash, usdg: hash },
  stock: { executionGate: addr("6"), usdgPrimary: addr("7"), usdgSecondary: addr("8"),
    riskMonitorUrl: "https://risk.example.test",
    hashes: { executionGate: hash, usdgPrimary: hash, usdgSecondary: hash } },
};
test("only explicit, canonical isolated collateral configuration is accepted", () => {
  expect(parseIsolatedMarkets("[]")).toEqual([]);
  expect(parseIsolatedMarkets(JSON.stringify([row]))).toEqual([row]);
  expect(parseIsolatedMarkets(JSON.stringify([{ ...row, admission: "commissioning" }]))[0]!.admission).toBe("commissioning");
  expect(() => parseIsolatedMarkets(JSON.stringify([{ ...row, admission: "unknown" }]))).toThrow(/admission/);
  for (
    const change of [{ symbol: "MSFT" }, { collateral: addr("3") }, { chainId: 1 }, { engine: addr("9") }, {
      hashes: {},
    }, { stock: undefined }, { stock: { ...row.stock, usdgPrimary: row.primary } }, {
      stock: { ...row.stock, hashes: {} },
    }]
  ) {
    expect(() => parseIsolatedMarkets(JSON.stringify([{ ...row, ...change }]))).toThrow();
  }
});
test("stock identities are admitted only with their canonical token", () => {
  for (const stock of DOCKYARD_MARKETS) {
    const candidate = { ...row, symbol: stock.symbol, collateral: stock.address };
    expect(parseIsolatedMarkets(JSON.stringify([candidate]))).toEqual([candidate]);
  }
});
test("CASHCAT and PONS are registered but cannot be activated before oracle approval", () => {
  for (const asset of ISOLATED_ASSETS) {
    const candidate = {
      ...row,
      symbol: asset.symbol,
      collateral: asset.address,
      admission: "commissioning",
      stock: undefined,
    };
    expect(parseIsolatedMarkets(JSON.stringify([candidate]))).toEqual([candidate]);
    expect(() => parseIsolatedMarkets(JSON.stringify([{ ...candidate, admission: "active" }]))).toThrow(/commissioning-only/);
    expect(() => parseIsolatedMarkets(JSON.stringify([{ ...candidate, stock: row.stock }]))).toThrow(/Non-stock/);
    expect(() => parseIsolatedMarkets(JSON.stringify([{ ...candidate, collateral: addr("3") }]))).toThrow(/identity/);
  }
});
test("malformed, duplicate and cross-market pool/engine collisions fail closed", () => {
  for (
    const raw of [
      "null",
      "{}",
      "broken",
      JSON.stringify([row, row]),
      JSON.stringify([row, row, row]),
      JSON.stringify([row, { ...row, engine: row.pool, pool: addr("6") }]),
    ]
  ) {
    expect(() => parseIsolatedMarkets(raw)).toThrow();
  }
});
