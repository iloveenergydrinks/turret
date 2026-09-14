import { isAddress, type Address, type Hex, type Transaction, type TransactionReceipt } from "viem";
import type { P2PClient } from "./client";
import { validPendingIntent, type PendingRecord } from "./pending-transactions";

const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const validHash = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
export type RecoveredPending = { hash: Hex; receipt: TransactionReceipt; equivalent: boolean; cancelled: boolean };

/** Locate the canonical transaction consuming the saved nonce. Historical nonce
 * bisection avoids walking every block since a browser was closed. Providers that
 * cannot serve historical state get a bounded 64-block fallback and a manual hash path.
 * A different successful call clears only the consumed nonce, never reports our action successful.
 */
export async function recoverPendingTransaction(publicClient: P2PClient["publicClient"], record: PendingRecord, account: Address, options: {
  replacementHash?: Hex; getAccount?: () => Address | null;
} = {}): Promise<RecoveredPending | null> {
  const intent = record.intent;
  if (!intent || !validPendingIntent(intent) || !same(intent.from, account)) throw new Error("The saved transaction has no verified original nonce for this wallet. Check the original transaction in your wallet.");
  const check = () => { if (options.getAccount && !same(options.getAccount(), account)) throw new Error("Wallet changed while recovering a pending transaction."); };
  const error = () => new Error("The saved nonce has been used, but its transaction could not be found in the available RPC history. Enter the replacement transaction hash from your wallet to verify it.");
  check();
  const head = await publicClient.getBlock();
  if (head.number === null || !validHash(head.hash)) throw new Error("A canonical block is unavailable for pending recovery.");
  const canonical = async () => {
    check();
    if (!same((await publicClient.getBlock({ blockNumber: head.number! })).hash, head.hash!)) throw new Error("The chain changed during pending recovery. Retry transaction status.");
    check();
  };
  const verify = async (transaction: Transaction): Promise<RecoveredPending> => {
    check();
    if (!validHash(transaction.hash) || !same(transaction.from, account) || transaction.nonce !== intent.nonce
      || (transaction.to !== null && !isAddress(transaction.to ?? "", { strict: false })) || typeof transaction.value !== "bigint"
      || typeof transaction.input !== "string" || !/^0x(?:[0-9a-f]{2})*$/i.test(transaction.input)) {
      throw new Error("That transaction does not consume the saved wallet's original nonce.");
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: transaction.hash });
    if (!same(receipt.transactionHash, transaction.hash) || !same(receipt.from, account)
      || (transaction.to === null ? receipt.to !== null : !same(receipt.to, transaction.to))
      || !validHash(receipt.blockHash) || typeof receipt.blockNumber !== "bigint" || receipt.blockNumber > head.number!
      || !["success", "reverted"].includes(receipt.status)) throw new Error("Replacement transaction receipt could not be verified.");
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (!same(block.hash, receipt.blockHash) || !block.transactions.some(row => same(row, transaction.hash))) {
      throw new Error("The replacement receipt is not in the canonical block. Retry transaction status.");
    }
    await canonical();
    return { hash: transaction.hash, receipt,
      equivalent: same(transaction.to, intent.to) && same(transaction.input, intent.input) && transaction.value === BigInt(intent.value),
      cancelled: same(transaction.to, account) && transaction.input === "0x" && transaction.value === 0n };
  };
  if (options.replacementHash) {
    if (!validHash(options.replacementHash)) throw new Error("Enter a valid replacement transaction hash.");
    return verify(await publicClient.getTransaction({ hash: options.replacementHash }));
  }
  // Direct lookup is cheap and covers a normal mined transaction on reopening.
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: record.hash });
    if (receipt) return await verify(await publicClient.getTransaction({ hash: record.hash }));
  } catch (cause) {
    check();
    // If a returned receipt could not be validated, do not turn it into success.
    // The canonical nonce search below must independently find and verify a candidate.
  }
  const nonce = await publicClient.getTransactionCount({ address: account, blockNumber: head.number });
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("The wallet's canonical nonce is unavailable. Retry transaction status.");
  if (nonce <= intent.nonce) { await canonical(); return null; }
  let candidate: Transaction | undefined;
  try {
    let lower = 0n, upper = head.number;
    for (let probe = 0; lower < upper && probe < 64; probe++) {
      check();
      const middle = lower + (upper - lower) / 2n;
      const count = await publicClient.getTransactionCount({ address: account, blockNumber: middle });
      if (!Number.isSafeInteger(count) || count < 0) throw error();
      if (count > intent.nonce) upper = middle; else lower = middle + 1n;
    }
    if (lower !== upper) throw error();
    const block = await publicClient.getBlock({ blockNumber: lower, includeTransactions: true });
    candidate = block.transactions.find(tx => same(tx.from, account) && tx.nonce === intent.nonce) as Transaction | undefined;
  } catch { check(); /* Historical state may be unavailable; try a bounded recent scan. */ }
  if (!candidate) {
    const floor = head.number > 63n ? head.number - 63n : 0n;
    for (let height = head.number; height >= floor; height--) {
      check();
      try {
        const block = await publicClient.getBlock({ blockNumber: height, includeTransactions: true });
        candidate = block.transactions.find(tx => same(tx.from, account) && tx.nonce === intent.nonce) as Transaction | undefined;
      } catch { throw error(); }
      if (candidate) break;
    }
  }
  if (!candidate) { await canonical(); throw error(); }
  return verify(candidate);
}
