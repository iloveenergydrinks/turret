import { decodeEventLog, encodeFunctionData } from 'viem';
import { Transactions } from '../transactions.mjs';
import { tokenAbi } from '../abi.mjs';
import { errorCode } from '../chain.mjs';
import { incident } from '../alerts.mjs';
import { isolatedAbi, exitAbi } from './abi.mjs';

const same = (a,b) => a?.toLowerCase() === b?.toLowerCase();
const min = (...xs) => xs.reduce((a,b)=>a<b?a:b);

export class IsolatedTransactions extends Transactions {
  liquidationResult(receipt,tx) {
    if (!same(tx.collateral,this.config.collateral) || typeof tx.minCollateral!=='bigint' || tx.minCollateral<=0n) return undefined;
    if (tx.executor && (!same(tx.executor,this.config.executor) || !same(tx.request?.to,tx.executor)
      || typeof tx.minProfit!=='bigint' || tx.minProfit<=0n)) return undefined;
    const matches=[];
    const exits=[];
    for (const entry of receipt.logs) {
      if (tx.executor && same(entry.address,tx.executor)) {
        try {
          const {eventName,args:a}=decodeEventLog({abi:exitAbi,data:entry.data,topics:entry.topics});
          if (eventName==='LiquidationExited' && same(a.borrower,tx.borrower) && same(a.keeper,this.chain.account.address)) exits.push(a);
        } catch { /* Only the pinned exit's exact event can release inventory reserve. */ }
      }
      if (!same(entry.address,this.config.vault)) continue;
      try {
        const parsed=decodeEventLog({abi:isolatedAbi,data:entry.data,topics:entry.topics});
        const a=parsed.args;
        if (parsed.eventName==='Liquidated' && same(a.borrower,tx.borrower) && same(a.liquidator,tx.executor ?? this.chain.account.address)) {
          matches.push({repaid:a.repaid,collateralSeized:a.seized});
        }
      } catch { /* Ignore unrelated logs, never infer success from receipt status alone. */ }
    }
    if (matches.length!==1 || matches[0].collateralSeized < tx.minCollateral) return undefined;
    if (tx.executor) {
      if (exits.length!==1) return undefined;
      const a=exits[0], liquidation=matches[0];
      if (a.paid!==liquidation.repaid || a.seized!==liquidation.collateralSeized
        || a.usdgOut<a.paid+tx.minProfit || a.profit!==a.usdgOut-a.paid) return undefined;
      return {...liquidation,usdgOut:a.usdgOut};
    }
    return matches[0];
  }

  async liquidate(candidate) {
    const {chain,store,config:c}=this;
    if (c.mode!=='execute' || store.pendingTx()) return [];
    if (!c.executor && !c.retainCollateral) return [incident('exit_policy_missing','critical','No atomic exit is configured and retained inventory is not authorized.')];
    if (!same(candidate.collateral,c.collateral)) throw new Error('Unexpected collateral');
    const retry=`retry:${candidate.collateral}:${candidate.borrower}`;
    if ((store.get(retry) ?? 0)>Date.now()) return [];
    try {
      const head=await chain.client.getBlock();
      if (typeof head.number!=='bigint' || !head.hash || typeof head.timestamp!=='bigint') throw new Error('Invalid preparation head');
      const at=head.number;
      const validateSnapshot=async()=>{
        const canonical=await chain.client.getBlock({blockNumber:at});
        const latest=await chain.client.getBlock();
        if (canonical.hash!==head.hash || latest.number<at || latest.timestamp<head.timestamp
          || latest.timestamp-head.timestamp>30n) throw new Error('Liquidation snapshot changed or expired');
      };
      await chain.verifyDeployment(at);
      const liveness=c.stock?await chain.stockLiveness():undefined;
      const budgets=store.budgets();
      const balance=await chain.token(c.usdg,'balanceOf',[chain.account.address],at);
      const limit=min(c.maxRepay,c.dailyBudget-budgets.daily,c.inventoryBudget-budgets.inventory,balance);
      if (limit<=0n) return [incident(balance===0n?'liquidation_unfunded':'capital_budget','critical','Insufficient USDG or remaining liquidation budget.')];
      // Fresh contract quote includes current accrued interest and exact insolvency rounding.
      const quote=maximum=>c.stock?chain.stockQuote(candidate.borrower,maximum,at,liveness):chain.read('liquidationQuote',[candidate.borrower,maximum],at);
      let [paid,seized]=await quote(limit);
      if (paid<=0n || paid>limit || seized<=0n) throw new Error('Invalid liquidation quote');
      const target=c.executor ?? c.vault;
      const allowance=await chain.token(c.usdg,'allowance',[chain.account.address,target],at);
      if (allowance<limit) {
        // Interest can accrue while the approval confirms. Approve only the
        // funded/budgeted cap, not an exact quote that expires every block.
        const args=[target,limit];
        const result=await chain.client.simulateContract({address:c.usdg,abi:tokenAbi,functionName:'approve',args,account:chain.account,blockNumber:at});
        if (result.result!==true) throw new Error('USDG approval simulation failed');
        await validateSnapshot();
        return await this.submit('approval',c.usdg,encodeFunctionData({abi:tokenAbi,functionName:'approve',args}),{
          collateral:c.collateral,borrower:candidate.borrower,maxRepay:0n,
        });
      }
      const deadline=c.executor ? head.timestamp+120n : undefined;
      const abi=c.executor ? exitAbi : isolatedAbi;
      const functionName=c.executor?(c.stock?'liquidateAndSellChecked':'liquidateAndSell'):(c.stock?'liquidateChecked':'liquidate');
      let spend=limit;
      // Large atomic exits can be unprofitable from price impact. Try at most
      // four descending caps at the SAME block. Never relax the profit policy,
      // retry oracle/route failures, or fall back to retained collateral.
      for (let attempt=0;attempt<(c.executor?4:1);attempt++) {
        if (attempt) [paid,seized]=await quote(spend);
        if (paid<=0n || paid>spend || seized<=0n) throw new Error('Invalid liquidation quote');
        const minCollateral=seized*BigInt(10000-c.slippageBps)/10000n || 1n;
        // Gross USDG return, not net-of-ETH-gas profit. Round UP against the
        // actual quoted repayment (not its spend cap), preserving a positive
        // absolute floor even for dust. Each signed intent pins this threshold.
        const proportional=(paid*BigInt(c.minProfitBps??0)+9999n)/10000n;
        const minProfit=proportional>c.minProfit?proportional:c.minProfit;
        const args=c.executor ? [candidate.borrower,spend,minCollateral,minProfit,deadline] : [candidate.borrower,spend,minCollateral];
        if(c.stock)args.push(liveness);
        let simulation;
        try {
          simulation=await chain.client.simulateContract({address:target,abi,functionName,args,account:chain.account,blockNumber:at});
        } catch(error) {
          if (!c.executor || errorCode(error)!=='InsufficientReturn') throw error;
          const next=min(spend/2n,paid/2n);
          if (attempt===3 || next===0n) throw Object.assign(new Error('No executable bounded liquidation size'),{name:'NoExecutableLiquidationSize'});
          spend=next;
          continue;
        }
        const [actualPaid,actualSeized,usdgOut]=simulation.result;
        if (actualPaid<=0n || actualPaid>spend || actualSeized<minCollateral) throw new Error('Invalid liquidation simulation');
        if (c.executor && (typeof usdgOut!=='bigint' || usdgOut<actualPaid+minProfit)) throw new Error('Insufficient simulated USDG return');
        await validateSnapshot();
        return await this.submit('liquidation',target,encodeFunctionData({abi,functionName,args}),{
          collateral:c.collateral,borrower:candidate.borrower,maxRepay:spend,minCollateral,executor:c.executor,minProfit:c.executor ? minProfit : undefined,deadline,sizingAttempts:attempt+1,
        });
      }
    } catch (error) {
      const code=errorCode(error);
      if (code==='HealthyPosition') return [];
      store.set(retry,Date.now()+30000);
      return [incident(`simulation:${c.collateral}:${candidate.borrower}`,'critical','Isolated liquidation preparation failed; durable transaction state will be reconciled before retry.',{error:code})];
    }
  }
}
