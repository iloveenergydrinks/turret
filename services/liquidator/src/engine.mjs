import { marketFromTuple, oracleAbi } from './abi.mjs';
import { syncPositions } from './indexer.mjs';
import { incident,hasAlertDestination,rpcConsistencyIncident } from './alerts.mjs';
import { feedHealth, liquidationQuote, min } from './risk.mjs';
import { checkLiquidity } from './liquidity.mjs';
import { errorCode } from './chain.mjs';
import {fetchLiveness} from './liveness.mjs';

export async function mapLimit(items, limit, callback) {
  let next=0;
  const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async () => {
    while (next < items.length) { const index=next++; results[index]=await callback(items[index],index); }
  }));
  return results;
}

export class Engine {
  constructor(chain,store,config,transactions) { this.chain=chain; this.store=store; this.config=config; this.transactions=transactions; this.quoteCache=new Map(); }
  async cycle() {
    const {chain,store,config}=this;
    store.assertLease();
    const incidents=[];
    const head=await chain.select();
    const rpcIncident=rpcConsistencyIncident(chain);
    if(rpcIncident)incidents.push(rpcIncident);
    for (const probe of chain.probeStatus) if (probe.error) incidents.push(incident(`rpc:${probe.name}`,'warning','An RPC provider is unhealthy; another provider may be serving reads.',{host:probe.host,error:probe.error}));
    if (chain.active !== chain.providers[0]) incidents.push(incident('rpc_failover','warning','The keeper is using its fallback RPC.'));
    if (!this.verified) { await chain.verifyDeployment(); this.verified=true; }
    const sync=await syncPositions(chain,store,config,head);
    if (sync.reorg) incidents.push(incident('index_reorg','warning','A chain reorganization triggered a position discovery rebuild.'));
    if (!sync.complete) incidents.push(incident('index_catching_up','warning','Replaying vault history; new transaction execution waits for complete coverage.',{cursor:sync.cursor,head:head.number}));
    const block=head.number;
    const [count,staleness,totalDebt,availableLiquidity,paused,originationFeeBps]=await Promise.all([
      chain.read('collateralCount',[],block),chain.read('oracleStaleness',[],block),chain.read('totalDebt',[],block),chain.read('availableLiquidity',[],block),chain.read('paused',[],block),chain.read('originationFeeBps',[],block),
    ]);
    if (count > 200n) throw new Error('Unexpected market count');
    const globalCap=await chain.read('globalDebtCeiling',[],block).catch(()=>undefined);
    const boundedHold=config.collateralPolicy==='bounded-hold';
    if(boundedHold&&(globalCap===undefined||globalCap<=0n||globalCap>250000000n||totalDebt>globalCap))throw new Error('Bounded holding requires an onchain cap of at most 250 USDG');
    const marketRows=await mapLimit(Array.from({length:Number(count)},(_,i)=>BigInt(i)),4,async index => {
      const address=await chain.read('collateralAt',[index],block);
      const [tuple,debt]=await Promise.all([chain.read('markets',[address],block),chain.read('marketDebt',[address],block)]);
      const market=marketFromTuple(address,tuple);
      const [priceResult,primaryResult,secondaryResult]=await Promise.allSettled([
        chain.read('price',[address],block),
        chain.client.readContract({address:market.primaryOracle,abi:oracleAbi,functionName:'latestRoundData',blockNumber:block}),
        chain.client.readContract({address:market.secondaryOracle,abi:oracleAbi,functionName:'latestRoundData',blockNumber:block}),
      ]);
      const primary=feedHealth(primaryResult.status === 'fulfilled' ? primaryResult.value : undefined,market.primaryOracleDecimals,head.timestamp,staleness);
      const secondary=feedHealth(secondaryResult.status === 'fulfilled' ? secondaryResult.value : undefined,market.secondaryOracleDecimals,head.timestamp,staleness);
      const price=priceResult.status === 'fulfilled' ? priceResult.value : undefined;
      if (!price) incidents.push(incident(`oracle_blocked:${market.address}`,'critical','The vault rejects this market price; liquidation is unavailable.',{error:priceResult.status === 'rejected' ? errorCode(priceResult.reason) : 'zero_price',debt}));
      else if (!primary.valid || !secondary.valid) incidents.push(incident(`oracle_degraded:${market.address}`,'warning','One oracle is invalid; the vault is using its remaining feed.',{primary:primary.reason,secondary:secondary.reason}));
      if (primary.valid && secondary.valid && (BigInt(primary.age) > staleness*9n/10n || BigInt(secondary.age) > staleness*9n/10n)) {
        incidents.push(incident(`oracle_near_stale:${market.address}`,'warning','An oracle is approaching the vault staleness limit.'));
      }
      if (price) {
        const quote=await checkLiquidity(market,price,config,this.quoteCache.get(market.address));
        this.quoteCache.set(market.address,quote); incidents.push(...quote.incidents);
        if (!quote.checked && (debt > 0n || store.budgets().inventory > 0n)) incidents.push(incident(`liquidity_exposure:${market.address}`,boundedHold?'warning':'critical',boundedHold?'Treasury holding policy: seized collateral has no verified sale route. The immutable debt cap and keeper capital bound exposure.':'There is outstanding debt or retained collateral without verified sale liquidity.'));
      }
      return {...market,debt,price,primary,secondary};
    });
    const markets=new Map(marketRows.map(x=>[x.address,x]));
    const positions=await mapLimit(store.positions(),8,async pair => {
      const [collateral,debt]=await chain.read('positions',[pair.collateral,pair.borrower],block);
      const market=markets.get(pair.collateral);
      if (!market) throw new Error('Discovered position has an unknown market');
      const quote=market.price ? liquidationQuote({collateral,debt,price:market.price,ltvBps:market.liquidationLtvBps,bonusBps:market.liquidationBonusBps,scale:chain.scale,maxRepay:config.maxRepay}) : undefined;
      return { ...pair,collateralAmount:collateral,debt,quote };
    });
    const discoveredDebt=positions.reduce((sum,p)=>sum+p.debt,0n);
    let reconciled=sync.complete && discoveredDebt === totalDebt;
    for (const market of marketRows) {
      const sum=positions.filter(p=>p.collateral === market.address).reduce((sum,p)=>sum+p.debt,0n);
      if (sum !== market.debt) reconciled=false;
    }
    if (sync.complete && !reconciled) incidents.push(incident('debt_mismatch','critical','Discovered position debt does not reconcile to the vault. New transactions are blocked.',{discoveredDebt,totalDebt}));
    // Reads and discovery must agree on the same still-canonical block.
    const canonical=await chain.client.getBlock({blockNumber:block});
    if (canonical.hash !== head.hash) throw new Error('Reorg during reconciliation');
    const candidates=positions.filter(p=>p.quote?.eligible && p.quote.repaid > 0n).sort((a,b)=>a.debt > b.debt ? -1 : a.debt < b.debt ? 1 : 0);
    const badDebt=positions.filter(p=>p.debt > 0n && (p.collateralAmount === 0n || p.quote?.badDebt));
    for (const position of badDebt) incidents.push(incident(`bad_debt:${position.collateral}:${position.borrower}`,'critical','A position has debt that cannot be covered by a positive collateral liquidation.',{collateral:position.collateral,borrower:position.borrower,debt:position.debt}));
    const account=chain.account?.address;
    let balances;
    if (account) {
      const [usdg,eth,allowance]=await Promise.all([chain.token(config.usdg,'balanceOf',[account]),chain.client.getBalance({address:account}),chain.token(config.usdg,'allowance',[account,config.vault])]);
      balances={usdg,eth,allowance};
      // Also cover currently lendable principal plus its possible origination fee.
      const unconstrainedTarget=totalDebt+(availableLiquidity*(10000n+BigInt(originationFeeBps))+9999n)/10000n;
      const coverageTarget=globalCap===undefined?unconstrainedTarget:min(globalCap,unconstrainedTarget);
      if (usdg < config.minUsdg || usdg < coverageTarget) incidents.push(incident('usdg_reserve','critical','Keeper USDG is below the reserve or current lending exposure.',{balance:usdg,minimum:config.minUsdg,coverageTarget}));
      if(boundedHold&&config.inventoryBudget-store.budgets().inventory<coverageTarget)incidents.push(incident('inventory_reserve','critical','Remaining treasury inventory capacity is below lending exposure.',{coverageTarget}));
      if (eth < config.minEth) incidents.push(incident('eth_reserve','critical','Keeper ETH is below the gas reserve.',{balance:eth,minimum:config.minEth}));
    } else incidents.push(incident('signer_missing','critical','No keeper signer is configured. Execution is unavailable.'));
    if (!hasAlertDestination(config)) incidents.push(config.nativeWatchdog
      ? incident('alert_delivery_unverified','warning','Railway watchdog crash notifications are configured; receipt by an operator has not been verified.')
      : incident('alert_destination_missing','critical','No external alert webhook is configured. Incidents are visible in Railway logs and authenticated status only.'));
    if (config.mode !== 'execute') incidents.push(incident('observe_mode','warning','The keeper is observing; liquidation transactions are disabled.'));
    let executionLiveness=true;
    if(config.executionGate){
      try{await fetchLiveness(config);}catch{executionLiveness=false;incidents.push(incident('execution_liveness_unavailable','critical','Execution liveness proof is unavailable. New liquidation attempts are blocked.'));}
    }
    const canExecute=executionLiveness && reconciled && chain.consistent && config.mode === 'execute' && Boolean(account);
    // Always reconcile an already signed transaction, even in observe mode.
    if (account) incidents.push(...await this.transactions.recover(head,canExecute));
    if (canExecute && !store.pendingTx()) {
      for (const candidate of candidates) {
        incidents.push(...await this.transactions.liquidate({...candidate,repaid:candidate.quote.repaid}));
        if (store.pendingTx()) break;
      }
    }
    if (candidates.length) incidents.push(incident('unhealthy_positions','critical','Positions are eligible for liquidation.',{count:candidates.length,debt:candidates.reduce((sum,p)=>sum+p.debt,0n),inFlight:Boolean(store.pendingTx())}));
    const budgets=store.budgets();
    if (budgets.inventory >= config.inventoryBudget || budgets.daily >= config.dailyBudget) incidents.push(incident('capital_limit_reached','critical','The retained collateral or daily repayment limit has been reached.',budgets));
    return {
      chainId:config.chainId,vault:config.vault,executionGate:config.executionGate,executionLiveness,
      checkedAt:Date.now(),head:block,headTimestamp:head.timestamp,index:sync,reconciled,
      mode:config.mode,account,signerAvailable:Boolean(chain.wallet),codeHash:chain.codeHash,totalDebt,availableLiquidity,paused,
      marketCount:marketRows.length,knownPositions:positions.length,openPositions:positions.filter(x=>x.collateralAmount>0n || x.debt>0n).length,
      unhealthyPositions:candidates.length,badDebtPositions:badDebt.length,
      balances,budgets,limits:{maxRepay:config.maxRepay,dailyBudget:config.dailyBudget,inventoryBudget:config.inventoryBudget,minEth:config.minEth,minUsdg:config.minUsdg},
      rpc:chain.probeStatus,rpcConsistency:chain.consistency,activeRpc:chain.active.name,
      markets:marketRows.map(({address,debt,price,primary,secondary,enabled})=>({address,debt,price,primary,secondary,enabled})),
      pendingTransaction:store.pendingTx() ? {id:store.pendingTx().id,kind:store.pendingTx().kind,hash:store.pendingTx().attempts.at(-1).hash,status:store.pendingTx().status} : null,
      incidents,
    };
  }
}
