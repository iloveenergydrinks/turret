import { decodeEventLog, encodeFunctionData, keccak256, parseAbi } from 'viem';

export const abi = parseAbi([
  'function totalStaked() view returns(uint256)',
  'function protocolFees() view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function collect(address)',
  'event RevenueDistributed(address indexed pool,uint256 collected,uint256 stakerShare,uint256 treasuryRetained)',
]);
const same = (a,b) => a?.toLowerCase() === b?.toLowerCase();
export function distribution(receipt, router, pool) {
  const matches = [];
  for (const log of receipt.logs) {
    if (!same(log.address, router)) continue;
    try { const event = decodeEventLog({abi,data:log.data,topics:log.topics});
      if (event.eventName === 'RevenueDistributed' && same(event.args.pool,pool)) matches.push(event.args);
    } catch { /* Ignore unrelated logs. */ }
  }
  if (matches.length !== 1) throw Error('distribution_event_mismatch');
  const e = matches[0];
  if (e.collected === 0n || e.stakerShare + e.treasuryRetained !== e.collected
      || e.stakerShare < e.collected / 2n || e.stakerShare > (e.collected + 1n) / 2n) throw Error('distribution_split_mismatch');
  return e;
}

// A dedicated account and durable single-writer journal are required. No token
// approval, forwarding of treasury balances, or non-router call is permitted.
export class Collector {
  constructor({client,wallet,account,store,config,verify}) {
    Object.assign(this,{client,wallet,account,store,config,verify});
  }
  async broadcast(tx) {
    this.store.assertLease();
    if (this.config.mode !== 'execute') return {reason:'observe_pending',hash:tx.hash};
    try {
      const hash = await this.client.sendRawTransaction({serializedTransaction:tx.raw});
      if (!same(hash,tx.hash)) throw Error('broadcast_hash_mismatch');
      return {reason:'pending',hash:tx.hash};
    } catch { return {reason:'broadcast_uncertain',hash:tx.hash}; }
  }
  async recover(head) {
    const tx = this.store.pendingTx();
    if (!tx) return null;
    if (tx.status === 'blocked') return {reason:'manual_reconciliation_required',hash:tx.hash};
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({hash:tx.hash}); }
    catch (e) { if (e.name !== 'TransactionReceiptNotFoundError') throw e; }
    if (receipt) {
      if (!same(receipt.transactionHash,tx.hash) || !same(receipt.from,this.account.address)
          || !same(receipt.to,this.config.router)) throw Error('receipt_identity_mismatch');
      const block = await this.client.getBlock({blockNumber:receipt.blockNumber});
      if (block.hash !== receipt.blockHash) return {reason:'receipt_reorg',hash:tx.hash};
      if (head.number < receipt.blockNumber + 2n) return {reason:'confirming',hash:tx.hash};
      if (receipt.status === 'success') {
        try { tx.distribution = distribution(receipt,this.config.router,tx.pool); }
        catch { tx.status='blocked';this.store.saveTx(tx);return {reason:'distribution_mismatch',hash:tx.hash}; }
      }
      tx.status=receipt.status==='success'?'confirmed':'reverted';
      tx.actualGas=receipt.gasUsed*receipt.effectiveGasPrice;
      tx.settledAt=Date.now();tx.block=receipt.blockNumber;tx.blockHash=receipt.blockHash;
      this.store.saveTx(tx);
      return {reason:tx.status,hash:tx.hash,distribution:tx.distribution};
    }
    const nonce = await this.client.getTransactionCount({address:this.account.address,blockTag:'latest'});
    if (nonce > tx.nonce) {
      tx.status='blocked';this.store.saveTx(tx);return {reason:'nonce_consumed_without_receipt',hash:tx.hash};
    }
    // Re-send only the identical signed bytes; a timeout never creates a new intent.
    return this.broadcast(tx);
  }
  async cycle() {
    this.store.assertLease();
    const head = await this.verify();
    const recovered = await this.recover(head);
    if (recovered) return recovered;
    const c=this.config, read=(address,functionName,args=[])=>this.client.readContract({address,abi,functionName,args,blockNumber:head.number});
    if (await read(c.staking,'totalStaked') === 0n) return {reason:'no_stakers'};
    const allowance=await read(c.usdg,'allowance',[c.treasury,c.router]);
    const candidates = await Promise.all(c.pools.map(async pool=>({pool,fees:await read(pool,'protocolFees')})));
    candidates.sort((a,b)=>a.fees>b.fees?-1:a.fees<b.fees?1:0);
    const candidate=candidates.find(x=>x.fees>=c.minFees && allowance>=(x.fees+1n)/2n);
    if (!candidate) return {reason:candidates.some(x=>x.fees>=c.minFees)?'treasury_allowance_required':'below_collection_threshold'};
    if (c.mode !== 'execute') return {reason:'observe',pool:candidate.pool,fees:candidate.fees};
    const address=this.account.address;
    const [latest,pending,balance]=await Promise.all([
      this.client.getTransactionCount({address,blockTag:'latest'}),
      this.client.getTransactionCount({address,blockTag:'pending'}),this.client.getBalance({address}),
    ]);
    if (latest !== pending) return {reason:'untracked_pending_nonce'};
    await this.client.simulateContract({address:c.router,abi,functionName:'collect',args:[candidate.pool],account:address});
    const data=encodeFunctionData({abi,functionName:'collect',args:[candidate.pool]});
    const prepared=await this.wallet.prepareTransactionRequest({account:this.account,to:c.router,data,value:0n,nonce:pending});
    if (prepared.chainId !== 4663) throw Error('prepared_chain_mismatch');
    const request=Object.fromEntries(['chainId','type','to','data','value','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','nonce','accessList'].filter(k=>prepared[k]!==undefined).map(k=>[k,prepared[k]]));
    request.gas=request.gas*120n/100n;
    const reserve=request.gas*(request.gasPrice??request.maxFeePerGas);
    if (reserve>c.maxTxFee || this.store.budgets().gas+reserve>c.maxDailyGas) return {reason:'gas_budget_exceeded'};
    if (balance<reserve+c.minEth) return {reason:'gas_funding_required'};
    this.store.assertLease();
    const raw=await this.account.signTransaction(request),hash=keccak256(raw);
    const tx={id:hash,kind:'staking_collection',status:'pending',createdAt:Date.now(),pool:candidate.pool,raw,hash,nonce:pending,feeReserve:reserve};
    // FULL synchronous SQLite commit precedes any network submission.
    this.store.saveTx(tx);
    return this.broadcast(tx);
  }
}
