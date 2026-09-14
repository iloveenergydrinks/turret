import type { Address } from "viem";

// Canonical non-stock collateral identities. Registration is deliberately
// separate from activation: both assets may appear in reviewed deployment
// configuration, but their oracle stacks are still commissioning-only.
export const ISOLATED_ASSETS = [
  {
    symbol: "CASHCAT",
    name: "Cash Cat",
    address: "0x020bfC650A365f8BB26819deAAbF3E21291018b4",
    maxAdmission: "commissioning",
    oracle: {
      reference: "pyth-usd-ratio",
      collateralFeedId: 3441,
      usdgFeedId: 232,
      status: "provider-access-required",
    },
  },
  {
    symbol: "PONS",
    name: "Pons",
    address: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
    maxAdmission: "commissioning",
    oracle: {
      reference: "threshold-cex-usd-ratio",
      status: "independent-reporters-required",
    },
  },
] as const satisfies readonly {
  symbol: string;
  name: string;
  address: Address;
  maxAdmission: "commissioning";
  oracle: {
    reference: "pyth-usd-ratio" | "threshold-cex-usd-ratio";
    status: "provider-access-required" | "independent-reporters-required";
    collateralFeedId?: number;
    usdgFeedId?: number;
  };
}[];

export type IsolatedAsset = (typeof ISOLATED_ASSETS)[number];

export function getIsolatedAsset(symbol: string): IsolatedAsset | null {
  return ISOLATED_ASSETS.find((asset) => asset.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
}
