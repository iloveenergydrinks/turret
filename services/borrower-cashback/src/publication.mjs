import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { join } from 'node:path';
import { verifyRuntimeConfig } from './config.mjs';
import { buildAllocation } from './merkle.mjs';
import { readAllocations, saveAllocation } from './archive.mjs';

const abi = parseAbi(['function operator() view returns(address)',
  'function enrollments(address,address) view returns(uint256 cap,uint64 startsAt)',
  'function publish(bytes32 root,uint256 throughBlock,bytes32 blockHash)']);

/** Produces a reviewable unsigned transaction. No wallet or signing key is loaded. */
export async function preparePublication({client,ledger,config,directory}) {
  await verifyRuntimeConfig(client,config);
  const head = ledger.head();
  const tip = await client.getBlock();
  if (!head || BigInt(head.number) > tip.number - BigInt(config.confirmations)
    || Number(tip.timestamp) - head.timestamp > 120
    || (await client.getBlock({blockNumber:BigInt(head.number)})).hash !== head.hash)
    throw new Error('Wait for the indexer to reach the confirmed canonical head');
  if (tip.timestamp > BigInt(config.policy.claimDeadline)) throw new Error('Campaign claims have expired');
  const accounts = ledger.accounts();
  for (const row of accounts) {
    const [cap,start] = await client.readContract({address:getAddress(config.distributor),abi,
      functionName:'enrollments',args:[row.borrower,row.engine],blockNumber:BigInt(head.number)});
    if (cap !== row.cap || Number(start) !== row.startsAt) throw new Error('Indexed enrollment differs from funded contract');
  }
  const built = buildAllocation({chainId:config.chainId,distributor:config.distributor,accounts});
  const old = readAllocations(directory).find(item=>item.root === built.root);
  const allocation = old ?? {...built,throughBlock:head.number,blockHash:head.hash};
  if (allocation.chainId !== config.chainId || getAddress(allocation.distributor) !== getAddress(config.distributor)
    || ledger.block(allocation.throughBlock)?.hash !== allocation.blockHash) throw new Error('Archived allocation lost its canonical anchor');
  const path = old ? join(directory,`${allocation.root}.json`) : saveAllocation(directory,allocation);
  const operator = await client.readContract({address:getAddress(config.distributor),abi,functionName:'operator'});
  const transaction = {to:getAddress(config.distributor),data:encodeFunctionData({abi,functionName:'publish',
    args:[allocation.root,BigInt(allocation.throughBlock),allocation.blockHash]})};
  await client.simulateContract({address:transaction.to,abi,functionName:'publish',account:operator,
    args:[allocation.root,BigInt(allocation.throughBlock),allocation.blockHash]});
  return {allocation,path,operator,chainId:config.chainId,transaction};
}
