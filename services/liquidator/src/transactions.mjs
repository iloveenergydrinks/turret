import { randomUUID } from 'node:crypto';
import { decodeEventLog, encodeFunctionData, keccak256 } from 'viem';
import { vaultAbi, tokenAbi } from './abi.mjs';
import { incident } from './alerts.mjs';
import { errorCode, log } from './chain.mjs';
import { min } from './risk.mjs';
import {fetchLiveness} from './liveness.mjs';

const lower = x => x.toLowerCase();
const requestFields = ['chainId','type','to','data','value','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','nonce','accessList'];
export const feeReserve = request => request.gas * (request.gasPrice ?? request.maxFeePerGas);
export class ReceiptValidationError extends Error {}

export class Transactions {
  constructor(chain, store, config) { this.chain=chain; this.store=store; this.config=config; }
  async broadcast(tx) {
    this.store.assertLease();
    try {
      await this.chain.client.sendRawTransaction({ serializedTransaction:tx.attempts.at(-1).raw });
      log('info','transaction_broadcast',{ id:tx.id, hash:tx.attempts.at(-1).hash, kind:tx.kind });
      return [];
    } catch (error) {
      // An RPC timeout does not mean the transaction was rejected. Retain the raw
      // signed intent and nonce, and reconcile its hash before preparing another.
      return [incident('broadcast_uncertain','warning','Transaction submission is uncertain; reconciling the persisted hash.',{ hash:tx.attempts.at(-1).hash, error:errorCode(error) })];
    }
  }
  async makeAttempt(request) {
    this.store.assertLease();
    const raw=await this.chain.account.signTransaction(request);
    return { raw, hash:keccak256(raw), signedAt:Date.now() };
  }
  // Specialized workers can validate successful receipts before confirmation is persisted.
  async confirmationDetails(_receipt, _tx) { return {}; }
  liquidationResult(receipt, tx) {
    let event;
    for (const entry of receipt.logs) {
      if (lower(entry.address) !== lower(this.config.vault)) continue;
      try {
        const parsed=decodeEventLog({abi:vaultAbi,data:entry.data,topics:entry.topics});
        if (parsed.eventName === 'Liquidated' && lower(parsed.args.borrower) === lower(tx.borrower)
            && lower(parsed.args.collateral) === lower(tx.collateral)
            && lower(parsed.args.liquidator) === lower(this.chain.account.address)) event=parsed.args;
      } catch { /* Unrelated vault event. */ }
    }
    return event;
  }
  async submit(kind, to, data, details = {}, value = 0n) {
    if (this.config.mode !== 'execute') return [];
    if (this.store.pendingTx()) throw new Error('Pending transaction must be resolved first');
    if (!this.chain.consistent) throw new Error('RPC disagreement');
    const address=this.chain.account.address;
    const [latest,pending,balance]=await Promise.all([
      this.chain.client.getTransactionCount({address,blockTag:'latest'}),
      this.chain.client.getTransactionCount({address,blockTag:'pending'}),
      this.chain.client.getBalance({address}),
    ]);
    if (latest !== pending) return [incident('unknown_pending_nonce','critical','The keeper account has an untracked pending transaction. Resolve it before execution.')];
    const prepared=await this.chain.wallet.prepareTransactionRequest({ account:this.chain.account, to, data, value, nonce:pending });
    const request=Object.fromEntries(requestFields.filter(k => prepared[k] !== undefined).map(k => [k,prepared[k]]));
    request.chainId=this.config.chainId;
    request.gas=request.gas * 120n / 100n;
    const reserve=feeReserve(request), budgets=this.store.budgets();
    if (reserve > this.config.maxTxFee || budgets.gas+reserve > this.config.maxDailyGas) {
      return [incident('gas_budget','critical','Estimated transaction fees exceed the configured gas budget.')];
    }
    if (balance < reserve+value+this.config.minEth) return [incident('gas_reserve','critical','Keeper ETH is insufficient for this transaction and its reserve.')];
    const tx={ id:randomUUID(), kind, status:'pending', createdAt:Date.now(), request, feeReserve:reserve, ...details, attempts:[await this.makeAttempt(request)] };
    // FULL synchronous SQLite commit occurs before any network broadcast.
    this.store.saveTx(tx);
    return this.broadcast(tx);
  }
  async recover(head, canBroadcast) {
    const tx=this.store.pendingTx();
    if (!tx) return [];
    if (tx.status === 'blocked') return [incident('transaction_requires_review','critical','A transaction could not be reconciled safely. Execution is stopped.',{id:tx.id})];
    let receipt, sawOrphan=false, sawUnconfirmed=false, sawWrongHash=false;
    for (const attempt of tx.attempts) {
      let candidate;
      try { candidate=await this.chain.client.getTransactionReceipt({hash:attempt.hash}); }
      catch (error) {
        if (errorCode(error) !== 'TransactionReceiptNotFoundError') throw error;
        continue;
      }
      // Bind each response to the signed attempt, before accepting any events.
      // A malformed provider response remains retryable and keeps funds reserved.
      if (typeof candidate.transactionHash !== 'string' || lower(candidate.transactionHash) !== lower(attempt.hash)) {
        sawWrongHash=true;
        continue;
      }
      const canonical=await this.chain.client.getBlock({blockNumber:candidate.blockNumber});
      if (canonical.hash !== candidate.blockHash) { sawOrphan=true; continue; }
      if (head.number < candidate.blockNumber+this.config.confirmations) { sawUnconfirmed=true; continue; }
      receipt=candidate;
      break;
    }
    if (receipt) {
      tx.receipt={ hash:receipt.transactionHash, block:receipt.blockNumber, blockHash:receipt.blockHash };
      tx.actualGas=receipt.gasUsed*receipt.effectiveGasPrice;
      tx.status=receipt.status === 'success' ? 'confirmed' : 'reverted';
      if (tx.status === 'confirmed') {
        try { Object.assign(tx, await this.confirmationDetails(receipt, tx)); }
        catch (error) {
          // Unavailable RPC reads must retry the pending record, not permanently
          // label its receipt invalid. Only a proven semantic mismatch blocks it.
          if (!(error instanceof ReceiptValidationError)) throw error;
          tx.status='blocked'; this.store.saveTx(tx);
          return [incident('transaction_receipt_mismatch','critical','The successful receipt did not match the persisted operation; execution is stopped.',{hash:receipt.transactionHash})];
        }
      }
      if (tx.status === 'confirmed' && tx.kind === 'liquidation') {
        const event=this.liquidationResult(receipt,tx);
        if (!event || event.repaid <= 0n || event.repaid > tx.maxRepay || event.collateralSeized <= 0n) {
          tx.status='blocked'; this.store.saveTx(tx);
          return [incident('liquidation_receipt_mismatch','critical','A successful receipt did not contain the expected liquidation result.',{hash:receipt.transactionHash})];
        }
        tx.actualRepay=event.repaid; tx.collateralSeized=event.collateralSeized;
        if (event.usdgOut !== undefined) {tx.usdgOut=event.usdgOut;tx.inventoryRecovered=true;}
      }
      // Conservatively start the spend window when settlement is observed.
      tx.settledAt=Date.now();
      this.store.saveTx(tx);
      log(tx.status === 'reverted' ? 'error':'info','transaction_finalized',{kind:tx.kind,hash:receipt.transactionHash,status:tx.status,repaid:tx.actualRepay,seized:tx.collateralSeized});
      if (tx.status === 'reverted') {
        this.store.set(`retry:${tx.collateral}:${tx.borrower}`,Date.now()+60000);
        return [incident('transaction_reverted','critical','A keeper transaction reverted; a cooldown is active.',{hash:receipt.transactionHash})];
      }
      return [];
    }
    if (sawWrongHash) return [incident('transaction_receipt_identity','critical','An RPC receipt does not match the requested signed transaction; keeping the intent reserved for reconciliation.')];
    if (sawOrphan) return [incident('receipt_reorg','warning','A transaction receipt is on a noncanonical block; waiting for reconciliation.')];
    if (sawUnconfirmed) return [];
    const nonce=await this.chain.client.getTransactionCount({address:this.chain.account.address,blockTag:'latest'});
    if (nonce > tx.request.nonce) {
      tx.status='blocked'; this.store.saveTx(tx);
      return [incident('nonce_consumed','critical','The tracked nonce was consumed without a matching receipt. Manual reconciliation required.')];
    }
    const age=Date.now()-tx.attempts.at(-1).signedAt;
    if (!canBroadcast || this.config.mode !== 'execute') return [incident('pending_execution_blocked','warning','A transaction is pending while execution, chain coverage or RPC consistency is unavailable.')];
    if (age < this.config.replaceAfterMs) return this.broadcast(tx);
    if (tx.attempts.length > this.config.maxReplacements) {
      return [incident('transaction_stuck','critical','The transaction remains unmined after its permitted fee replacements.',{hash:tx.attempts.at(-1).hash})];
    }
    const request={...tx.request};
    for (const field of ['gasPrice','maxFeePerGas','maxPriorityFeePerGas']) if (request[field] !== undefined) request[field]=request[field]*120n/100n+1n;
    const reserve=feeReserve(request), budgets=this.store.budgets();
    const balance=await this.chain.client.getBalance({address:this.chain.account.address});
    // budgets() includes every unresolved reserve, regardless of its age.
    if (reserve > this.config.maxTxFee || budgets.gas-tx.feeReserve+reserve > this.config.maxDailyGas || balance < reserve+(request.value ?? 0n)+this.config.minEth) {
      return [incident('replacement_budget','critical','A stuck transaction needs a fee increase beyond the permitted budget.')];
    }
    tx.request=request; tx.feeReserve=reserve; tx.attempts.push(await this.makeAttempt(request));
    this.store.saveTx(tx);
    return this.broadcast(tx);
  }
  async liquidate(candidate) {
    if (this.config.mode !== 'execute' || this.store.pendingTx()) return [];
    if ((this.store.get(`retry:${candidate.collateral}:${candidate.borrower}`) ?? 0) > Date.now()) return [];
    const budgets=this.store.budgets();
    const balance=await this.chain.token(this.config.usdg,'balanceOf',[this.chain.account.address]);
    const remainingDaily=this.config.dailyBudget-budgets.daily, remainingInventory=this.config.inventoryBudget-budgets.inventory;
    if (remainingDaily <= 0n || remainingInventory <= 0n) return [incident('capital_budget','critical','The liquidation spending or retained collateral budget is exhausted.')];
    const maxRepay=min(candidate.repaid,this.config.maxRepay,remainingDaily,remainingInventory,balance);
    if (maxRepay <= 0n) return [incident('liquidation_unfunded','critical','An unhealthy position cannot be liquidated because the keeper has no USDG.')];
    const allowance=await this.chain.token(this.config.usdg,'allowance',[this.chain.account.address,this.config.vault]);
    if (allowance < maxRepay) {
      // Set a bounded allowance. It is only usable by this immutable vault's transferFrom paths.
      const data=encodeFunctionData({abi:tokenAbi,functionName:'approve',args:[this.config.vault,maxRepay]});
      await this.chain.client.simulateContract({address:this.config.usdg,abi:tokenAbi,functionName:'approve',args:[this.config.vault,maxRepay],account:this.chain.account});
      return this.submit('approval',this.config.usdg,data,{collateral:candidate.collateral,borrower:candidate.borrower,maxRepay:0n});
    }
    const recipient=this.config.collateralRecipient ?? this.chain.account.address;
    const args=[candidate.collateral,candidate.borrower,maxRepay,recipient];
    try {
      const functionName=this.config.executionGate?'liquidateChecked':'liquidate';
      if(this.config.executionGate)args.push(await fetchLiveness(this.config));
      const simulation=await this.chain.client.simulateContract({address:this.config.vault,abi:vaultAbi,functionName,args,account:this.chain.account});
      if (simulation.result[0] <= 0n || simulation.result[0] > maxRepay || simulation.result[1] <= 0n) throw new Error('Invalid simulation result');
      return await this.submit('liquidation',this.config.vault,encodeFunctionData({abi:vaultAbi,functionName,args}),{
        collateral:candidate.collateral,borrower:candidate.borrower,maxRepay,recipient,
      });
    } catch (error) {
      const code=errorCode(error);
      this.store.set(`retry:${candidate.collateral}:${candidate.borrower}`,Date.now()+30000);
      if (code === 'PositionIsHealthy') return [];
      return [incident(`simulation:${candidate.collateral}:${candidate.borrower}`,'critical','Liquidation simulation or preparation failed; retrying after a cooldown.',{error:code})];
    }
  }
}
