import {parseAbi,decodeEventLog,encodeFunctionData,keccak256} from 'viem';
import {swapAbi} from './quote.mjs';
export const abi=[...swapAbi,...parseAbi(['function availableBudget() view returns(uint256)','function totalSpent() view returns(uint256)','function totalBurned() view returns(uint256)','function lastBuyback() view returns(uint256)','function treasury() view returns(address)','function keeper() view returns(address)','function paused() view returns(bool)','function reserveFloor() view returns(uint256)','function HOURLY_RATE() view returns(uint256)','function usdg() view returns(address)','function turret() view returns(address)','function swapRouter() view returns(address)','function swapTarget() view returns(address)','function configure(address,uint256)','function setPaused(bool)','event BoughtAndBurned(uint256 usdgSpent,uint256 turretBurned,uint256 timestamp)'])];
// Exact same nested tuple as Kyber, with a module-enforced outer deadline.
abi.push({...swapAbi[0],name:'execute',inputs:[swapAbi[0].inputs[0],{name:'deadline',type:'uint256'}],outputs:[],stateMutability:'nonpayable'});
const same=(a,b)=>a?.toLowerCase()===b?.toLowerCase();
export function verifyBurn(receipt,module,amount){const events=[];for(const log of receipt.logs){if(!same(log.address,module))continue;try{const e=decodeEventLog({abi,data:log.data,topics:log.topics});if(e.eventName==='BoughtAndBurned')events.push(e.args);}catch{}}
 if(events.length!==1||events[0].usdgSpent!==amount||events[0].turretBurned<=0n)throw Error('burn_receipt_mismatch');return events[0];}
export class BuybackWorker {
 constructor(deps){Object.assign(this,deps);}
 async broadcast(tx){this.store.assertLease();if(this.config.mode!=='execute')return {reason:'observe_pending',hash:tx.hash};try{if(!same(await this.client.sendRawTransaction({serializedTransaction:tx.raw}),tx.hash))throw Error();return {reason:'pending',hash:tx.hash};}catch{return {reason:'broadcast_uncertain',hash:tx.hash};}}
 async recover(head){const tx=this.store.pendingTx();if(!tx)return null;if(tx.status==='blocked')return {reason:'manual_reconciliation_required',hash:tx.hash};let r;try{r=await this.client.getTransactionReceipt({hash:tx.hash});}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
 if(!r){if(await this.client.getTransactionCount({address:this.account.address,blockTag:'latest'})>tx.nonce){tx.status='blocked';this.store.saveTx(tx);return {reason:'nonce_consumed_without_receipt'};}return this.broadcast(tx);}
 if(!same(r.transactionHash,tx.hash)||!same(r.from,this.account.address)||!same(r.to,this.config.module))throw Error('receipt_identity_mismatch');
 if((await this.client.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash||head.number<r.blockNumber+2n)return {reason:'confirming',hash:tx.hash};
 if(r.status==='success'){try{tx.burn=verifyBurn(r,this.config.module,tx.amount);}catch{tx.status='blocked';this.store.saveTx(tx);return {reason:'burn_receipt_mismatch',hash:tx.hash};}}
 tx.status=r.status==='success'?'confirmed':'reverted';tx.actualGas=r.gasUsed*r.effectiveGasPrice;tx.settledAt=Date.now();tx.block=r.blockNumber;tx.blockHash=r.blockHash;this.store.saveTx(tx);return {reason:tx.status,hash:tx.hash};}
 async cycle(){this.store.assertLease();const head=await this.verify();const recovered=await this.recover(head);if(recovered)return recovered;
 const budget=await this.client.readContract({address:this.config.module,abi,functionName:'availableBudget',blockNumber:head.number});if(budget<1000000n)return {reason:'waiting_for_hour_balance_or_allowance'};
 if(this.config.mode!=='execute')return {reason:'observe_ready'};
 const now=this.now??Date.now,retry=this.store.get('quoteRetry');
 if(retry?.nextRetryAt>now())return {reason:'quote_retry_wait',nextRetryAt:retry.nextRetryAt};
 // Resume the size search, never cached calldata. Recheck the live contract
 // maximum before every quote, including when the treasury balance decreases.
 const candidate=this.config.sizingPolicy!=='full-budget'&&typeof retry?.candidateAmount==='bigint'&&retry.candidateAmount>=1000000n&&retry.candidateAmount<budget?retry.candidateAmount:budget;
 let q;try{q=await this.quote(this.config.module,candidate);}catch(e){
  if(e.message!=='quote_rate_limited')throw e;
  const failures=(retry?.failures??0)+1,delay=Math.max(Number.isFinite(e.retryAfterMs)?e.retryAfterMs:60000,Math.min(900000,60000*2**Math.min(failures-1,4)));
  const nextRetryAt=now()+delay,candidateAmount=typeof e.candidateAmount==='bigint'&&e.candidateAmount>=1000000n&&e.candidateAmount<=candidate?e.candidateAmount:candidate;this.store.assertLease();this.store.set('quoteRetry',{failures,nextRetryAt,candidateAmount});return {reason:'quote_rate_limited',nextRetryAt};
 }
 this.store.assertLease();if(retry)this.store.set('quoteRetry',null);
 const amount=q.amount;if(typeof amount!=='bigint'||amount<1000000n||amount>budget||q.execution.desc.amount!==amount||(this.config.sizingPolicy==='full-budget'&&amount!==budget))throw Error('quote_amount_outside_budget');const addr=this.account.address;
 const [nonce,pending,balance]=await Promise.all([this.client.getTransactionCount({address:addr,blockTag:'latest'}),this.client.getTransactionCount({address:addr,blockTag:'pending'}),this.client.getBalance({address:addr})]);if(nonce!==pending)return {reason:'untracked_pending_nonce'};
 const args=[q.execution,q.deadline];await this.client.simulateContract({address:this.config.module,abi,functionName:'execute',args,account:addr});
 const data=encodeFunctionData({abi,functionName:'execute',args});const p=await this.wallet.prepareTransactionRequest({account:this.account,to:this.config.module,data,value:0n,nonce});
 if(p.chainId!==4663)throw Error('wrong_chain');const request=Object.fromEntries(['chainId','type','to','data','value','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','nonce','accessList'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));request.gas=request.gas*120n/100n;
 const reserve=request.gas*(request.gasPrice??request.maxFeePerGas);if(reserve>this.config.maxTxFee||this.store.budgets().gas+reserve>this.config.maxDailyGas)return {reason:'gas_budget_exceeded'};if(balance<reserve+this.config.minEth)return {reason:'gas_funding_required'};
 if(q.deadline<=BigInt(Math.floor(Date.now()/1000)+5))return {reason:'quote_expired'};
 this.store.assertLease();const raw=await this.account.signTransaction(request),hash=keccak256(raw);const tx={id:hash,kind:'hourly_buyback',status:'pending',createdAt:Date.now(),raw,hash,nonce,feeReserve:reserve,amount};this.store.saveTx(tx);return this.broadcast(tx);
 }
}
