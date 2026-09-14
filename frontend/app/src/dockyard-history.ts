import {
  type Address,
  decodeEventLog,
  formatUnits,
  type Hash,
  pad,
  parseAbi,
  type PublicClient,
  toEventSelector,
  toHex,
} from "viem";
import { DOCKYARD_MARKETS } from "./dockyard-config";

// Verified creation receipt: 0xd13d4e0dd94af49542ff54d161758a68a16ddef6f17d0b98b28be5b501afb7ea.
export const HISTORY_CHAIN_ID = 4663;
export const HISTORY_VAULT = "0x576c510e9A268B06448f67598B7BF1ed33388e20" as const;
export const HISTORY_START_BLOCK = 52_112_699n;
// Replacement creation block verified in dockyard-pilot-heartbeat-deployed.json.
export const PILOT_HISTORY_VAULT = "0xb99D842DFFc140b9DD1927767653Bf21861120e9" as const;
export const PILOT_HISTORY_START_BLOCK = 52_900_462n;
// Execution-gated MVP creation receipt verified in dockyard-mvp-deployed.json.
export const MVP_HISTORY_VAULT = "0x24043E8EFaB262f5198B87b5AA5A46Bc72AADDD8" as const;
export const MVP_HISTORY_START_BLOCK = 52939342n;
export function historyStartBlock(chainId: number | undefined, vault: string | null | undefined): bigint | undefined {
  if (chainId !== HISTORY_CHAIN_ID || !vault) return undefined;
  if (vault.toLowerCase() === HISTORY_VAULT.toLowerCase()) return HISTORY_START_BLOCK;
  if (vault.toLowerCase() === PILOT_HISTORY_VAULT.toLowerCase()) return PILOT_HISTORY_START_BLOCK;
  if (vault.toLowerCase() === MVP_HISTORY_VAULT.toLowerCase()) return MVP_HISTORY_START_BLOCK;
  return undefined;
}

const CHUNK_BLOCKS = 10_000n;
const PAGE_BLOCKS = 100_000n;

export const dockyardHistoryAbi = parseAbi([
  "event CollateralDeposited(address indexed collateral, address indexed borrower, uint256 amount)",
  "event CollateralWithdrawn(address indexed collateral, address indexed borrower, address recipient, uint256 amount)",
  "event Borrowed(address indexed collateral, address indexed borrower, uint256 amount, uint256 fee, uint256 debt)",
  "event Repaid(address indexed collateral, address indexed borrower, address payer, uint256 amount, uint256 debt)",
  "event Liquidated(address indexed collateral, address indexed borrower, address indexed liquidator, uint256 repaid, uint256 collateralSeized)",
  "event BadDebtWrittenOff(address indexed collateral, address indexed borrower, uint256 amount)",
]);

export type HistoryEffect = { label: string; amount: bigint; symbol: string; decimals: number };
export type HistoryEntry = {
  id: string;
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number | null;
  market: string;
  title: string;
  liquidated: boolean;
  effects: HistoryEffect[];
};
export type HistoryPage = {
  entries: HistoryEntry[];
  fromBlock: bigint;
  toBlock: bigint;
  before: bigint | null;
};
type HistoryClient = Pick<PublicClient, "request" | "getBlock" | "getBlockNumber">;

export function formatHistoryAmount(amount: bigint, decimals: number) {
  // Never convert token amounts through Number: small transfers must not become zero.
  return formatUnits(amount, decimals);
}

export async function loadWalletHistory({
  client,
  wallet,
  vault,
  chainId,
  before,
  signal,
}: {
  client: HistoryClient;
  wallet: Address;
  vault: Address;
  chainId: number;
  before?: bigint;
  signal?: AbortSignal;
}): Promise<HistoryPage> {
  const deploymentBlock = historyStartBlock(chainId, vault);
  if (deploymentBlock === undefined) {
    throw new Error("History is not configured for this deployment.");
  }
  signal?.throwIfAborted();
  const toBlock = before ?? await client.getBlockNumber({ cacheTime: 0 });
  if (toBlock < deploymentBlock) {
    return { entries: [], fromBlock: deploymentBlock, toBlock, before: null };
  }
  const fromBlock = toBlock - PAGE_BLOCKS + 1n > deploymentBlock
    ? toBlock - PAGE_BLOCKS + 1n
    : deploymentBlock;
  const topics = [dockyardHistoryAbi.map(toEventSelector), null, pad(wallet)] as const;
  const groups = new Map<string, HistoryEntry & { events: Set<string> }>();

  // Fixed-size requests respect RPC range limits. Abort between chunks when a
  // wallet changes; a failed chunk rejects the page instead of hiding activity.
  for (let start = fromBlock; start <= toBlock; start += CHUNK_BLOCKS) {
    signal?.throwIfAborted();
    const end = start + CHUNK_BLOCKS - 1n < toBlock ? start + CHUNK_BLOCKS - 1n : toBlock;
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{ address: vault, fromBlock: toHex(start), toBlock: toHex(end), topics: [...topics] }],
    });
    for (const log of logs) {
      if (log.removed || !log.blockNumber || !log.transactionHash || !log.logIndex) continue;
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
      const blockNumber = BigInt(log.blockNumber);
      if (blockNumber < start || blockNumber > end) continue;
      const event = decodeEventLog({ abi: dockyardHistoryAbi, data: log.data, topics: log.topics });
      if (event.args.borrower.toLowerCase() !== wallet.toLowerCase()) continue;
      const market = DOCKYARD_MARKETS.find((item) =>
        item.address.toLowerCase() === event.args.collateral.toLowerCase()
      )?.symbol ?? `${event.args.collateral.slice(0, 6)}…${event.args.collateral.slice(-4)}`;
      const id = `${log.transactionHash}:${event.args.collateral.toLowerCase()}`;
      const entry = groups.get(id) ?? {
        id,
        transactionHash: log.transactionHash,
        blockNumber,
        logIndex: Number(BigInt(log.logIndex)),
        timestamp: null,
        market,
        title: "",
        liquidated: false,
        effects: [],
        events: new Set<string>(),
      };
      // Providers can return duplicate logs. An event identity is tx + log index,
      // not its name: multiple deposits in the same transaction remain distinct.
      const identity = `${event.eventName}:${log.logIndex}`;
      if (entry.events.has(identity)) continue;
      entry.events.add(identity);
      entry.events.add(event.eventName);
      entry.logIndex = Math.max(entry.logIndex, Number(BigInt(log.logIndex)));
      const effect = (label: string, amount: bigint, symbol = "USDG", decimals = 6) => {
        entry.effects.push({ label, amount, symbol, decimals });
      };
      switch (event.eventName) {
        case "CollateralDeposited":
          effect("Collateral deposited", event.args.amount, market, 18);
          break;
        case "CollateralWithdrawn":
          effect("Collateral withdrawn", event.args.amount, market, 18);
          break;
        case "Borrowed":
          effect("USDG received", event.args.amount);
          effect("One-time fee", event.args.fee);
          break;
        case "Repaid":
          effect("Debt repaid", event.args.amount);
          break;
        case "Liquidated":
          entry.liquidated = true;
          effect("Debt repaid by liquidator", event.args.repaid);
          effect("Collateral seized", event.args.collateralSeized, market, 18);
          break;
        case "BadDebtWrittenOff":
          effect("Bad debt written off", event.args.amount);
          break;
      }
      groups.set(id, entry);
    }
  }
  signal?.throwIfAborted();
  const timestamps = new Map<bigint, number | null>();
  for (const blockNumber of new Set([...groups.values()].map((entry) => entry.blockNumber))) {
    signal?.throwIfAborted();
    const block = await client.getBlock({ blockNumber }).catch(() => null);
    timestamps.set(blockNumber, block ? Number(block.timestamp) : null);
  }
  signal?.throwIfAborted();
  const entries = [...groups.values()].map(({ events, ...entry }) => ({
    ...entry,
    timestamp: timestamps.get(entry.blockNumber) ?? null,
    title: events.has("Liquidated")
      ? "Position liquidated"
      : events.has("Borrowed")
      ? "Borrowed USDG"
      : events.has("Repaid") && events.has("CollateralWithdrawn")
      ? "Repaid and withdrew"
      : events.has("Repaid")
      ? "Repaid USDG"
      : events.has("CollateralWithdrawn")
      ? "Withdrew collateral"
      : events.has("CollateralDeposited")
      ? "Deposited collateral"
      : "Bad debt written off",
  })).sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? b.logIndex - a.logIndex
      : a.blockNumber > b.blockNumber
      ? -1
      : 1
  );
  return { entries, fromBlock, toBlock, before: fromBlock > deploymentBlock ? fromBlock - 1n : null };
}
