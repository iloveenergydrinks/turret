import { isAddress, parseAbi, type Address, type Hex } from "viem";
import type { P2PClient } from "./client";

export type ActivityClient = Pick<P2PClient, "config" | "verify" | "publicClient">;
export type ActivityCursor = {
  account: Address; market: Address; chainId: number; anchor: bigint; anchorHash: Hex; before: bigint;
};
export type P2PActivityEntry = {
  key: string; market: Address; marketSymbol: string; chainId: number; version: number;
  transactionHash: Hex; logIndex: number; blockNumber: bigint; timestamp: number;
  action: string; loanId?: bigint; token?: Address; symbol?: string; decimals?: number;
  amount?: bigint; writtenOff?: bigint; actor?: Address; recipient?: Address; detail?: string;
};
export type ActivityPage = {
  entries: P2PActivityEntry[]; next: ActivityCursor | null;
  anchor: bigint; anchorHash: Hex; scannedFrom: bigint; scannedTo: bigint;
};

export const activityAbi = parseAbi([
  "event OfferCreated(uint256 indexed id,address indexed lender,address indexed borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt)",
  "event OfferAccepted(uint256 indexed id,uint256 dueAt,uint256 repaymentDeadline)",
  "event OfferClosed(uint256 indexed id,uint8 status)",
  "event LoanRepaid(uint256 indexed id,address indexed payer,uint256 amount)",
  "event LoanDefaulted(uint256 indexed id)",
  "event CreditAdded(address indexed token,address indexed account,uint256 amount)",
  "event Withdrawn(address indexed token,address indexed account,address indexed recipient,uint256 amount)",
  "event LoanCreditAdded(uint256 indexed id,address indexed token,address indexed account,uint256 amount)",
  "event LoanCreditSpent(uint256 indexed sourceId,uint256 indexed targetId,address indexed payer,uint256 amount)",
  "event LoanCreditWithdrawn(uint256 indexed id,address indexed token,address indexed account,address recipient,uint256 amount,uint256 writtenOff)",
  "event ExtensionProposed(uint256 indexed id,address indexed proposer,uint256 nonce,uint256 oldDeadline,uint256 newDeadline,uint256 expiresAt)",
  "event ExtensionCancelled(uint256 indexed id,uint256 nonce)",
  "event ExtensionAccepted(uint256 indexed id,address indexed accepter,uint256 nonce,uint256 oldDeadline,uint256 newDeadline)",
]);
const readAbi = parseAbi([
  "function offers(uint256) view returns (address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)",
  "function vaults(uint256) view returns (address)",
]);
const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const uint = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value < 2n ** 256n;
const zero = "0x0000000000000000000000000000000000000000";
type ActivityLog = {
  address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex;
  logIndex: number; removed: boolean; eventName: string; args: Record<string, unknown>;
};
type LoanParties = { lender: Address; borrower: Address; principal: bigint; collateral: bigint; recipient: Address };

/** A bounded, restartable scan. Every page stays at one canonical chain snapshot.
 * Logs are re-read after reload; local browser state is never the ledger's authority.
 * No page is advanced on a failed/truncated range, and no global completeness is inferred
 * until the deployment block is reached. V3's generic duplicate credit events are omitted.
 */
export async function readP2PActivity(client: ActivityClient, account: Address, options: {
  cursor?: ActivityCursor | null; signal?: AbortSignal; getAccount?: () => Address | null;
  blockSpan?: bigint; maxWindows?: number;
} = {}): Promise<ActivityPage> {
  const { config, publicClient } = client;
  const check = () => {
    if (options.signal?.aborted || (options.getAccount && !same(options.getAccount(), account))) {
      throw new Error("Activity loading was cancelled or the wallet changed.");
    }
  };
  check();
  if (!isAddress(account, { strict: false }) || same(account, zero) || !/^(0|[1-9]\d*)$/.test(config.startBlock)) {
    throw new Error("Invalid activity wallet or deployment block.");
  }
  const verified = await client.verify();
  const cursor = options.cursor;
  if (cursor && (!same(cursor.account, account) || !same(cursor.market, config.address) || cursor.chainId !== config.chainId
    || !uint(cursor.anchor) || !uint(cursor.before) || cursor.before > cursor.anchor || !hash(cursor.anchorHash)
    || cursor.anchor > verified.number)) throw new Error("Activity cursor belongs to another wallet, market or chain. Refresh activity.");
  const anchor = cursor?.anchor ?? verified.number, anchorHash = cursor?.anchorHash ?? verified.hash;
  const canonical = async () => {
    check();
    const block = await publicClient.getBlock({ blockNumber: anchor });
    if (block.number !== anchor || !same(block.hash, anchorHash)) throw new Error("Activity snapshot changed on-chain. Refresh activity before loading more.");
  };
  await canonical();
  const start = BigInt(config.startBlock), scannedTo = cursor?.before ?? anchor;
  if (start > anchor) throw new Error("This market has no activity at the verified block yet. Refresh shortly.");
  if (scannedTo < start) throw new Error("Activity cursor is before this market's deployment.");
  const span = options.blockSpan ?? 50_000n, maxWindows = options.maxWindows ?? 4;
  if (span < 1n || span > 200_000n || !Number.isInteger(maxWindows) || maxWindows < 1 || maxWindows > 8) throw new Error("Invalid activity scan bounds.");
  const events = activityAbi.filter(event => config.version === 3
    ? !["CreditAdded", "Withdrawn"].includes(event.name)
    : !event.name.startsWith("LoanCredit") && !event.name.startsWith("Extension"));
  let before = scannedTo, scannedFrom = scannedTo;
  const logs: ActivityLog[] = [];
  for (let window = 0; window < maxWindows && before >= start; window++) {
    check();
    let width = span, range: ActivityLog[] | undefined;
    // Shrink a dense/provider-limited range without ever skipping any block.
    for (let attempt = 0; attempt < 6; attempt++) {
      const from = before - width + 1n > start ? before - width + 1n : start;
      try {
        const found = await publicClient.getLogs({ address: config.address, events, fromBlock: from, toBlock: before, strict: true });
        if (found.length > 400) throw new Error("Activity range is too dense.");
        range = found as unknown as ActivityLog[]; scannedFrom = from; break;
      } catch {
        check();
        if (width === 1n || attempt === 5) throw new Error("Activity history could not be read completely. Retry this range; no older history was skipped.");
        width = width / 4n || 1n;
      }
    }
    if (!range) throw new Error("Activity history is unavailable.");
    for (const log of range) {
      if (!same(log.address, config.address) || log.removed || !hash(log.blockHash) || !hash(log.transactionHash)
        || !uint(log.blockNumber) || log.blockNumber < scannedFrom || log.blockNumber > before
        || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || !events.some(event => event.name === log.eventName)) {
        throw new Error("Activity RPC returned an invalid or noncanonical event. Refresh activity.");
      }
    }
    logs.push(...range);
    before = scannedFrom - 1n;
    if (logs.length >= 200) break;
  }
  const distinct = new Set(logs.map(log => `${log.transactionHash}:${log.logIndex}`));
  if (distinct.size !== logs.length) throw new Error("Activity RPC returned duplicate events. Retry loading.");
  const ids = new Set<bigint>();
  for (const log of logs) {
    const id = log.args.id ?? log.args.targetId;
    if (id !== undefined) {
      if (!uint(id) || id === 0n) throw new Error("Activity contains an invalid loan identifier.");
      ids.add(id);
    }
  }
  const loans = new Map<bigint, LoanParties>();
  const idList = [...ids];
  for (let offset = 0; offset < idList.length; offset += 8) {
    check();
    await Promise.all(idList.slice(offset, offset + 8).map(async id => {
      const [row, vault] = await Promise.all([
        publicClient.readContract({ address: config.address, abi: readAbi, functionName: "offers", args: [id], blockNumber: anchor }),
        config.version === 3 ? publicClient.readContract({ address: config.address, abi: readAbi, functionName: "vaults", args: [id], blockNumber: anchor }) : config.address,
      ]);
      if (!isAddress(row[0], { strict: false }) || same(row[0], zero) || !isAddress(row[1], { strict: false })
        || !uint(row[2]) || row[2] === 0n || !uint(row[3]) || row[8] < 1 || row[8] > 6 || !isAddress(vault, { strict: false }) || same(vault, zero)) throw new Error("Activity loan could not be verified.");
      loans.set(id, { lender: row[0], borrower: row[1], principal: row[2], collateral: row[3], recipient: vault });
    }));
  }
  const relevant = logs.filter(log => {
    const args = log.args, loan = loans.get((args.id ?? args.targetId) as bigint);
    if (["CreditAdded", "LoanCreditAdded", "LoanCreditSpent"].includes(log.eventName)) return same((args.account ?? args.payer) as string, account);
    if (["Withdrawn", "LoanCreditWithdrawn"].includes(log.eventName)) return same(args.account as string, account) || same(args.recipient as string, account);
    if (log.eventName === "OfferCreated") return same(args.lender as string, account) || same(args.borrower as string, account);
    return (loan && (same(loan.lender, account) || same(loan.borrower, account))) || same(args.payer as string, account);
  });
  const blocks = new Map<bigint, { hash: Hex; timestamp: number }>();
  const blockIds = [...new Set(relevant.map(log => log.blockNumber))];
  for (let offset = 0; offset < blockIds.length; offset += 8) {
    check();
    await Promise.all(blockIds.slice(offset, offset + 8).map(async blockNumber => {
      const block = await publicClient.getBlock({ blockNumber });
      if (block.number !== blockNumber || !hash(block.hash) || block.timestamp < 0n || block.timestamp > 8_640_000_000_000n) throw new Error("Activity timestamp could not be verified.");
      blocks.set(blockNumber, { hash: block.hash, timestamp: Number(block.timestamp) });
    }));
  }
  const entries: P2PActivityEntry[] = [];
  for (const log of relevant) {
    const block = blocks.get(log.blockNumber)!;
    if (!same(block.hash, log.blockHash)) throw new Error("Activity event was reorganized out of the chain. Refresh activity.");
    const args = log.args, loanId = (args.id ?? args.targetId) as bigint | undefined, loan = loanId ? loans.get(loanId) : undefined;
    const add = (action: string, fields: Partial<P2PActivityEntry> = {}) => entries.push({
      key: `${config.chainId}:${config.address.toLowerCase()}:${log.transactionHash}:${log.logIndex}:${entries.length}`,
      chainId: config.chainId, market: config.address, marketSymbol: config.collateralSymbol, version: config.version ?? 1,
      transactionHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, timestamp: block.timestamp, loanId, action, ...fields,
    });
    const token = (address: Address, amount: bigint) => {
      if (!uint(amount)) throw new Error("Activity contains an invalid amount.");
      if (same(address, config.loanToken)) return { token: address, amount, symbol: config.loanSymbol, decimals: config.loanDecimals };
      if (same(address, config.collateralToken)) return { token: address, amount, symbol: config.collateralSymbol, decimals: config.collateralDecimals };
      throw new Error("Activity contains an unexpected token.");
    };
    switch (log.eventName) {
      case "OfferCreated": add(same(args.lender as Address, account) ? "Offer funded" : "Private offer received", { actor: args.lender as Address, recipient: loan!.recipient, ...token(config.loanToken, args.principal as bigint) }); break;
      case "OfferAccepted":
        add("Loan principal delivered", { actor: loan!.borrower, recipient: loan!.borrower, ...token(config.loanToken, loan!.principal), detail: `Acceptance delivered principal funded by ${loan!.lender}.` });
        add("Collateral deposited", { actor: loan!.borrower, recipient: loan!.recipient, ...token(config.collateralToken, loan!.collateral) }); break;
      case "OfferClosed": add(args.status === 5 ? "Offer cancelled" : "Offer expired", { ...(args.status === 5 ? { actor: loan!.lender } : {}), detail: "Released funds are recorded as a separate withdrawal credit." }); break;
      case "LoanRepaid": add("Repayment settled", { actor: args.payer as Address, recipient: loan!.recipient, ...token(config.loanToken, args.amount as bigint), detail: "Full debt settled; may include credits. This is not necessarily a wallet debit." }); break;
      case "LoanDefaulted": add("Default settled", { recipient: loan!.lender, detail: "Collateral entitlement assigned to lender; withdrawal is a separate event." }); break;
      case "CreditAdded": case "LoanCreditAdded": add("Withdrawal credit added", { recipient: args.account as Address, ...token(args.token as Address, args.amount as bigint), detail: "Recorded entitlement, not a wallet transfer or a guarantee of current backing." }); break;
      case "Withdrawn": case "LoanCreditWithdrawn": add("Funds withdrawn", { actor: args.account as Address, recipient: args.recipient as Address, ...token(args.token as Address, args.amount as bigint), writtenOff: (args.writtenOff ?? 0n) as bigint }); break;
      case "LoanCreditSpent": add("Credit used for repayment", { actor: args.payer as Address, recipient: loan!.recipient, loanId: args.sourceId as bigint, ...token(config.loanToken, args.amount as bigint), detail: `Credit from loan #${args.sourceId} applied to loan #${args.targetId}. Included in that loan's repayment settlement.` }); break;
      case "ExtensionProposed": add("Deadline extension proposed", { actor: args.proposer as Address, detail: `Proposed final deadline: ${new Date(Number(args.newDeadline) * 1000).toISOString()}` }); break;
      case "ExtensionCancelled": add("Deadline proposal cancelled"); break;
      case "ExtensionAccepted": add("Deadline extension accepted", { actor: args.accepter as Address, detail: `New final deadline: ${new Date(Number(args.newDeadline) * 1000).toISOString()}` }); break;
    }
  }
  await canonical(); check();
  entries.sort((a, b) => a.blockNumber > b.blockNumber ? -1 : a.blockNumber < b.blockNumber ? 1 : b.logIndex - a.logIndex || a.key.localeCompare(b.key));
  return { entries, anchor, anchorHash, scannedFrom, scannedTo,
    next: before >= start ? { account, market: config.address, chainId: config.chainId, anchor, anchorHash, before } : null };
}

export function activityAmount(entry: Pick<P2PActivityEntry, "amount" | "decimals" | "symbol">) {
  if (entry.amount === undefined || entry.decimals === undefined) return "";
  const scale = 10n ** BigInt(entry.decimals), fraction = (entry.amount % scale).toString().padStart(entry.decimals, "0").replace(/0+$/, "");
  return `${entry.amount / scale}${fraction ? `.${fraction}` : ""}${entry.symbol ? ` ${entry.symbol}` : ""}`;
}

export function activityCsv(entries: readonly P2PActivityEntry[], account: Address) {
  const cell = (value: unknown) => {
    const text = String(value ?? "");
    return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };
  const header = ["wallet", "chain_id", "market", "market_symbol", "version", "timestamp_utc", "block", "transaction", "log_index", "loan_id", "action", "token", "amount_raw", "decimals", "amount", "actor", "recipient", "written_off_raw", "detail"];
  return [header, ...entries.map(entry => [account, entry.chainId, entry.market, entry.marketSymbol, entry.version,
    new Date(entry.timestamp * 1000).toISOString(), entry.blockNumber, entry.transactionHash, entry.logIndex, entry.loanId,
    entry.action, entry.token, entry.amount, entry.decimals, activityAmount(entry), entry.actor, entry.recipient, entry.writtenOff, entry.detail])]
    .map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const activityExplorer = (config: { chainId: number }, transactionHash: Hex) =>
  config.chainId === 4663 ? `https://explorer.mainnet.chain.robinhood.com/tx/${transactionHash}` : null;
