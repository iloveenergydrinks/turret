import { getAddress, keccak256, parseAbi } from 'viem';
import { quoteCashback } from '../../../shared/borrower-cashback.mjs';

const abi = parseAbi(['function usdg() view returns(address)', 'function pool() view returns(address)',
  'function accountingVersion() view returns(uint256)', 'function asset() view returns(address)',
  'function borrowAprBps() view returns(uint16)', 'function rewardToken() view returns(address)',
  'function startsAt() view returns(uint64)', 'function endsAt() view returns(uint64)', 'function WALLET_CAP() view returns(uint256)', 'function BUDGET_CAP() view returns(uint256)', 'function engineCount() view returns(uint256)', 'function eligibleEngine(address) view returns(bool)',
  'function settlementDeadline() view returns(uint64)', 'function claimDeadline() view returns(uint64)',
  'function REBATE_BPS() view returns(uint256)', 'function decimals() view returns(uint8)']);

export async function verifyRuntimeConfig(client, config) {
  if (![config.chainId,config.startBlock,config.confirmations].every(Number.isSafeInteger)
    || config.chainId <= 0 || config.startBlock < 0 || config.confirmations < 0
    || (config.chainId !== 31337 && config.confirmations === 0)) throw new Error('Invalid chain history or confirmation policy');
  if (await client.getChainId() !== config.chainId) throw new Error('Configured RPC is on another chain');
  quoteCashback({principal:0n, aprBps:0, days:0, now:config.policy.startsAt, campaign:config.policy});
  const block = await client.getBlock();
  const read = (address,functionName,args=[]) => client.readContract({address:getAddress(address),abi,functionName,args,blockNumber:block.number});
  const code = async (address,expected) => {
    const runtime = await client.getCode({address:getAddress(address),blockNumber:block.number});
    if (!runtime || keccak256(runtime) !== expected) throw new Error('Pinned contract runtime mismatch');
  };
  await code(config.distributor,config.runtimeHash);
  if (config.startBlock > 0) {
    const before = await client.getCode({address:getAddress(config.distributor),blockNumber:BigInt(config.startBlock - 1)});
    if (before && before !== '0x') throw new Error('History must include the campaign deployment');
  }
  const token = getAddress(config.rewardToken);
  if (getAddress(await read(config.distributor,'rewardToken')) !== token || await read(token,'decimals') !== 6)
    throw new Error('Campaign must pay the configured six-decimal USDG');
  for (const field of ['startsAt','endsAt','settlementDeadline','claimDeadline'])
    if (await read(config.distributor,field) !== BigInt(config.policy[field])) throw new Error('Campaign dates mismatch');
  if (await read(config.distributor,'REBATE_BPS') !== 5000n) throw new Error('Campaign rate mismatch');
  const engines = Object.entries(config.policy.engines);
  if (!engines.length || engines.length > 64) throw new Error('Invalid eligible market registry');
  if (config.policy.walletCap !== undefined) {
    if (config.policy.walletCap !== '25000000'
      || await read(config.distributor,'WALLET_CAP') !== 25_000000n
      || await read(config.distributor,'BUDGET_CAP') !== 1000_000000n
      || await read(config.distributor,'engineCount') !== BigInt(engines.length)) throw new Error('Public enrollment policy mismatch');
    for (const [engine] of engines)
      if (!await read(config.distributor,'eligibleEngine',[getAddress(engine)])) throw new Error('Public enrollment market mismatch');
  }
  await Promise.all(engines.map(async ([engine,market]) => {
    await code(engine,market.runtimeHash); await code(market.pool,market.poolRuntimeHash);
    if (getAddress(await read(engine,'usdg')) !== token || getAddress(await read(market.pool,'asset')) !== token
      || getAddress(await read(engine,'pool')) !== getAddress(market.pool)
      || await read(engine,'accountingVersion') !== 2n || await read(market.pool,'borrowAprBps') !== market.aprBps)
      throw new Error('Market accounting configuration mismatch');
    if (config.startBlock > 0) {
      const before = await client.getCode({address:getAddress(engine),blockNumber:BigInt(config.startBlock - 1)});
      if (before && before !== '0x') throw new Error('History must start before every enrolled engine was deployed');
    }
  }));
}
