import { decodeEventLog, parseAbi, toEventSelector } from 'viem';

const loanAbi = parseAbi([
  'event Borrowed(address indexed borrower,uint256 amount)',
  'event Repaid(address indexed borrower,address indexed payer,uint256 principal,uint256 interest)',
  'event Liquidated(address indexed borrower,address indexed liquidator,uint256 repaid,uint256 seized)',
  'event PositionLoss(address indexed borrower,uint256 principal,uint256 interest)',
]);
const enrollmentAbi = parseAbi(['event Enrolled(address indexed borrower,address indexed engine,uint256 cap,uint64 startsAt)',
  'event Published(bytes32 indexed root,uint256 indexed throughBlock,bytes32 blockHash)']);
const loanTopics = new Set(loanAbi.map(toEventSelector));
const campaignTopics = new Set(enrollmentAbi.map(toEventSelector));
const safeNumber = n => { const value = Number(n); if (!Number.isSafeInteger(value)) throw new Error('Unsafe block number'); return value; };

/** Read full receipts, so a Repaid event inside liquidation cannot be misclassified. */
export async function readCanonicalBlock({ client, number, campaign, engines }) {
  const blockNumber = BigInt(number);
  const block = await client.getBlock({ blockNumber });
  const approved = new Set(engines.map(address => address.toLowerCase()));
  const distributor = campaign.toLowerCase();
  const logs = await client.getLogs({ address: [campaign, ...engines], fromBlock: blockNumber, toBlock: blockNumber });
  const transactions = [...new Set(logs.filter(log => (log.address.toLowerCase() === distributor
    ? campaignTopics.has(log.topics[0]) : loanTopics.has(log.topics[0]))).map(log => log.transactionHash))];
  const receipts = [];
  for (const transactionHash of transactions) {
    const receipt = await client.getTransactionReceipt({ hash: transactionHash });
    if (receipt.blockHash !== block.hash || receipt.status !== 'success') throw new Error('Receipt is not in canonical block');
    const events = [];
    for (const log of receipt.logs) {
      const address = log.address.toLowerCase();
      const enrollment = address === distributor && campaignTopics.has(log.topics[0]);
      if (!enrollment && !(approved.has(address) && loanTopics.has(log.topics[0]))) continue;
      if (log.blockHash !== block.hash || log.removed) throw new Error('Removed or inconsistent receipt log');
      const decoded = decodeEventLog({ abi: enrollment ? enrollmentAbi : loanAbi, data: log.data, topics: log.topics, strict: true });
      const fields = Object.fromEntries(Object.entries(decoded.args).map(([key, value]) => [key,
        ['startsAt','throughBlock'].includes(key) ? safeNumber(value) : typeof value === 'bigint' ? value.toString() : value]));
      events.push({ ...fields, ...(decoded.eventName === 'Published' ? {} : {
        engine: enrollment ? fields.engine.toLowerCase() : address }), event: decoded.eventName });
    }
    if (events.length) receipts.push({ transactionHash, timestamp: safeNumber(block.timestamp),
      transactionIndex: receipt.transactionIndex, events });
  }
  receipts.sort((a, b) => a.transactionIndex - b.transactionIndex);
  if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('Chain reorganized during block read');
  return { number: safeNumber(block.number), hash: block.hash, parentHash: block.parentHash,
    timestamp: safeNumber(block.timestamp), receipts };
}

/** Bounded polling pass. Confirmation depth is chain policy, not a claim of absolute finality. */
export async function syncLedger({ client, ledger, startBlock, campaign, engines, confirmations = 64,
  maxBlocks = 1000, maxReorgDepth = 128, historicalRange = 0 }) {
  if (![startBlock, confirmations, maxBlocks, maxReorgDepth, historicalRange].every(Number.isSafeInteger)
    || startBlock < 0 || confirmations < 0 || maxBlocks <= 0 || maxReorgDepth < 0 || historicalRange < 0 || historicalRange > 10000) throw new Error('Invalid indexing limits');
  const target = safeNumber(await client.getBlockNumber({ cacheTime: 0 })) - confirmations;
  const head = ledger.head();
  let common = head ? Math.min(head.number, target) : startBlock - 1;
  let depth = head ? head.number - common : 0;
  if (depth > maxReorgDepth) throw new Error('Canonical head moved beyond allowed reorganization depth');
  while (common >= startBlock) {
    const block = await client.getBlock({ blockNumber: BigInt(common) });
    if (ledger.block(common)?.hash === block.hash) break;
    common--; depth++;
    if (depth > maxReorgDepth) throw new Error('Reorganization exceeds automatic recovery depth');
  }
  // A shortened chain must not leave orphaned rewards served as current.
  if (head && common < head.number && target <= common)
    throw new Error('Canonical chain shortened; wait for a replacement block before serving estimates');
  const from = Math.max(startBlock, common + 1);
  if (historicalRange > 0 && (!head || common === head.number) && from + maxBlocks < target - maxReorgDepth) {
    const to = Math.min(from + historicalRange - 1, target - maxReorgDepth - 1);
    ledger.ingestRange(await readCanonicalRange({client,from,to,campaign,engines}));
    return {processed:to-from+1,head:ledger.head(),target,more:true};
  }
  if (historicalRange > 0 && from <= target) {
    const to=Math.min(from+maxBlocks-1,target);
    const range=await readCanonicalRange({client,from,to,campaign,engines,dense:true});
    if(head && common<head.number)for(const block of range.blocks)ledger.ingest(block);
    else ledger.ingestRange(range);
    return {processed:to-from+1,head:ledger.head(),target,more:to<target};
  }
  let processed = 0;
  for (let number = Math.max(startBlock, common + 1); number <= target && processed < maxBlocks; number++) {
    ledger.ingest(await readCanonicalBlock({ client, number, campaign, engines }));
    processed++;
  }
  return { processed, head: ledger.head(), target, more: (ledger.head()?.number ?? startBlock - 1) < target };
}

/** Query every relevant event in the range, then authenticate full transaction
 * receipts. The RPC must implement complete eth_getLogs; range-limit errors
 * abort without advancing the ledger. End anchors detect concurrent reorgs.
 */
export async function readCanonicalRange({client,from,to,campaign,engines,dense=false}) {
  const [start,end]=await Promise.all([client.getBlock({blockNumber:BigInt(from)}),client.getBlock({blockNumber:BigInt(to)})]);
  const logs=await client.getLogs({address:[campaign,...engines],fromBlock:BigInt(from),toBlock:BigInt(to)});
  const relevant=logs.filter(log=>(log.address.toLowerCase()===campaign.toLowerCase()?campaignTopics:loanTopics).has(log.topics[0]));
  if(relevant.some(log=>log.removed || log.blockNumber===null || log.blockNumber<BigInt(from) || log.blockNumber>BigInt(to)))
    throw new Error('Invalid historical log range');
  const numbers=new Set([from,to,...relevant.map(log=>safeNumber(log.blockNumber))]);
  // A Published receipt may anchor an otherwise empty historical block.
  for(const log of relevant) if(log.address.toLowerCase()===campaign.toLowerCase() && log.topics[0]===toEventSelector(enrollmentAbi[1])) {
    const event=decodeEventLog({abi:enrollmentAbi,data:log.data,topics:log.topics,strict:true});
    const anchor=safeNumber(event.args.throughBlock);if(anchor>=from&&anchor<=to)numbers.add(anchor);
  }
  if(dense)for(let number=from;number<=to;number++)numbers.add(number);
  const eventNumbers=new Set(relevant.map(log=>safeNumber(log.blockNumber)));
  const ordered=[...numbers].sort((a,b)=>a-b), blocks=new Array(ordered.length);
  let cursor=0;
  async function worker(){while(cursor<ordered.length){const index=cursor++,number=ordered[index];
    if(eventNumbers.has(number))blocks[index]=await readCanonicalBlock({client,number,campaign,engines});
    else {
      const block=number===from?start:number===to?end:await client.getBlock({blockNumber:BigInt(number)});
      blocks[index]={number:safeNumber(block.number),hash:block.hash,parentHash:block.parentHash,timestamp:safeNumber(block.timestamp),receipts:[]};
    }
  }}
  await Promise.all(Array.from({length:Math.min(16,ordered.length)},worker));
  // Compare discovered transactions with each authenticated block, rejecting
  // inconsistent range responses as well as canonical-head changes.
  const returned=new Set(blocks.flatMap(b=>b.receipts.map(r=>r.transactionHash)));
  const expected=new Set(relevant.map(log=>log.transactionHash));
  if(returned.size!==expected.size||[...returned].some(hash=>!expected.has(hash))
    ||blocks[0].hash!==start.hash||blocks.at(-1).hash!==end.hash
    ||(await client.getBlock({blockNumber:BigInt(to)})).hash!==end.hash)
    throw new Error('Historical range changed during replay');
  return {from,to,blocks};
}
