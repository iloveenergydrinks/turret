import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, parseAbi } from "viem";
import { isAccount, same, uint } from "./quotes.mjs";
import { inspectTokenBaseline, validateTokenBaseline } from "../p2p/health-core.mjs";

export const facilityFeeAbi = parseAbi([
  "event FeeCollected(uint256 indexed id,address indexed recipient,uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event ClaimedFeesForwarded(uint256 treasuryReportedFees,uint256 stakerShare)",
  "function forwardClaimedFees(uint256 grossFees)",
  "function treasury() view returns(address)", "function rewardToken() view returns(address)", "function staking() view returns(address)",
  "function distributor() view returns(address)", "function STAKER_SHARE_BPS() view returns(uint256)",
  "function totalCollected() view returns(uint256)", "function totalTreasuryReported() view returns(uint256)", "function totalDistributed() view returns(uint256)",
  "function feeRecipient() view returns(address)", "function loanToken() view returns(address)",
  "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function loans(uint256) view returns(address borrower,address vault,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 dueAt,uint256 lenderCredit,uint256 feeCredit,uint256 collateralCredit,uint8 status,bool defaultAcknowledged)",
]);
const isHash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const event = log => { try { return decodeEventLog({ abi: facilityFeeAbi, topics: log.topics, data: log.data, strict: true }); } catch { return null; } };
const eventsAt = (receipt, address, name) => receipt.logs.flatMap(log => {
  if (!same(log.address, address)) return []; const decoded = event(log);
  return decoded?.eventName === name ? [{ ...decoded.args, logIndex: log.logIndex }] : [];
});

/** Audits actual mined transfers, not nominal fee credits. A plan is never proof of forwarding.
 * Records are an operator-owned journal: assignments pair confirmed treasury remittances with exact fee receipt IDs.
 * Any unjournaled forwarding since the checkpoint blocks a new plan rather than guessing which receipts it paid.
 */
export async function reconcileFacilityFees({ client, config, collectionHashes, remittances = [], baseline, confirmations = 2n }) {
  if (!config || !Number.isSafeInteger(config.chainId) || config.chainId < 1 || !Array.isArray(config.facilities) || config.facilities.length > 100
    || ![config.treasury, config.router, config.staking, config.usdg].every(isAccount) || ![config.routerRuntimeHash, config.stakingRuntimeHash, config.usdgRuntimeHash].every(isHash)
    || !Array.isArray(collectionHashes) || collectionHashes.length > 100 || collectionHashes.some(value => !isHash(value))
    || new Set(collectionHashes.map(v => v.toLowerCase())).size !== collectionHashes.length || !Array.isArray(remittances) || remittances.length > 100
    || typeof confirmations !== "bigint" || confirmations < 2n || confirmations > 100n || !baseline || !isHash(baseline.blockHash)) throw new Error("Invalid fee reconciliation configuration.");
  const registry = new Map();
  validateTokenBaseline(config.tokenBaseline, config.chainId);
  const qualifiedUSDG = config.tokenBaseline.tokens.find(token => same(token.address, config.usdg));
  if (!qualifiedUSDG || qualifiedUSDG.decimals !== 6 || !same(qualifiedUSDG.runtimeHash, config.usdgRuntimeHash)) throw new Error("USDG fee token has not been qualified.");
  for (const entry of config.facilities) {
    if (!isAccount(entry.address) || !isHash(entry.runtimeHash) || registry.has(entry.address.toLowerCase())) throw new Error("Invalid fee facility identity.");
    registry.set(entry.address.toLowerCase(), entry);
  }
  if (await client.getChainId() !== config.chainId) throw new Error("Fee reconciliation chain mismatch.");
  const head = await client.getBlock();
  if (head.number === null || !head.hash || typeof head.timestamp !== "bigint" || Math.abs(Date.now() - Number(head.timestamp) * 1000) >= 30000) throw new Error("Current fee state is unavailable.");
  const start = uint(baseline.blockNumber), reportedAtStart = uint(baseline.totalTreasuryReported);
  if (start > head.number) throw new Error("Fee checkpoint is ahead of the chain.");
  const read = (address, functionName, args = [], blockNumber = head.number) => client.readContract({ address, abi: facilityFeeAbi, functionName, args, blockNumber });
  const checkCode = async (address, expected, blockNumber = head.number) => {
    const code = await client.getCode({ address, blockNumber });
    if (!code || !same(keccak256(code), expected)) throw new Error("Fee contract identity changed.");
  };
  const checkUSDG = async block => {
    const reason = await inspectTokenBaseline(client, qualifiedUSDG, block);
    if (reason) throw new Error(`USDG fee token verification failed: ${reason}`);
  };
  await checkUSDG(head);
  await Promise.all([checkCode(config.router, config.routerRuntimeHash), checkCode(config.staking, config.stakingRuntimeHash), checkCode(config.usdg, config.usdgRuntimeHash),
    ...config.facilities.map(entry => checkCode(entry.address, entry.runtimeHash))]);
  const [treasury, usdg, staking, distributor, share, collected, reported, distributed, balance, allowance] = await Promise.all([
    read(config.router, "treasury"), read(config.router, "rewardToken"), read(config.router, "staking"), read(config.staking, "distributor"), read(config.router, "STAKER_SHARE_BPS"),
    read(config.router, "totalCollected"), read(config.router, "totalTreasuryReported"), read(config.router, "totalDistributed"),
    read(config.usdg, "balanceOf", [config.treasury]), read(config.usdg, "allowance", [config.treasury, config.router]),
  ]);
  if (!same(treasury, config.treasury) || !same(usdg, config.usdg) || !same(staking, config.staking) || !same(distributor, config.router) || share !== 5000n
    || [collected, reported, distributed, balance, allowance].some(v => typeof v !== "bigint" || v < 0n) || distributed !== (collected + reported) / 2n) throw new Error("Fee router configuration or counters do not match.");
  if (!same((await client.getBlock({ blockNumber: start })).hash, baseline.blockHash)
    || await read(config.router, "totalTreasuryReported", [], start) !== reportedAtStart) throw new Error("Fee checkpoint is no longer canonical or its counter differs.");
  for (const entry of config.facilities) {
    if (!same(await read(entry.address, "feeRecipient"), config.treasury) || !same(await read(entry.address, "loanToken"), config.usdg)) throw new Error("Facility fees do not reach this USDG treasury.");
  }
  const receipt = async hash => {
    const value = await client.getTransactionReceipt({ hash });
    if (value.status !== "success" || !same(value.transactionHash, hash) || typeof value.blockNumber !== "bigint" || !isHash(value.blockHash)
      || !Number.isSafeInteger(value.transactionIndex) || value.transactionIndex < 0 || value.blockNumber <= start || head.number < value.blockNumber + confirmations
      || !same((await client.getBlock({ blockNumber: value.blockNumber })).hash, value.blockHash)) throw new Error("Fee receipt is reverted, unconfirmed, outside the checkpoint, or orphaned.");
    await checkUSDG(await client.getBlock({ blockNumber: value.blockNumber }));
    return value;
  };
  const receipts = new Map(), collections = new Map();
  // Bound RPC work: an operator submits batches of at most 100 receipt hashes.
  for (const hash of collectionHashes) {
    const value = await receipt(hash), ids = [];
    for (const entry of config.facilities) {
      const logs = eventsAt(value, entry.address, "FeeCollected");
      if (!logs.length) continue;
      await checkCode(entry.address, entry.runtimeHash, value.blockNumber);
      const vaultTransfers = new Map();
      for (const log of logs) {
        if (!same(log.recipient, config.treasury) || log.amount <= 0n || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) throw new Error("Invalid collected fee event.");
        const loan = await read(entry.address, "loans", [log.id], value.blockNumber);
        if (!isAccount(loan[1]) || loan[9] !== 2) throw new Error("Collected fee does not belong to a repaid loan.");
        const vault = loan[1].toLowerCase(); vaultTransfers.set(vault, (vaultTransfers.get(vault) ?? 0n) + log.amount);
        const id = `${config.chainId}:${entry.address.toLowerCase()}:${hash.toLowerCase()}:${log.logIndex}`;
        if (collections.has(id)) throw new Error("Duplicate collected fee receipt.");
        collections.set(id, { id, facility: entry.address, loanId: String(log.id), amount: log.amount, transactionHash: hash, logIndex: log.logIndex, blockNumber: value.blockNumber, blockHash: value.blockHash }); ids.push(id);
      }
      const transfers = eventsAt(value, config.usdg, "Transfer");
      for (const [vault, amount] of vaultTransfers) {
        const matched = transfers.filter(t => same(t.from, vault) && same(t.to, config.treasury)).reduce((sum, t) => sum + t.value, 0n);
        if (matched !== amount) throw new Error("Collected fee event does not match the actual USDG transfer.");
      }
    }
    if (!ids.length) throw new Error("No admitted facility fee was collected in this receipt.");
    receipts.set(hash.toLowerCase(), value);
  }
  const assigned = new Set(), remittanceHashes = new Set(); let forwarded = 0n;
  for (const record of remittances) {
    if (!isHash(record.hash) || remittanceHashes.has(record.hash.toLowerCase()) || !Array.isArray(record.collectionIds) || !record.collectionIds.length) throw new Error("Invalid or duplicate fee remittance.");
    remittanceHashes.add(record.hash.toLowerCase()); let gross = 0n;
    const value = await receipt(record.hash);
    await checkCode(config.router, config.routerRuntimeHash, value.blockNumber);
    await checkCode(config.staking, config.stakingRuntimeHash, value.blockNumber);
    for (const id of record.collectionIds) {
      const collected = collections.get(id);
      if (!collected || assigned.has(id) || collected.blockNumber > value.blockNumber || collected.blockNumber === value.blockNumber && receipts.get(collected.transactionHash.toLowerCase()).transactionIndex >= value.transactionIndex) throw new Error("Fee receipt is missing, already assigned, or collected after forwarding.");
      assigned.add(id); gross += collected.amount;
    }
    const transaction = await client.getTransaction({ hash: record.hash });
    let call; try { call = decodeFunctionData({ abi: facilityFeeAbi, data: transaction.input }); } catch { throw new Error("Invalid treasury remittance call."); }
    if (!same(transaction.from, config.treasury) || !same(transaction.to, config.router) || !same(value.from, config.treasury) || !same(value.to, config.router)
      || !same(transaction.hash, record.hash) || transaction.value !== 0n || call.functionName !== "forwardClaimedFees" || call.args[0] !== gross) throw new Error("Treasury remittance does not match the assigned fees.");
    const routed = eventsAt(value, config.router, "ClaimedFeesForwarded");
    if (routed.length !== 1 || routed[0].treasuryReportedFees !== gross || routed[0].stakerShare < gross / 2n || routed[0].stakerShare > (gross + 1n) / 2n) throw new Error("Fee routing event does not match.");
    const transfers = eventsAt(value, config.usdg, "Transfer"), stakerShare = routed[0].stakerShare;
    for (const [from, to] of [[config.treasury, config.router], [config.router, config.staking]]) {
      if (transfers.filter(t => same(t.from, from) && same(t.to, to)).reduce((sum, t) => sum + t.value, 0n) !== stakerShare) throw new Error("Staking remittance does not match actual USDG transfers.");
    }
    forwarded += gross;
  }
  if (reported !== reportedAtStart + forwarded) throw new Error("Unjournaled treasury forwarding detected. Reconcile it before routing more fees.");
  const unassigned = [...collections.values()].filter(c => !assigned.has(c.id)), gross = unassigned.reduce((sum, c) => sum + c.amount, 0n);
  if (!same((await client.getBlock({ blockNumber: head.number })).hash, head.hash) || Math.abs(Date.now() - Number(head.timestamp) * 1000) >= 30000) throw new Error("Fee audit changed or became stale.");
  const expectedStakerShare = (gross + (collected + reported) % 2n) / 2n;
  return { chainId: config.chainId, blockNumber: head.number, blockHash: head.hash, checkedAt: Date.now(), collected: [...collections.values()].reduce((sum, c) => sum + c.amount, 0n),
    forwarded, unassigned, gross, expectedStakerShare, maximumStakerShare: (gross + 1n) / 2n, treasuryBalance: balance, treasuryAllowance: allowance,
    routerTotalCollected: collected, routerTotalTreasuryReported: reported,
    readyToForward: gross > 0n && balance >= gross && allowance >= (gross + 1n) / 2n,
    plan: gross === 0n ? null : { from: config.treasury, to: config.router, value: 0n, data: encodeFunctionData({ abi: facilityFeeAbi, functionName: "forwardClaimedFees", args: [gross] }) } };
}
