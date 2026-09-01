import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROBINHOOD_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
const CHAINLINK_FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const ROBINHOOD_CHAIN_ID = 4663;
const EXPECTED_FEED_HEARTBEAT = 86_400;
const EXPECTED_FEED_DECIMALS = 8;

export type ManifestEntry = {
  symbol: string;
  token: string;
  primaryFeed: string;
  secondaryFeed: string;
};

type RobinhoodAsset = {
  tokenSymbol: string;
  status: string;
  pendingMultiplier?: string;
  pendingMultiplierEffectiveTime?: string | null;
  deployments: Array<{ chainId: number; contractAddress: string }>;
};

type ChainlinkFeed = {
  name: string;
  proxyAddress: string;
  secondaryProxyAddress: string;
  heartbeat: number;
  threshold: number;
  decimals: number;
};

const normalized = (value: string) => value.toLowerCase();

export function parseManifest(source: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const configPattern =
    /_config\(\s*"([A-Z]+)"\s*,\s*(0x[0-9a-fA-F]{40})\s*,\s*(0x[0-9a-fA-F]{40})\s*,\s*(0x[0-9a-fA-F]{40})\s*,/g;

  for (const match of source.matchAll(configPattern)) {
    entries.push({
      symbol: match[1],
      token: match[2],
      primaryFeed: match[3],
      secondaryFeed: match[4],
    });
  }

  return entries;
}

export function validateRegistry(
  manifest: ManifestEntry[],
  assets: RobinhoodAsset[],
  feeds: ChainlinkFeed[],
): string[] {
  const errors: string[] = [];
  if (manifest.length !== 10) {
    errors.push(`manifest must contain exactly 10 branches; found ${manifest.length}`);
  }

  const seenSymbols = new Set<string>();
  const seenAddresses = new Set<string>();
  for (const entry of manifest) {
    if (seenSymbols.has(entry.symbol)) errors.push(`duplicate symbol: ${entry.symbol}`);
    seenSymbols.add(entry.symbol);

    for (
      const [kind, address] of [
        ["token", entry.token],
        ["primary feed", entry.primaryFeed],
        ["secondary feed", entry.secondaryFeed],
      ] as const
    ) {
      const key = normalized(address);
      if (seenAddresses.has(key)) errors.push(`duplicate ${kind} address for ${entry.symbol}: ${address}`);
      seenAddresses.add(key);
    }

    if (normalized(entry.primaryFeed) === normalized(entry.secondaryFeed)) {
      errors.push(`${entry.symbol}: primary and secondary feeds must differ`);
    }

    const asset = assets.find((candidate) => candidate.tokenSymbol === entry.symbol);
    if (!asset) {
      errors.push(`${entry.symbol}: missing from Robinhood asset registry`);
    } else {
      if (asset.status !== "ASSET_STATUS_ACTIVE") {
        errors.push(`${entry.symbol}: Robinhood asset is not active (${asset.status})`);
      }
      if (asset.pendingMultiplier || asset.pendingMultiplierEffectiveTime) {
        errors.push(`${entry.symbol}: Robinhood asset has a pending multiplier change`);
      }
      const deployment = asset.deployments.find(({ chainId }) => chainId === ROBINHOOD_CHAIN_ID);
      if (!deployment) {
        errors.push(`${entry.symbol}: no Robinhood Chain deployment found`);
      } else if (normalized(deployment.contractAddress) !== normalized(entry.token)) {
        errors.push(`${entry.symbol}: token address differs from live Robinhood registry`);
      }
    }

    const expectedFeedName = `Robinhood ${entry.symbol} / USD`;
    const feed = feeds.find((candidate) => candidate.name === expectedFeedName);
    if (!feed) {
      errors.push(`${entry.symbol}: missing Chainlink feed named ${expectedFeedName}`);
      continue;
    }
    if (normalized(feed.proxyAddress) !== normalized(entry.primaryFeed)) {
      errors.push(`${entry.symbol}: primary feed differs from live Chainlink registry`);
    }
    if (normalized(feed.secondaryProxyAddress) !== normalized(entry.secondaryFeed)) {
      errors.push(`${entry.symbol}: secondary feed differs from live Chainlink registry`);
    }
    if (feed.heartbeat !== EXPECTED_FEED_HEARTBEAT) {
      errors.push(`${entry.symbol}: expected ${EXPECTED_FEED_HEARTBEAT}s heartbeat, found ${feed.heartbeat}s`);
    }
    if (feed.decimals !== EXPECTED_FEED_DECIMALS) {
      errors.push(`${entry.symbol}: expected ${EXPECTED_FEED_DECIMALS} feed decimals, found ${feed.decimals}`);
    }
    if (feed.threshold !== 0.5) {
      errors.push(`${entry.symbol}: expected 0.5% deviation threshold, found ${feed.threshold}%`);
    }
  }

  return errors;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function main(): Promise<void> {
  const source = await readFile(resolve(__dirname, "../src/StockTokens/StockTokenConfig.sol"), "utf8");
  const [assetResponse, feeds] = await Promise.all([
    fetchJson<{ assets: RobinhoodAsset[] }>(ROBINHOOD_ASSETS_URL),
    fetchJson<ChainlinkFeed[]>(CHAINLINK_FEEDS_URL),
  ]);
  const manifest = parseManifest(source);
  const errors = validateRegistry(manifest, assetResponse.assets, feeds);

  if (errors.length > 0) {
    throw new Error(`Stock Token registry preflight failed:\n- ${errors.join("\n- ")}`);
  }
  console.log(`Stock Token registry preflight passed for ${manifest.length} branches.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
