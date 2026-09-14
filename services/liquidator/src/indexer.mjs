import { positionEvents } from './abi.mjs';

export async function syncPositions(chain, store, config, head) {
  let cursor = store.get('cursor');
  let reorg = false;
  if (cursor) {
    const canonical = cursor.blockNumber <= head.number ? await chain.client.getBlock({ blockNumber: cursor.blockNumber }) : undefined;
    if (!canonical || canonical.hash !== cursor.blockHash) {
      // Rebuild discovery after a reorg. Stale identities are harmless: state is always read onchain.
      cursor = undefined;
      store.set('cursor', null);
      reorg = true;
    }
  }
  let fromBlock = cursor ? cursor.blockNumber + 1n : config.startBlock;
  let chunks = 0;
  let chunkSize = config.logChunk;
  while (fromBlock <= head.number && chunks < config.maxChunksPerCycle) {
    const toBlock = fromBlock + chunkSize - 1n < head.number ? fromBlock + chunkSize - 1n : head.number;
    const before = await chain.client.getBlock({ blockNumber: toBlock });
    let logs;
    try {
      logs = await chain.client.getLogs({ address: config.vault, events:positionEvents, fromBlock, toBlock, strict:true });
    } catch (error) {
      if (chunkSize === 1n) throw error;
      chunkSize = chunkSize / 2n || 1n;
      continue;
    }
    const after = await chain.client.getBlock({ blockNumber: toBlock });
    if (before.hash !== after.hash || (toBlock === head.number && after.hash !== head.hash)) throw new Error('Reorg during indexing');
    const pairs = logs.filter(x => !x.removed && x.args.borrower && x.args.collateral).map(x => ({ collateral:x.args.collateral, borrower:x.args.borrower }));
    store.indexBatch(pairs, toBlock, after.hash);
    fromBlock = toBlock + 1n;
    chunks++;
  }
  return { complete: fromBlock > head.number, cursor: fromBlock - 1n, chunks, reorg };
}
