import { parseAbi,keccak256,formatUnits } from 'viem';
import { positionHealth } from '../../../shared/position-health.mjs';

export const ISOLATED_USDG='0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
export const isolatedAlertAbi=parseAbi([
  'function usdg() view returns (address)',
  'function pool() view returns (address)',
  'function collateralToken() view returns (address)',
  'function liquidationLtvBps() view returns (uint16)',
  'function price() view returns (uint256)',
  'function executionGate() view returns(address)',
  'function priceWithLiveness(bytes liveness) returns(uint256)',
  'function positions(address) view returns (uint256,uint256,uint256,uint256,uint256)',
  'function positionDebt(address) view returns (uint256)',
  'event Liquidated(address indexed borrower,address indexed liquidator,uint256 repaid,uint256 seized)',
]);
const bindingAbi=parseAbi([
  'function asset() view returns (address)', 'function creditEngine() view returns (address)',
  'function collateralToken() view returns (address)', 'function decimals() view returns (uint8)',
]);
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();

export class IsolatedMonitor {
  constructor(engine,client,deployment,fetcher=fetch) {
    this.engine=engine;this.client=client;this.deployment=deployment;this.healthyAt=0;
    this.operationalAt=0;this.monitorReason='unavailable';
    this.fetcher=fetcher;
    this.markets=[deployment.collateral];
  }
  get cursorId(){return `isolated-liquidations:${this.deployment.vault.toLowerCase()}`;}
  get positionUrl(){return `${this.engine.origin}/borrow?engine=${this.deployment.vault}`;}
  async verify(block) {
    const c=this.client,d=this.deployment;
    for (const [address,hash] of [[d.vault,d.codeHash],[d.pool,d.poolCodeHash],[d.collateral,d.collateralCodeHash]]) {
      const code=await c.getCode({address,blockNumber:block.number});
      if (!code || code==='0x' || !same(keccak256(code),hash)) throw new Error('Isolated runtime mismatch');
    }
    const read=(address,abi,functionName,args=[])=>c.readContract({address,abi,functionName,args,blockNumber:block.number});
    const [cash,token,pool,asset,poolToken,credit,tokenDecimals,cashDecimals]=await Promise.all([
      read(d.vault,isolatedAlertAbi,'usdg'),read(d.vault,isolatedAlertAbi,'collateralToken'),read(d.vault,isolatedAlertAbi,'pool'),
      read(d.pool,bindingAbi,'asset'),read(d.pool,bindingAbi,'collateralToken'),read(d.pool,bindingAbi,'creditEngine'),
      read(d.collateral,bindingAbi,'decimals'),read(ISOLATED_USDG,bindingAbi,'decimals'),
    ]);
    if (!same(cash,ISOLATED_USDG) || !same(asset,cash) || !same(token,d.collateral) || !same(pool,d.pool)
      || !same(poolToken,token) || !same(credit,d.vault) || tokenDecimals!==18 || cashDecimals!==6) throw new Error('Isolated binding mismatch');
    const gate=await read(d.vault,isolatedAlertAbi,'executionGate').catch(()=>undefined);
    if(Boolean(gate)!==Boolean(d.stock)||gate&&!same(gate,d.stock.executionGate))throw new Error('Stock alert gate mismatch');
    if(d.stock){
      const code=await c.getCode({address:d.stock.executionGate,blockNumber:block.number});
      if(!code||code==='0x'||!same(keccak256(code),d.stock.executionGateCodeHash))throw new Error('Stock alert gate runtime mismatch');
    }
  }
  async stockPrice(block){
    const d=this.deployment,now=Math.floor(this.engine.now()/1000);
    const response=await this.fetcher(d.stock.livenessUrl,{cache:'no-store',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(5000)});
    if(!response.ok){const error=new Error('Stock alert liveness unavailable');error.code='liveness_unavailable';throw error;}
    const body=await response.text();if(body.length>4096)throw new Error('Stock alert liveness oversized');
    const p=JSON.parse(body);
    if(p.chainId!==4663||!same(p.vault,d.vault)||!same(p.executionGate,d.stock.executionGate)
      ||!Number.isSafeInteger(p.validUntil)||p.validUntil<now+10||p.validUntil>now+45
      ||!/^0x(?:[a-fA-F0-9]{2}){64,512}$/.test(p.encoded??''))throw new Error('Stock alert liveness invalid');
    // eth_call publishes the certificate only in simulated state. The pinned
    // engine checks its signature, epoch, feeds and issuer state; no signer or
    // borrowing-session proof is needed to value liquidation risk.
    return (await this.client.simulateContract({address:d.vault,abi:isolatedAlertAbi,functionName:'priceWithLiveness',
      args:[p.encoded],blockNumber:block.number})).result;
  }
  async scan() {
    const e=this.engine,c=this.client,d=this.deployment;
    const subscriptions=e.store.all('subscription');
    const wallets=[...new Set(subscriptions.map(s=>s.wallet))];
    // Retain the last successful observation while a refresh is in flight.
    // The server still expires it after 90 seconds; known failures clear it.
    try {
      if (await c.getChainId()!==4663) throw new Error('Wrong chain');
      const block=await c.getBlock();
      if (Math.abs(e.now()-Number(block.timestamp)*1000)>60000 || block.number<d.startBlock) throw new Error('Invalid chain head');
      await this.verify(block);
      const read=(functionName,args=[])=>c.readContract({address:d.vault,abi:isolatedAlertAbi,functionName,args,blockNumber:block.number});
      let complete=true,positionsComplete=true,price=null,threshold=0n,priceReason='price_unavailable';
      try {
        threshold=BigInt(await read('liquidationLtvBps'));
        price=d.stock?await this.stockPrice(block):await read('price');
        if (threshold<=0n || threshold>=10000n || price<=0n) throw new Error('Invalid pricing');
      } catch(error) {this.healthyAt=0;complete=false;price=null;
        if(error?.code==='liveness_unavailable')priceReason='liveness_unavailable';}
      const states=[];
      for (let offset=0;offset<wallets.length;offset+=8) {
        states.push(...await Promise.all(wallets.slice(offset,offset+8).map(async wallet=>{
          try {
            // positionDebt includes pending interest; tuple principal alone does not.
            const [position,debt]=await Promise.all([read('positions',[wallet]),read('positionDebt',[wallet])]);
            return {wallet,health:positionHealth({collateral:position[0],debt,price,liquidationLtvBps:threshold})};
          } catch {this.healthyAt=0;this.operationalAt=0;this.monitorReason='positions_unavailable';complete=false;positionsComplete=false;return {wallet,health:{status:'unknown'}};}
        })));
      }
      if ((await c.getBlock({blockNumber:block.number})).hash!==block.hash
        || Math.abs(e.now()-Number(block.timestamp)*1000)>60000) throw new Error('Stale or reorganized snapshot');
      for (const row of states) e.risk(row.wallet,d.collateral,row.health);
      const confirmed=block.number>12n ? block.number-12n : 0n;
      const caughtUp=await this.events(confirmed,subscriptions);
      await this.transactions(confirmed);
      if ((await c.getBlock({blockNumber:block.number})).hash!==block.hash
        || Math.abs(e.now()-Number(block.timestamp)*1000)>60000) throw new Error('Scan snapshot expired');
      this.healthyAt=complete && caughtUp ? e.now() : 0;
      // A missing price cannot certify liquidation risk, but it does not erase
      // successful debt reads, canonical event processing or repayment tracking.
      this.operationalAt=positionsComplete && caughtUp ? e.now() : 0;
      this.monitorReason=!positionsComplete?'positions_unavailable':!caughtUp?'catching_up':complete?'ready':priceReason;
    } catch {
      this.healthyAt=0;this.operationalAt=0;this.monitorReason='unavailable';
      for (const wallet of wallets) e.risk(wallet,d.collateral,{status:'unknown'});
      throw new Error('Isolated borrower scan failed');
    }
  }
  async events(confirmed,subscriptions) {
    const e=this.engine,c=this.client,d=this.deployment;
    if (confirmed<d.startBlock) return true;
    let cursor=e.store.get('cursor',this.cursorId);
    if (!subscriptions.length) {
      const block=await c.getBlock({blockNumber:confirmed});
      // A verification may have completed during the RPC request. Do not skip
      // its first events based on the old empty subscriber snapshot.
      subscriptions=e.store.all('subscription');
      if (!subscriptions.length) {
        e.store.put('cursor',this.cursorId,{block:String(confirmed),hash:block.hash});return true;
      }
    }
    if (!cursor) {
      const block=await c.getBlock({blockNumber:d.startBlock-1n});
      cursor={block:String(block.number),hash:block.hash};
    }
    if ((await c.getBlock({blockNumber:BigInt(cursor.block)})).hash!==cursor.hash) throw new Error('Confirmed event cursor reorg');
    const fromBlock=BigInt(cursor.block)+1n;
    if (fromBlock>confirmed) return true;
    const toBlock=fromBlock+999n<confirmed ? fromBlock+999n : confirmed;
    const end=await c.getBlock({blockNumber:toBlock});
    const logs=await c.getContractEvents({address:d.vault,abi:isolatedAlertAbi,eventName:'Liquidated',fromBlock,toBlock,strict:true});
    const notifications=[];
    for (const log of logs) {
      if (log.removed || !same(log.address,d.vault) || log.blockNumber<fromBlock || log.blockNumber>toBlock) throw new Error('Invalid liquidation log');
      const eventBlock=await c.getBlock({blockNumber:log.blockNumber});
      if (eventBlock.hash!==log.blockHash) throw new Error('Liquidation event reorg');
      const eventId=`isolated:${d.vault.toLowerCase()}:${log.transactionHash}:${log.logIndex}`;
      if (e.store.get('event',eventId)) continue;
      const wallet=log.args.borrower.toLowerCase();
      notifications.push({eventId,wallet,eventBlock:log.blockNumber,eventTime:Number(eventBlock.timestamp)*1000,text:
        `Turret: liquidation confirmed.\nWallet: ${wallet}\nEngine: ${d.vault}\nCollateral: ${d.collateral}\nUSDG debt repaid: ${formatUnits(log.args.repaid,6)}\nCollateral taken: ${formatUnits(log.args.seized,18)}\nTransaction: ${log.transactionHash}\nReview your position: ${this.positionUrl}`});
    }
    if ((await c.getBlock({blockNumber:toBlock})).hash!==end.hash) throw new Error('Event range reorg');
    for (const n of notifications) {
      // Re-read consent after RPC awaits. A newly linked channel/contact must
      // not receive an event that predates its own verification.
      for (const sub of e.store.all('subscription')) {
        const afterConsent=sub.startBlock===undefined ? sub.created<=n.eventTime : n.eventBlock>BigInt(sub.startBlock);
        if (sub.wallet===n.wallet && afterConsent) {
          e.enqueue(`${sub.id}:${n.eventId}`,{subId:sub.id,text:n.text,until:e.now()+86400000});
        }
      }
      e.store.put('event',n.eventId,{until:e.now()+7*86400000});
    }
    e.store.put('cursor',this.cursorId,{block:String(toBlock),hash:end.hash});
    return toBlock===confirmed;
  }
  async watch(wallet,transactionHash) {
    if (!/^0x[0-9a-f]{64}$/i.test(transactionHash ?? '')) throw new Error('Invalid transaction');
    if (await this.client.getChainId()!==4663) throw new Error('Wrong chain');
    this.engine.rate(`transaction:${wallet}`,30,3600000);
    const tx=await this.client.getTransaction({hash:transactionHash});
    if (!same(tx.from,wallet) || ![this.deployment.vault,this.deployment.pool,this.deployment.collateral,ISOLATED_USDG].some(a=>same(a,tx.to))) {
      throw new Error('Transaction not from this wallet to this isolated market');
    }
    if (!this.engine.store.get('event',`failed:${transactionHash}`)) {
      this.engine.store.put('transaction',transactionHash,{wallet,until:this.engine.now()+86400000});
    }
  }
  async transactions(confirmed) {
    const e=this.engine,c=this.client;
    for (const row of e.store.all('transaction')) {
      let receipt;
      try {receipt=await c.getTransactionReceipt({hash:row.id});} catch {continue;}
      if (receipt.blockNumber>confirmed) continue;
      const block=await c.getBlock({blockNumber:receipt.blockNumber});
      if (block.hash!==receipt.blockHash) throw new Error('Transaction receipt reorg');
      if (receipt.status==='reverted' && !e.store.get('event',`failed:${row.id}`)) {
        e.notify(row.wallet,`failed:${row.id}`,`Turret: your transaction failed on-chain.\nEngine: ${this.deployment.vault}\nTransaction: ${row.id}\nYour intended action did not complete. Check your position: ${this.positionUrl}`);
        e.store.put('event',`failed:${row.id}`,{until:e.now()+7*86400000});
      }
      e.store.delete('transaction',row.id);
    }
  }
}
