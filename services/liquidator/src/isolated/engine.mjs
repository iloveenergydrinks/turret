import { mapLimit } from '../engine.mjs';
import { errorCode } from '../chain.mjs';
import { incident,rpcConsistencyIncident } from '../alerts.mjs';

const lower = a => a.toLowerCase();
export class IsolatedEngine {
  constructor(chain,store,config,transactions) { Object.assign(this,{chain,store,config,transactions}); }
  async cycle() {
    const {chain,store,config:c,transactions}=this;
    store.assertLease();
    const head=await chain.select();
    const block=head.number;
    if(!this.lastDeploymentVerificationAt||Date.now()-this.lastDeploymentVerificationAt>=c.deploymentVerifyIntervalMs){
      await chain.verifyDeployment(block);
      this.lastDeploymentVerificationAt=Date.now();
    }
    const incidents=[];
    let liveness,livenessError;
    if(c.stock){try{liveness=await chain.stockLiveness();}catch(error){livenessError=errorCode(error);
      incidents.push(incident('execution_liveness_unavailable','critical','Fresh stock execution liveness is unavailable. New keeper transactions are blocked.'));}}
    const rpcIncident=rpcConsistencyIncident(chain);
    if(rpcIncident)incidents.push(rpcIncident);
    for (const p of chain.probeStatus ?? []) if (p.error) incidents.push(incident(`rpc:${p.name}`,'warning','An RPC provider is unhealthy.',{error:p.error}));
    const [count,debtLimit,totalPrincipal,bookInterest,pendingInterest,availableLiquidity,paused,priceRead]=await Promise.all([
      chain.read('activeDebtPositions',[],block),chain.capital('debtLimit',[],block),
      chain.capital('outstandingPrincipal',[],block),
      chain.capital('interestReceivable',[],block),chain.capital('pendingInterest',[],block),
      chain.capital('availableCash',[],block),chain.read('riskPaused',[],block),
      (c.stock?(liveness?chain.stockPrice(block,liveness):Promise.reject({name:livenessError??'LivenessUnavailable'})):chain.read('price',[],block))
        .then(value=>({value}),error=>({error:errorCode(error)})),
    ]);
    if (count<0n || count>64n) throw new Error('Invalid active registry size');
    const price=priceRead.value;
    // A missing execution proof already has its own incident above. In that
    // case no price call ran, so do not report a second, fabricated oracle fault.
    if ((!price || price<=0n)&&(!c.stock||liveness)) incidents.push(incident('oracle_blocked','critical','The engine rejects its price. Liquidation and fresh risk are unavailable.',{error:priceRead.error ?? 'invalid_price'}));
    const borrowers=await mapLimit(Array.from({length:Number(count)},(_,i)=>BigInt(i)),4,i=>chain.read('activeBorrowerAt',[i],block));
    if (new Set(borrowers.map(lower)).size!==borrowers.length) throw new Error('Duplicate active borrower');
    const positions=await mapLimit(borrowers,4,async borrower=>{
      const [tuple,debt]=await Promise.all([chain.read('positions',[borrower],block),chain.read('positionDebt',[borrower],block)]);
      const [collateralAmount,principal]=tuple;
      if (debt<=0n || principal>debt || collateralAmount<=0n) throw new Error('Invalid active position');
      let quote;
      if (price>0n) {
        try {
          const [repaid,seized]=c.stock?await chain.stockQuote(borrower,c.maxRepay,block,liveness):await chain.read('liquidationQuote',[borrower,c.maxRepay],block);
          if (repaid<=0n || repaid>c.maxRepay || seized<=0n || seized>collateralAmount) throw new Error('Invalid contract quote');
          quote={repaid,seized};
        } catch (error) {
          if (errorCode(error)!=='HealthyPosition') {
            incidents.push(incident(`quote:${lower(borrower)}`,'critical','A position cannot be safely quoted for liquidation.',{error:errorCode(error)}));
          }
        }
      }
      return {borrower,collateral:c.collateral,collateralAmount,principal,debt,quote};
    });
    const principalSum=positions.reduce((n,p)=>n+p.principal,0n);
    const totalDebt=positions.reduce((n,p)=>n+p.debt,0n);
    const borrowerInterest=totalDebt-principalSum;
    // Aggregate floors may exceed individual floors. They may never understate them.
    const reconciled=principalSum===totalPrincipal && bookInterest+pendingInterest>=borrowerInterest;
    if (!reconciled) incidents.push(incident('debt_mismatch','critical','Active registry debt does not reconcile with lender accounting. Execution is blocked.',{principalSum,totalPrincipal,borrowerInterest,aggregateInterest:bookInterest+pendingInterest}));
    const canonical=await chain.client.getBlock({blockNumber:block});
    if (canonical.hash!==head.hash) throw new Error('Reorg during isolated scan');
    const account=chain.account?.address;
    let balances;
    if (account) {
      const [usdg,eth,allowance,collateral]=await Promise.all([
        chain.token(c.usdg,'balanceOf',[account],block),chain.client.getBalance({address:account,blockNumber:block}),
        chain.token(c.usdg,'allowance',[account,c.executor ?? c.vault],block),chain.token(c.collateral,'balanceOf',[account],block),
      ]);
      balances={usdg,eth,allowance,collateral};
      if (eth<c.minEth) incidents.push(incident('eth_reserve','critical','Liquidator ETH is below its gas reserve.'));
      const coverageTarget=debtLimit+bookInterest+pendingInterest;
      if (usdg<c.minUsdg || usdg<coverageTarget) incidents.push(incident('usdg_reserve','critical','Liquidator USDG does not cover the market debt limit and accrued interest.',{usdg,coverageTarget}));
    } else incidents.push(incident('signer_missing','critical','No dedicated isolated-market signer is configured.'));
    if (c.mode!=='execute') incidents.push(incident('observe_mode','warning','Isolated market scans are read-only; transactions are disabled.'));
    if (!c.executor && !c.retainCollateral) incidents.push(incident('exit_policy_missing','critical','No atomic exit is configured and retained inventory is not authorized.'));
    else if (!c.executor) incidents.push(incident('retained_inventory','warning','Seized collateral stays in the keeper wallet. USDG is not replenished automatically.'));
    if (!c.alertWebhook&&!c.alertEmail) incidents.push(incident('alert_destination_missing','critical','No external operator alert destination is configured.'));
    const candidates=positions.filter(p=>p.quote).sort((a,b)=>a.debt>b.debt?-1:a.debt<b.debt?1:0);
    const canExecute=reconciled && chain.consistent && price>0n && c.mode==='execute' && Boolean(account) && Boolean(c.executor || c.retainCollateral);
    // Receipts must still reconcile during a pricing outage or while observing.
    if (account) incidents.push(...await transactions.recover(head,canExecute));
    if (canExecute && !store.pendingTx()) {
      for (const candidate of candidates) {
        incidents.push(...await transactions.liquidate(candidate));
        if (store.pendingTx()) break;
      }
    }
    if (candidates.length) incidents.push(incident('unhealthy_positions','critical','Isolated loans are eligible for liquidation.',{count:candidates.length,inFlight:Boolean(store.pendingTx())}));
    const budgets=store.budgets();
    if (budgets.daily>=c.dailyBudget || budgets.inventory>=c.inventoryBudget) incidents.push(incident('capital_limit_reached','critical','Keeper repayment or retained-inventory budget is exhausted.'));
    return {
      checkedAt:Date.now(),head:block,headTimestamp:head.timestamp,mode:c.mode,reconciled,
      index:{complete:true,cursor:block,source:'active-borrower-registry'},
      marketCount:1,knownPositions:positions.length,openPositions:positions.length,
      unhealthyPositions:candidates.length,totalDebt,totalPrincipal,debtLimit,availableLiquidity,paused,price,
      account,signerAvailable:Boolean(chain.wallet),balances,budgets,codeHash:chain.codeHash,rpc:chain.probeStatus,rpcConsistency:chain.consistency,activeRpc:chain.active?.name,
      profitPolicy:c.executor?{absoluteFloor:c.minProfit,repaymentBps:c.minProfitBps??0,gasIncluded:false}:null,
      executor:c.executor,executorCodeHash:c.executorCodeHash,repaymentLimit:c.maxRepay,
      chainId:c.chainId,engine:c.vault,pool:c.pool,collateral:c.collateral,marketKind:c.marketKind,
      executionGate:c.executionGate,poolCodeHash:c.poolCodeHash,incidents,
      pendingTransaction:store.pendingTx() ? {id:store.pendingTx().id,kind:store.pendingTx().kind,hash:store.pendingTx().attempts.at(-1).hash,status:store.pendingTx().status}:null,
    };
  }
}
