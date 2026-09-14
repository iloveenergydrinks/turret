import { ISOLATED_ASSETS } from "./isolated-assets";

// Registered identities with no admitted production lending pool.
export const DEFERRED_MARKETS = ISOLATED_ASSETS.map((asset) => asset.symbol);
