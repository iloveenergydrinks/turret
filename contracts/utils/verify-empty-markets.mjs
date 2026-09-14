// Read-only retirement check. No wallet, signer, approvals or transactions.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createPublicClient, http, parseAbi} from 'viem';

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const zero = value => value !== undefined && BigInt(value) === 0n;

export function assessRetirement(markets, legacy) {
  assert.ok(markets.length > 0, 'Market inventory is required');
  const noLoans = markets.every(m => zero(m.activeDebtPositions) && zero(m.principal) && zero(m.interest)
    && zero(m.pendingInterest)) && legacy.every(v => zero(v.debt));
  const noCollateral = markets.every(m => m.collateralBalances?.length === 3 && m.collateralBalances.every(zero))
    && legacy.every(v => v.collateralBalances?.length > 0 && v.collateralBalances.every(zero));
  const ownerOnlyShares = markets.every(m => m.shares !== undefined && m.ownerShares !== undefined
    && BigInt(m.shares) === BigInt(m.ownerShares));
  const noFunds = markets.every(m => zero(m.shares) && zero(m.cash) && zero(m.fees)
    && zero(m.engineCash) && zero(m.exitCash)) && legacy.every(v => zero(v.cash));
  const admissionPaused = markets.every(m => m.paused === true) && legacy.every(v => v.paused === true);
  return {noLoans, noCollateral, ownerOnlyShares, noFunds, admissionPaused,
    retirementStateClear: noLoans && noCollateral && noFunds && admissionPaused};
}

export async function inspectEmptyMarkets({inventory, rpc, witnessRpc, now = Date.now}) {
  assert.equal(inventory.chainId, 4663);
  const clients = [rpc, witnessRpc].filter(Boolean).map(url => createPublicClient({
    transport: http(url, {timeout: 15000, retryCount: 1, batch: {batchSize: 25, wait: 10}}), cacheTime: 0,
  }));
  assert.ok(clients.length > 0);
  if (witnessRpc) assert.notEqual(rpc, witnessRpc, 'Witness must be a different endpoint');
  const heads = await Promise.all(clients.map(async c => {
    assert.equal(await c.getChainId(), inventory.chainId);
    const h = await c.getBlock();
    assert.ok(Math.abs(now() / 1000 - Number(h.timestamp)) < 60, 'RPC head is not fresh');
    return h;
  }));
  const number = heads.reduce((n, h) => h.number < n ? h.number : n, heads[0].number);
  const client = clients[0], head = await client.getBlock({blockNumber: number});
  for (const c of clients) assert.equal((await c.getBlock({blockNumber: number})).hash, head.hash);
  const read = (address, signature, functionName, args = []) => client.readContract({
    address, abi: parseAbi([signature]), functionName, args, blockNumber: number,
  });
  const uint = (address, name) => read(address, `function ${name}() view returns(uint256)`, name);
  const address = (target, name) => read(target, `function ${name}() view returns(address)`, name);
  const bool = (target, name) => read(target, `function ${name}() view returns(bool)`, name);
  const balance = (token, holder) => read(token, 'function balanceOf(address) view returns(uint256)', 'balanceOf', [holder]);
  const seen = new Set();
  const requireCode = async target => {
    assert.ok(!seen.has(target.toLowerCase()), 'Duplicate deployment address');
    seen.add(target.toLowerCase());
    const code = await client.getCode({address: target, blockNumber: number});
    assert.ok(code && code !== '0x', 'Deployment has no code');
  };
  const markets = [];
  for (const m of inventory.markets) {
    const {engine, pool, exit} = m.addresses;
    for (const target of [engine, pool, exit]) await requireCode(target);
    const [boundPool, boundEngine, owner, usdg, collateral, asset] = await Promise.all([
      address(engine, 'pool'), address(pool, 'creditEngine'), address(engine, 'owner'),
      address(engine, 'usdg'), address(engine, 'collateralToken'), address(pool, 'asset'),
    ]);
    assert.ok(same(boundPool, pool) && same(boundEngine, engine) && same(asset, usdg), 'Broken market wiring');
    assert.ok(same(usdg, m.engine.usdg) && same(collateral, m.engine.collateralToken), 'Inventory asset mismatch');
    const [paused, activeDebtPositions, principal, interest, pendingInterest, cash, fees, shares, ownerShares,
      ownerMaxWithdraw, engineCash, exitCash, collateralBalances] = await Promise.all([
      bool(engine, 'riskPaused'), uint(engine, 'activeDebtPositions'), uint(pool, 'outstandingPrincipal'),
      uint(pool, 'interestReceivable'), uint(pool, 'pendingInterest'), balance(usdg, pool), uint(pool, 'protocolFees'),
      uint(pool, 'totalSupply'), balance(pool, owner),
      read(pool, 'function maxWithdraw(address) view returns(uint256)', 'maxWithdraw', [owner]),
      balance(usdg, engine), balance(usdg, exit), Promise.all([engine, pool, exit].map(t => balance(collateral, t))),
    ]);
    markets.push({symbol: m.symbol, engine, pool, exit, owner, paused, activeDebtPositions, principal, interest,
      pendingInterest, cash, fees, shares, ownerShares, ownerMaxWithdraw, engineCash, exitCash, collateralBalances});
  }
  const legacy = [];
  for (const v of inventory.legacy) {
    await requireCode(v.address);
    const [owner, usdg, paused, debt, count] = await Promise.all([
      address(v.address, 'owner'), address(v.address, 'usdg'), bool(v.address, 'paused'),
      uint(v.address, 'totalDebt'), uint(v.address, 'collateralCount'),
    ]);
    assert.ok(count > 0n && count <= 256n, 'Unexpected legacy collateral count');
    const collateralBalances = [];
    for (let i = 0n; i < count; ++i) {
      const token = await read(v.address, 'function collateralAt(uint256) view returns(address)', 'collateralAt', [i]);
      collateralBalances.push(await balance(token, v.address));
    }
    legacy.push({address: v.address, owner, paused, debt, cash: await balance(usdg, v.address), collateralBalances});
  }
  // Reject a reorganization during inspection. Recheck after pausing and withdrawing
  // at cutover: an unpaused market may receive funds after this snapshot.
  for (const c of clients) assert.equal((await c.getBlock({blockNumber: number})).hash, head.hash);
  return {checkedAt: new Date(now()).toISOString(), chainId: inventory.chainId, blockNumber: number,
    blockHash: head.hash, blockTimestamp: head.timestamp, rpcCount: clients.length, broadcast: false,
    inventoryScope: 'Known deployments in the supplied inventory; not chain-wide discovery',
    summary: assessRetirement(markets, legacy), markets, legacy};
}

async function main() {
  const [inventoryPath, outputPath, ...extra] = process.argv.slice(2);
  assert.ok(inventoryPath && outputPath && extra.length === 0, 'Usage: node utils/verify-empty-markets.mjs INVENTORY OUTPUT');
  const report = await inspectEmptyMarkets({inventory: JSON.parse(readFileSync(inventoryPath, 'utf8')),
    rpc: process.env.AUDIT_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
    witnessRpc: process.env.AUDIT_WITNESS_RPC_URL});
  const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v, 2);
  writeFileSync(outputPath, `${json(report)}\n`);
  console.log(json({output: outputPath, blockNumber: report.blockNumber, rpcCount: report.rpcCount, ...report.summary}));
  if (!report.summary.retirementStateClear) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  // Provider errors may contain credentials. Do not print the transport or stack.
  console.error(JSON.stringify({error: error.name, verification: 'failed', broadcast: false}));
  process.exitCode = 1;
});
