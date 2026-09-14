import {createRequire} from 'node:module';
import {Transactions,ReceiptValidationError,feeReserve} from '../../liquidator/src/transactions.mjs';
import {incident} from '../../liquidator/src/alerts.mjs';
import {API3_SERVER,API3_SERVER_HASH,API3_USDG_SOURCES,api3UsdgAbi,verifyApi3UsdgPackage,
  verifyApi3UsdgAdapter,summarizeApi3Usdg} from './api3-usdg.mjs';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
const {decodeFunctionData,encodeFunctionData,decodeFunctionResult,decodeEventLog,parseAbi,keccak256,
  parseTransaction,recoverTransactionAddress}=require('viem');
const api3EventAbi=parseAbi(['event UpdatedBeaconWithSignedData(bytes32 indexed beaconId,int224 value,uint32 timestamp)']);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,message)=>{if(!ok)throw new ReceiptValidationError(message);};

/** Only canonical zero-value USDG beacon updates are valid persisted intents.
 * Age checks belong at signing, not historical receipt reconciliation. */
export async function api3PublicationIntent(request){
  demand(request?.chainId===4663&&same(request.to,API3_SERVER)&&request.value===0n,'InvalidApi3PublicationTarget');
  demand(typeof request.data==='string'&&request.data.length<=16000,'InvalidApi3PublicationData');
  try{
    const decoded=decodeFunctionData({abi:api3UsdgAbi,data:request.data});
    demand(decoded.functionName==='multicall'&&decoded.args[0].length>0&&decoded.args[0].length<=5,'InvalidApi3PublicationBatch');
    const calls=decoded.args[0],rows=[];
    demand(same(encodeFunctionData({abi:api3UsdgAbi,functionName:'multicall',args:[calls]}),request.data),'NonCanonicalApi3Publication');
    for(const data of calls){
      const update=decodeFunctionData({abi:api3UsdgAbi,data});
      demand(update.functionName==='updateBeaconWithSignedData','InvalidApi3PublicationCall');
      demand(same(encodeFunctionData({abi:api3UsdgAbi,functionName:update.functionName,args:update.args}),data),'NonCanonicalApi3Update');
      const [airnode,templateId,timestamp,encodedValue,signature]=update.args;
      rows.push(await verifyApi3UsdgPackage({airnode,templateId,timestamp:String(timestamp),encodedValue,signature}));
    }
    demand(new Set(rows.map(r=>r.beaconId)).size===rows.length,'DuplicateApi3PublicationBeacon');
    return {rows,calls};
  }catch(error){
    if(error instanceof ReceiptValidationError)throw error;
    throw new ReceiptValidationError('InvalidApi3SignedPublication');
  }
}

export async function confirmedApi3Publication(receipt,tx,{account,client}){
  demand(tx.kind==='api3_usdg_update'&&receipt.status==='success','InvalidApi3ReceiptOperation');
  demand(same(receipt.from,account)&&same(receipt.to,API3_SERVER)
    &&tx.attempts.some(a=>same(a.hash,receipt.transactionHash)),'InvalidApi3ReceiptIdentity');
  const {rows}=await api3PublicationIntent(tx.request),events=[];
  for(const log of receipt.logs){
    if(!same(log.address,API3_SERVER))continue;
    demand(!log.removed,'RemovedApi3ReceiptLog');
    try{
      const event=decodeEventLog({abi:api3EventAbi,data:log.data,topics:log.topics});
      events.push(event.args);
    }catch{throw new ReceiptValidationError('InvalidApi3ReceiptLog');}
  }
  // Native API3 reverts on equal/older timestamps: a successful batch must
  // emit every requested update, not a guessed "already published" no-op.
  demand(events.length===rows.length&&new Set(events.map(e=>e.beaconId)).size===rows.length,'MissingApi3ReceiptEvents');
  const superseded=[];
  for(const p of rows){
    const event=events.find(e=>same(e.beaconId,p.beaconId));
    demand(event&&event.value===p.price18&&BigInt(event.timestamp)===p.timestamp,'Api3ReceiptContentMismatch');
    const cached=await client.readContract({address:API3_SERVER,abi:api3UsdgAbi,functionName:'dataFeeds',args:[p.beaconId],blockNumber:receipt.blockNumber});
    demand(Array.isArray(cached)&&typeof cached[0]==='bigint'&&Number.isSafeInteger(cached[1])
      &&BigInt(cached[1])>=p.timestamp,'Api3ReceiptCacheMissing');
    if(BigInt(cached[1])===p.timestamp)demand(cached[0]===p.price18,'Api3ReceiptCacheMismatch');
    else superseded.push(p.beaconId);
  }
  return {publicationResult:{updatedBeaconIds:rows.map(p=>p.beaconId),supersededAtReceiptBlock:superseded}};
}

/** Replays the exact intended calls, not a newly fetched replacement report. */
export async function recheckApi3Publication({client,request,publication,account,now=Date.now}){
  demand(await client.getChainId()===4663,'WrongApi3PublicationChain');
  const {rows,calls}=await api3PublicationIntent(request),head=await client.getBlock();
  const wall=()=>BigInt(Math.floor(now()/1000));
  demand(head.hash&&typeof head.number==='bigint'&&head.timestamp<=wall()+15n&&wall()-head.timestamp<30n,'StaleApi3SigningHead');
  const at={blockNumber:head.number};
  demand(same(keccak256(await client.getCode({address:API3_SERVER,...at})),API3_SERVER_HASH),'Api3SigningServerChanged');
  await verifyApi3UsdgAdapter(client,publication,head.number);
  for(const p of rows)demand(p.timestamp<=head.timestamp&&p.timestamp<=wall()
    &&head.timestamp-p.timestamp<60n&&wall()-p.timestamp<60n,'Api3SigningDataExpired');
  const before=await Promise.all(API3_USDG_SOURCES.map(p=>client.readContract({address:API3_SERVER,abi:api3UsdgAbi,
    functionName:'dataFeeds',args:[p.beaconId],...at})));
  const expected=API3_USDG_SOURCES.map((p,i)=>{
    const update=rows.find(r=>r.beaconId===p.beaconId);
    if(update){demand(update.timestamp>BigInt(before[i][1]),'Api3IntentSuperseded');return update;}
    return {...p,price18:before[i][0],timestamp:BigInt(before[i][1])};
  });
  const reads=API3_USDG_SOURCES.map(p=>encodeFunctionData({abi:api3UsdgAbi,functionName:'dataFeeds',args:[p.beaconId]}));
  const result=await client.simulateContract({address:API3_SERVER,abi:api3UsdgAbi,functionName:'multicall',
    args:[[...calls,...reads]],account,value:0n,...at});
  demand(result.result.length===calls.length+5,'Api3SigningSimulationMismatch');
  const effective=expected.map((p,i)=>{
    const [price18,timestamp]=decodeFunctionResult({abi:api3UsdgAbi,functionName:'dataFeeds',data:result.result[calls.length+i]});
    demand(price18===p.price18&&BigInt(timestamp)===p.timestamp,'Api3SigningReadbackMismatch');
    return p;
  });
  summarizeApi3Usdg(effective,head.timestamp);
  const quote=summarizeApi3Usdg(effective,wall());
  demand(same((await client.getBlock(at)).hash,head.hash),'Api3SigningReorg');
  demand(wall()-head.timestamp<30n&&wall()-quote.oldestTimestamp<60n,'Api3SigningExpiredDuringCheck');
  return {block:head.number,blockHash:head.hash,quote};
}

export class Api3UsdgTransactions extends Transactions {
  constructor(chain,store,config,{now=Date.now}={}){super(chain,store,config);this.now=now;}
  gasCommitted(excludeId){
    // A pending nonce never ages out of the budget. Confirmed gas is charged
    // when reconciled, not when an old transaction was first prepared.
    return this.store.transactions().filter(t=>t.id!==excludeId).reduce((sum,t)=>{
      if(t.status==='pending'||t.status==='blocked')return sum+t.feeReserve;
      return !t.finalizedAt||t.finalizedAt>this.now()-86400000?sum+(t.actualGas??t.feeReserve):sum;
    },0n);
  }
  async checkBudget(request,pending){
    const reserve=feeReserve(request),held=pending&&pending.feeReserve>reserve?pending.feeReserve:reserve;
    demand(reserve<=this.config.maxTxFee&&this.gasCommitted(pending?.id)+held<=this.config.maxDailyGas,'Api3RecoveryGasBudget');
    demand(await this.chain.client.getBalance({address:this.chain.account.address})>=held+this.config.minEth,'Api3RecoveryGasReserve');
    return held;
  }
  async makeAttempt(request){
    demand(this.config.mode==='execute'&&this.chain.consistent,'Api3SigningNotAuthorized');
    const pending=this.store.pendingTx();
    if(pending)demand(pending.kind==='api3_usdg_update'&&pending.status==='pending'
      &&pending.request.nonce===request.nonce&&same(pending.request.to,request.to)
      &&same(pending.request.data,request.data)&&pending.request.value===request.value,'ChangedApi3ReplacementIntent');
    await recheckApi3Publication({client:this.chain.client,request,publication:this.config.publication,
      account:this.chain.account.address,now:this.now});
    await this.checkBudget(request,pending);
    return super.makeAttempt(request);
  }
  async cancellationContext(tx,request){
    demand(this.config.mode==='execute'&&this.chain.consistent,'Api3CancellationNotAuthorized');
    this.store.assertLease();
    demand(tx.kind==='api3_usdg_update'&&tx.status==='pending'&&this.store.pendingTx()?.id===tx.id,'InvalidApi3CancellationJournal');
    await api3PublicationIntent(tx.request);
    const address=this.chain.account.address,client=this.chain.client;
    demand(request.chainId===4663&&same(request.to,address)&&request.value===0n&&request.data==='0x'
      &&request.nonce===tx.request.nonce&&request.gas>0n&&request.gas<=150000n
      &&(!request.accessList||request.accessList.length===0),'InvalidApi3CancellationIntent');
    demand(await client.getChainId()===4663,'WrongApi3CancellationChain');
    const head=await client.getBlock(),wall=BigInt(Math.floor(this.now()/1000));
    demand(head.hash&&typeof head.number==='bigint'&&head.timestamp<=wall+15n&&wall-head.timestamp<30n,'StaleApi3CancellationHead');
    const [code,latest,pending]=await Promise.all([client.getCode({address,blockNumber:head.number}),
      client.getTransactionCount({address,blockTag:'latest'}),client.getTransactionCount({address,blockTag:'pending'})]);
    demand(!code||code==='0x','Api3CancellationRecipientHasCode');
    demand(latest===request.nonce&&pending>=latest&&pending<=latest+1,'Api3CancellationNonceChanged');
    demand(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'Api3CancellationReorg');
  }
  async obsoleteReason(tx){
    const {rows}=await api3PublicationIntent(tx.request),client=this.chain.client;
    const head=await client.getBlock(),wall=BigInt(Math.floor(this.now()/1000));
    demand(await client.getChainId()===4663&&head.hash&&head.timestamp<=wall+15n&&wall-head.timestamp<30n,'StaleApi3RecoveryHead');
    if(rows.some(p=>wall-p.timestamp>=60n||head.timestamp-p.timestamp>=60n))return 'expired';
    demand(same(keccak256(await client.getCode({address:API3_SERVER,blockNumber:head.number})),API3_SERVER_HASH),'Api3RecoveryServerChanged');
    const values=await Promise.all(rows.map(p=>client.readContract({address:API3_SERVER,abi:api3UsdgAbi,
      functionName:'dataFeeds',args:[p.beaconId],blockNumber:head.number})));
    demand(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'Api3RecoveryReorg');
    return values.some((p,i)=>BigInt(p[1])>=rows[i].timestamp)?'superseded':null;
  }
  async cancel(tx,reason){
    const previous=tx.attempts.at(-1);
    if(previous.operation==='cancel'&&this.now()-previous.signedAt<this.config.replaceAfterMs)return this.broadcast(tx);
    if(tx.attempts.filter(a=>a.operation==='cancel').length>=this.config.maxReplacements+1)
      return [incident('api3_cancellation_stuck','critical','Oracle nonce cancellation reached its bounded replacement limit; receipt reconciliation continues.')];
    try{
      const prior=previous.operation==='cancel'?previous.request:tx.request;
      const prepared=await this.chain.wallet.prepareTransactionRequest({account:this.chain.account,
        to:this.chain.account.address,value:0n,data:'0x',nonce:tx.request.nonce,type:prior.type});
      const request={chainId:4663,type:prior.type,to:this.chain.account.address,value:0n,data:'0x',
        nonce:tx.request.nonce,gas:prepared.gas*120n/100n};
      for(const field of ['gasPrice','maxFeePerGas','maxPriorityFeePerGas'])if(prior[field]!==undefined){
        const bumped=prior[field]*120n/100n+1n;
        request[field]=prepared[field]>bumped?prepared[field]:bumped;
      }
      await this.cancellationContext(tx,request);
      const held=await this.checkBudget(request,tx);
      const attempt={...await super.makeAttempt(request),signedAt:this.now(),operation:'cancel',request};
      tx.cancellation={reason};tx.feeReserve=held;tx.attempts.push(attempt);
      this.store.saveTx(tx);
      return this.broadcast(tx);
    }catch(error){return [incident('api3_cancellation_unavailable','critical','The obsolete oracle update could not be cancelled within its execution and gas limits; its nonce remains tracked.',
      {reason:error instanceof ReceiptValidationError?error.message:'Api3CancellationPreparationFailed'})];}
  }
  async recover(head,canBroadcast){
    const before=this.store.pendingTx();
    const notices=await super.recover(head,false);
    if(before&&!this.store.pendingTx()){
      const final=this.store.transactions().find(t=>t.id===before.id);
      final.finalizedAt=this.now();
      if(final.attempts.find(a=>same(a.hash,final.receipt?.hash))?.operation==='cancel')final.kind='api3_usdg_cancel';
      this.store.saveTx(final);
    }
    const tx=this.store.pendingTx();
    // This notice specifically means no known receipt exists and the nonce has
    // not been consumed. A mined, unconfirmed receipt instead returns []: wait.
    if(!tx||!canBroadcast||this.config.mode!=='execute'||!this.chain.consistent
      ||!notices.some(i=>i.code==='pending_execution_blocked'))return notices;
    const reason=tx.cancellation?.reason??await this.obsoleteReason(tx);
    if(reason)return this.cancel(tx,reason);
    return super.recover(head,true);
  }
  async broadcast(tx){
    if(this.config.mode!=='execute'||!this.chain.consistent)return [incident('api3_broadcast_disabled','critical','API3 publication execution is disabled or RPCs disagree.')];
    try{
      demand(tx.kind==='api3_usdg_update'&&tx.status==='pending','InvalidApi3BroadcastOperation');
      const attempt=tx.attempts.at(-1),signed=parseTransaction(attempt.raw);
      const request=attempt.operation==='cancel'?attempt.request:tx.request;
      demand(same(keccak256(attempt.raw),attempt.hash)
        &&same(await recoverTransactionAddress({serializedTransaction:attempt.raw}),this.chain.account.address),'InvalidApi3SignedIntent');
      // viem omits RLP-empty numeric fields when decoding a signed zero.
      demand(signed.type===request.type&&signed.chainId===request.chainId&&(signed.nonce??0)===request.nonce
        &&(signed.value??0n)===request.value,'ChangedApi3SignedIntent');
      demand(same(signed.to,request.to)&&same(signed.data??'0x',request.data),'ChangedApi3SignedIntent');
      for(const key of ['gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas'])
        demand(signed[key]===request[key]||(signed[key]===undefined&&request[key]===0n),'ChangedApi3SignedFees');
      if(attempt.operation==='cancel')await this.cancellationContext(tx,request);
      else await recheckApi3Publication({client:this.chain.client,request,publication:this.config.publication,
        account:this.chain.account.address,now:this.now});
      await this.checkBudget(request,tx);
    }catch(error){return [incident('api3_publication_unavailable','critical','The persisted API3 update cannot currently be published. Its nonce remains tracked; receipt reconciliation continues.',
      {reason:error instanceof ReceiptValidationError?error.message:'Api3ReadOrSimulationFailed'})];}
    return super.broadcast(tx);
  }
  async publish(plan){
    if(this.config.mode!=='execute'||this.store.pendingTx()||!plan.shouldSubmit)return [];
    demand(plan.chainId===4663&&same(plan.adapter,this.config.publication.adapter)
      &&same(plan.adapterCodeHash,this.config.publication.adapterCodeHash),'UnboundApi3PublicationPlan');
    await api3PublicationIntent({chainId:plan.chainId,to:plan.to,data:plan.data,value:plan.value});
    return this.submit('api3_usdg_update',plan.to,plan.data,{},plan.value);
  }
  async confirmationDetails(receipt,tx){
    const attempt=tx.attempts.find(a=>same(a.hash,receipt.transactionHash));
    if(attempt?.operation==='cancel'){
      const signed=parseTransaction(attempt.raw);
      demand(receipt.status==='success'&&same(receipt.from,this.chain.account.address)
        &&same(receipt.to,this.chain.account.address)&&same(signed.to,this.chain.account.address)
        &&same(keccak256(attempt.raw),receipt.transactionHash)
        &&same(await recoverTransactionAddress({serializedTransaction:attempt.raw}),this.chain.account.address)
        &&signed.chainId===4663&&(signed.nonce??0)===tx.request.nonce
        &&(signed.value??0n)===0n&&(signed.data??'0x')==='0x','InvalidApi3CancellationReceipt');
      return {kind:'api3_usdg_cancel',cancellationResult:{reason:tx.cancellation.reason},publicationResult:null};
    }
    return confirmedApi3Publication(receipt,tx,{account:this.chain.account.address,client:this.chain.client});
  }
}
