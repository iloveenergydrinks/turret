import { DOCKYARD_MARKETS, DOCKYARD_VAULT_ADDRESS, type DockyardMarket } from "./dockyard-config";
import { ISOLATED_ASSETS, type IsolatedAsset } from "./isolated-assets";
import { type IsolatedDeployment, validateIsolatedDeployment } from "./isolated-credit";
import { stockProofUrl } from "./stock-proof-url";
export type IsolatedMarket = IsolatedDeployment & {
  symbol: DockyardMarket["symbol"] | IsolatedAsset["symbol"];
  admission?: "commissioning" | "active";
};
const stockSymbols = new Set<string>(DOCKYARD_MARKETS.map((market) => market.symbol));
const genericAssets: Record<string, IsolatedAsset> = Object.fromEntries(
  ISOLATED_ASSETS.map((asset) => [asset.symbol, asset]),
);
const tokens = Object.fromEntries(
  [...DOCKYARD_MARKETS, ...ISOLATED_ASSETS].map((market) => [market.symbol, market.address.toLowerCase()]),
);
export function parseIsolatedMarkets(raw: string): IsolatedMarket[] {
  const rows = JSON.parse(raw || "[]");
  if (!Array.isArray(rows) || rows.length > Object.keys(tokens).length) throw new Error("Invalid isolated market configuration");
  const used = new Set<string>();
  const symbols = new Set<string>();
  if (DOCKYARD_VAULT_ADDRESS) used.add(DOCKYARD_VAULT_ADDRESS.toLowerCase());
  return rows.map((row: IsolatedMarket) => {
    validateIsolatedDeployment(row);
    if (row.admission !== undefined && !["commissioning", "active"].includes(row.admission)) {
      throw new Error("Invalid market admission state");
    }
    if (!Object.hasOwn(tokens, row.symbol) || row.collateral.toLowerCase() !== tokens[row.symbol]) {
      throw new Error("Collateral identity mismatch");
    }
    if (stockSymbols.has(row.symbol)) {
      if (!row.stock) throw new Error("Stock guard and USDG pricing dependencies required");
      if (!row.stock.riskMonitorUrl) throw new Error("Stock proof endpoint required");
      stockProofUrl(row.stock.riskMonitorUrl,row.engine);
    } else {
      if (row.stock) throw new Error("Non-stock collateral cannot use stock proof dependencies");
      // Oracle research is incomplete. Recognize exact assets and reviewed
      // deployments, but never let build-time configuration open deposits or borrowing.
      if (row.admission !== genericAssets[row.symbol]?.maxAdmission) {
        throw new Error("Non-stock collateral is commissioning-only");
      }
    }
    if (symbols.has(row.symbol)) throw new Error("Duplicate collateral market");
    symbols.add(row.symbol);
    for (const address of [row.engine, row.pool]) {
      if (used.has(address.toLowerCase())) throw new Error("Overlapping markets");
      used.add(address.toLowerCase());
    }
    return row;
  });
}
// No default/predicted deployments. Production must supply reviewed, mined addresses.
export const ISOLATED_MARKETS: IsolatedMarket[] = (() => {
  try {
    return parseIsolatedMarkets(process.env.NEXT_PUBLIC_ISOLATED_MARKETS_JSON ?? "[]");
  } catch {
    return [];
  }
})();
export const getIsolatedMarket = (engine: string) =>
  ISOLATED_MARKETS.find((m) => m.engine.toLowerCase() === engine.toLowerCase());
