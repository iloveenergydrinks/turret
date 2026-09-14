import { rewardsForPool, verifiedStakedShares } from '../lending/rewards/client';
import {
  createPublicClient, getAddress, http, isAddress, keccak256, parseAbi,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { P2P_ASSETS, P2P_USDG } from "../p2p/asset-catalog";
import { loadP2PRegistry, P2PClient, type P2PRegistry } from "../p2p/client";
import { NFTClient, validateNFTConfig } from "../nft/client";
import type { P2PMarket, PoolMarket, PortfolioSource } from "./model";

const poolAbi = parseAbi([
  "function asset() view returns(address)", "function creditEngine() view returns(address)",
  "function collateralToken() view returns(address)", "function balanceOf(address) view returns(uint256)",
  "function maxWithdraw(address) view returns(uint256)", "function previewRedeem(uint256) view returns(uint256)",
]);
const engineAbi = parseAbi([
  "function usdg() view returns(address)", "function pool() view returns(address)",
  "function collateralToken() view returns(address)",
  "function positions(address) view returns(uint256,uint256,uint256,uint256,uint256)",
  "function positionDebt(address) view returns(uint256)",
]);
const tokenAbi = parseAbi(["function decimals() view returns(uint8)"]);
type PoolDeployment = {
  chainId: 4663; symbol: string; admission?: "active" | "commissioning" | "legacy";
  engine: Address; pool: Address; collateral: Address; collateralDecimals: number;
  hashes: Record<"engine" | "pool" | "collateral" | "usdg", Hex>;
};
type Reads = Pick<PublicClient, "getChainId" | "getBlock" | "getCode" | "readContract">;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
function demand(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const validAddress = (value: unknown): value is Address => typeof value === "string" && isAddress(value) && !/^0x0{40}$/i.test(value);

// This registry describes positions only. Oracle admission and signing checks
// remain in the Borrow/Earn transaction paths and are not inferred here.
export function parsePoolRegistry(value: unknown): PoolDeployment[] {
  const registry = value as { schemaVersion?: unknown; markets?: unknown[] } | null;
  demand(registry?.schemaVersion === 1 && Array.isArray(registry.markets) && registry.markets.length <= 1024,
    "Pool configuration is unavailable or invalid. Retry loading your pools.");
  const seen = new Set<string>();
  return registry.markets.map(value => {
    const row = value as Partial<PoolDeployment> | null;
    const asset = P2P_ASSETS.find(asset => asset.symbol === row?.symbol);
    demand(row && row.chainId === 4663 && asset && same(row.collateral, asset.address)
      && [row.engine, row.pool, row.collateral].every(validAddress)
      && (row.admission === undefined || ["active", "commissioning", "legacy"].includes(row.admission)),
    "A pool does not match the reviewed token identities.");
    const addresses = [row.engine!, row.pool!, row.collateral!, P2P_USDG].map(address => address.toLowerCase());
    demand(new Set(addresses).size === addresses.length, "Pool identities overlap.");
    for (const address of addresses.slice(0, 2)) {
      demand(!seen.has(address), "Duplicate pool configuration."); seen.add(address);
    }
    for (const key of ["engine", "pool", "collateral", "usdg"] as const) {
      demand(typeof row.hashes?.[key] === "string" && /^0x[\da-f]{64}$/i.test(row.hashes[key])
        && !/^0x0{64}$/i.test(row.hashes[key]), "A pool is missing its reviewed runtime identity.");
    }
    const collateralDecimals = row.collateralDecimals ?? 18;
    demand(Number.isInteger(collateralDecimals) && collateralDecimals >= 0 && collateralDecimals <= 36,
      "Invalid pool token precision.");
    return { ...row, collateralDecimals } as PoolDeployment;
  });
}
async function loadPools(): Promise<unknown> {
  const response = await fetch("/portfolio-pools.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load the pool configuration. Retry loading your pools.");
  return response.json();
}
function poolClient(): Reads {
  return createPublicClient({ transport: http(new URL("/api/rpc", window.location.origin).href,
    { retryCount: 1, timeout: 10_000, batch: { batchSize: 50, wait: 8 } }) });
}

// Share only block-pinned identity work, never account balances. Both expiry
// and a size bound keep mounted sessions bounded; rejected reads are evicted.
function readCache() {
  const cache = new Map<string, { expires: number; result: Promise<unknown> }>();
  return <T>(key: string, ttl: number, read: () => Promise<T>): Promise<T> => {
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.result as Promise<T>;
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    const result = Promise.resolve().then(read);
    cache.set(key, { expires: Date.now() + ttl, result });
    void result.catch(() => { if (cache.get(key)?.result === result) cache.delete(key); });
    return result;
  };
}
export function createPoolSource(options: { client?: Reads; load?: () => Promise<unknown> } = {}): PortfolioSource {
  let client = options.client;
  const cached = readCache();
  return { id: "pools", label: "Lending pools", discover: async () => {
    const rows = parsePoolRegistry(await (options.load ?? loadPools)());
    client ??= poolClient();
    const rpc = client;
    return rows.map((deployment): PoolMarket => ({
      id: `pool:4663:${deployment.engine.toLowerCase()}`, kind: "pool", symbol: deployment.symbol,
      name: P2P_ASSETS.find(asset => asset.symbol === deployment.symbol)!.name,
      legacy: deployment.admission === "legacy", engine: deployment.engine, collateralDecimals: deployment.collateralDecimals,
      read: async account => {
        demand(validAddress(account), "Connect a valid wallet to load your portfolio.");
        demand(await cached("chain", 1000, () => rpc.getChainId()) === 4663, "The pool connection is on the wrong chain.");
        const block = await cached("latest", 500, () => rpc.getBlock());
        demand(block.number !== null && block.hash !== null && block.timestamp <= BigInt(Number.MAX_SAFE_INTEGER), "A mined pool snapshot is unavailable.");
        const blockNumber = block.number;
        const blockKey = `${blockNumber}:${block.hash}`;
        const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
          rpc.readContract({ address, abi, functionName, args, blockNumber }) as Promise<T>;
        const identity = <T>(address: Address, abi: Abi, functionName: string) =>
          cached(`${blockKey}:binding:${address.toLowerCase()}:${functionName}`, 10_000, () => read<T>(address, abi, functionName));
        const checkCode = async (key: "engine" | "pool" | "collateral" | "usdg") => {
          const address = key === "usdg" ? P2P_USDG : deployment[key];
          await cached(`${blockKey}:code:${address.toLowerCase()}:${deployment.hashes[key]}`, 10_000, async () => {
            const code = await rpc.getCode({ address, blockNumber });
            demand(code && code !== "0x" && same(keccak256(code), deployment.hashes[key]), "The pool runtime does not match its reviewed deployment.");
          });
        };
        const canonical = async () => {
          const current = await cached(`canonical:${blockKey}`, 500, () => rpc.getBlock({ blockNumber }));
          demand(current.hash === block.hash, "The pool snapshot changed. Retry this market.");
        };
        const rewards = rewardsForPool(deployment.pool);
        const [position, walletShares, stakedShares] = await Promise.all([
          read<readonly bigint[]>(deployment.engine, engineAbi, "positions", [account]),
          read<bigint>(deployment.pool, poolAbi, "balanceOf", [account]),
          rewards ? verifiedStakedShares(rpc, rewards, getAddress(account), blockNumber) : 0n,
          checkCode("engine"), checkCode("pool"),
        ]);
        const shares = walletShares + stakedShares;
        demand(Array.isArray(position) && position.length === 5 && [...position, shares].every(value => typeof value === "bigint" && value >= 0n),
          "The pool returned invalid position data.");
        // Reviewed engine code defines debt from principal + interest. An old
        // updatedAt alone is not a position; principal/interest/remainder must
        // also be empty before skipping the detailed debt and token reads.
        if (shares === 0n && position.slice(0, 4).every(value => value === 0n)) {
          await canonical();
          return { kind: "pool", account: getAddress(account), now: Number(block.timestamp), blockNumber,
            collateral: 0n, debt: 0n, shares: 0n, lendingAssets: 0n, maxWithdraw: 0n };
        }
        const [bindings, debt, maxWithdraw, lendingAssets] = await Promise.all([
          Promise.all([
            identity<Address>(deployment.engine, engineAbi, "usdg"), identity<Address>(deployment.engine, engineAbi, "pool"),
            identity<Address>(deployment.engine, engineAbi, "collateralToken"), identity<Address>(deployment.pool, poolAbi, "asset"),
            identity<Address>(deployment.pool, poolAbi, "creditEngine"), identity<Address>(deployment.pool, poolAbi, "collateralToken"),
            identity<number>(P2P_USDG, tokenAbi, "decimals"), identity<number>(deployment.collateral, tokenAbi, "decimals"),
            identity<number>(deployment.pool, tokenAbi, "decimals"),
          ]),
          read<bigint>(deployment.engine, engineAbi, "positionDebt", [account]),
          read<bigint>(deployment.pool, poolAbi, "maxWithdraw", [account]),
          shares === 0n ? 0n : read<bigint>(deployment.pool, poolAbi, "previewRedeem", [shares]),
          checkCode("collateral"), checkCode("usdg"),
        ]);
        demand([P2P_USDG, deployment.pool, deployment.collateral, P2P_USDG, deployment.engine, deployment.collateral]
          .every((value, index) => same(bindings[index], value)) && bindings[6] === 6
          && bindings[7] === deployment.collateralDecimals && bindings[8] === 12,
        "Pool token bindings do not match its configuration.");
        demand([debt, maxWithdraw, lendingAssets].every(value => typeof value === "bigint" && value >= 0n),
          "The pool returned invalid position data.");
        await canonical();
        return { kind: "pool", account: getAddress(account), now: Number(block.timestamp), blockNumber,
          collateral: position[0]!, debt, shares, lendingAssets, maxWithdraw };
      },
    }));
  } };
}

export function createP2PSource(load: () => Promise<P2PRegistry> = loadP2PRegistry): PortfolioSource {
  return { id: "p2p", label: "P2P loans", discover: async () => {
    const registry = await load();
    let sharedReads: P2PClient | undefined;
    return registry.markets.map((deployment): P2PMarket => ({
      id: `p2p:${deployment.chainId}:${deployment.address.toLowerCase()}`, kind: "p2p", symbol: deployment.collateralSymbol,
      name: deployment.collateralName ?? deployment.collateralSymbol, legacy: deployment.legacy === true || (deployment.version !== 2 && deployment.version !== 3),
      deployment, read: async (account, cursor) => {
        demand(validAddress(account), "Connect a valid wallet to load your portfolio.");
        // Never mutate the account on a shared client while another wallet's
        // request is pending. Only the read transport is shared between reads.
        const client = new P2PClient(deployment, sharedReads);
        sharedReads ??= client;
        client.account = getAddress(account);
        const snapshot = await client.snapshot(cursor);
        demand(same(snapshot.account, account), "Wallet changed while loading. Retry your portfolio.");
        return { kind: "p2p", account: snapshot.account, now: snapshot.now, blockNumber: snapshot.blockNumber,
          offers: snapshot.offers, credits: snapshot.credits, nextCursor: snapshot.nextCursor,
          nominalCredits: snapshot.nominalCredits, creditsComplete: snapshot.creditsComplete,
          activeLoansComplete: snapshot.activeLoansComplete, activeLoansMessage: snapshot.activeLoansMessage };
      },
    }));
  } };
}

export function createNFTSource(): PortfolioSource {
  return { id: "nft", label: "NFT P2P loans", discover: async () => {
    const response = await fetch("/nft-market.json", { cache: "no-store" });
    if (response.status === 404) return [];
    if (!response.ok) throw Error("NFT loan configuration is unavailable. Retry your portfolio.");
    const deployment = validateNFTConfig(await response.json());
    const client = new NFTClient(deployment);
    return [{ id: `nft:${deployment.chainId}:${deployment.address.toLowerCase()}`, kind: "nft", symbol: "NFT",
      name: "NFT P2P loans", legacy: false, deployment, read: async (account, cursor) => {
        const block = await client.verify();
        const page = await client.accountOffers(account, cursor, block.number);
        if ((await client.publicClient.getBlock({ blockNumber: block.number })).hash !== block.hash) throw Error("NFT portfolio snapshot changed. Refresh.");
        return { kind: "nft", account, now: Number(block.timestamp), blockNumber: block.number,
          offers: page.offers, nextCursor: page.more ? page.nextCursor : null };
      } }];
  } };
}
export const createPortfolioSources = (): readonly PortfolioSource[] => [createPoolSource(), createP2PSource(), createNFTSource()];
