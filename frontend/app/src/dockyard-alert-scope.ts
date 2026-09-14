import { DOCKYARD_MARKETS, DOCKYARD_VAULT_ADDRESS } from "./dockyard-config";
import { getAddress, isAddress, type Address } from "viem";

export type AlertScope = {
  protocol: "stock" | "isolated";
  vault: Address;
  collateral?: Address;
  symbol: string;
  url: string;
};
const collateralTokens: Record<string, Address> = {
  ...Object.fromEntries(DOCKYARD_MARKETS.map(m => [m.symbol, m.address])),
  CASHCAT: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
  PONS: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
} as const;
function serviceUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid alert service URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid alert service URL");
  }
  return url.href.replace(/\/$/, "");
}
export function parseIsolatedAlertScopes(raw: string, stockUrl = "", stockVault: string | null = null): AlertScope[] {
  const rows: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(rows) || rows.length > Object.keys(collateralTokens).length) throw new Error("Invalid isolated alert configuration");
  const addresses = new Set<string>(stockVault ? [stockVault.toLowerCase()] : []);
  const urls = new Set<string>(stockUrl ? [serviceUrl(stockUrl)] : []);
  return rows.map((row) => {
    if (!row || typeof row !== "object" || !isAddress(row.engine ?? "")
      || /^0x0{40}$/i.test(row.engine) || !Object.hasOwn(collateralTokens, row.symbol)) {
      throw new Error("Invalid isolated alert configuration");
    }
    const vault = getAddress(row.engine);
    const symbol = row.symbol as keyof typeof collateralTokens;
    const url = serviceUrl(row.url);
    if (addresses.has(vault.toLowerCase()) || urls.has(url)) throw new Error("Overlapping alert services");
    addresses.add(vault.toLowerCase());
    urls.add(url);
    return { protocol: "isolated", vault, symbol, collateral: collateralTokens[symbol], url };
  });
}
export const ALERTS_URL = (process.env.NEXT_PUBLIC_BORROWER_ALERTS_URL ?? "").replace(/\/$/, "");
const stockScope: AlertScope | null = (() => {
  try {
    return DOCKYARD_VAULT_ADDRESS
      ? { protocol: "stock", vault: getAddress(DOCKYARD_VAULT_ADDRESS), symbol: "Stock Tokens", url: serviceUrl(ALERTS_URL) }
      : null;
  } catch { return null; }
})();
const isolatedScopes: AlertScope[] = (() => {
  try {
    return parseIsolatedAlertScopes(process.env.NEXT_PUBLIC_ISOLATED_ALERTS_JSON ?? "[]", ALERTS_URL, DOCKYARD_VAULT_ADDRESS);
  } catch { return []; } // Invalid isolated configuration must not break the stock app.
})();
// Only the build-time allowlist can select an endpoint. Unknown/empty explicit engines never fall back to stock.
export function resolveAlertScope(engine?: string | null): AlertScope | null {
  if (engine == null) return stockScope;
  if (!isAddress(engine)) return null;
  return isolatedScopes.find(scope => scope.vault.toLowerCase() === engine.toLowerCase()) ?? null;
}
export function scopeMatches(scope: AlertScope, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const info = value as Record<string, unknown>;
  return info.protocol === scope.protocol && typeof info.vault === "string"
    && info.vault.toLowerCase() === scope.vault.toLowerCase()
    && (scope.protocol === "stock" || typeof info.collateral === "string"
      && info.collateral.toLowerCase() === scope.collateral?.toLowerCase());
}
export async function alertsRequest(path: string, session = "", body?: object, method?: string, scope = stockScope) {
  if (!scope) throw new Error("Alerts are not configured for this market.");
  if (!["/capabilities", "/challenge", "/session", "/subscriptions", "/transactions", "/verify"].includes(path)) {
    throw new Error("Unknown alert action.");
  }
  const request = async (route: string, authenticated = false) => {
    const response = await fetch(`${scope.url}${route}`, {
      method: authenticated ? method ?? (body ? "POST" : "GET") : "GET",
      headers: authenticated ? {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(session ? { authorization: `Bearer ${session}` } : {}),
      } : {},
      body: authenticated && body ? JSON.stringify(body) : undefined,
      redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === "string" && data.error.length <= 300
      ? data.error : "Alerts are temporarily unavailable. Please retry.");
    return data;
  };
  // Check identity before sending session tokens, contact details, signatures or email verification tokens.
  const capabilities = await request("/capabilities");
  if (!scopeMatches(scope, capabilities)) throw new Error("Alert service does not match this site and vault.");
  return path === "/capabilities" ? capabilities : request(path, true);
}
