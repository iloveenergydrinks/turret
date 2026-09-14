import { formatUnits, keccak256, parseAbi } from 'viem';
import { InputError } from './engine.mjs';

export const p2pAlertAbi = parseAbi([
  'function loanToken() view returns(address)', 'function collateralToken() view returns(address)',
  'function nextOfferId() view returns(uint256)',
  'function offers(uint256) view returns(address lender,address borrower,uint256 principal,uint256 collateralAmount,uint256 interest,uint256 duration,uint256 expiresAt,uint256 dueAt,uint8 status)',
  'function repaymentDeadline(uint256) view returns(uint256)',
  'function extensionProposals(uint256) view returns(address proposer,uint256 nonce,uint256 oldDeadline,uint256 newDeadline,uint256 expiresAt)',
  'function getAccountOfferIds(address,uint256,uint256) view returns(uint256[],uint256)',
  'event OfferAccepted(uint256 indexed id,uint256 dueAt,uint256 repaymentDeadline)',
  'event LoanRepaid(uint256 indexed id,address indexed payer,uint256 amount)',
  'event LoanDefaulted(uint256 indexed id)',
  'event ExtensionProposed(uint256 indexed id,address indexed proposer,uint256 nonce,uint256 oldDeadline,uint256 newDeadline,uint256 expiresAt)',
  'event ExtensionAccepted(uint256 indexed id,address indexed accepter,uint256 nonce,uint256 oldDeadline,uint256 newDeadline)',
]);
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const address = value => /^0x[0-9a-f]{40}$/i.test(value ?? '');
const hash = value => /^0x[0-9a-f]{64}$/i.test(value ?? '');
const instant = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000) throw new Error('Invalid loan time'); return n; };
const utc = seconds => new Date(seconds * 1000).toISOString().replace('.000Z',' UTC');

/** Read-only monitor. Every loan, event and deadline is bound to a reviewed manager and canonical block. */
export class P2PMonitor {
  constructor(engine,client,deployment) {
    Object.assign(this,{engine,client,deployment});
    this.healthyAt = 0; this.operationalAt = 0; this.monitorReason = 'unavailable';
    engine.validateP2PDelivery = job => this.validateDelivery(job);
  }
  get abi() { return p2pAlertAbi; }
  get noticeBrand() { return 'Turret P2P'; }
  loanDescription(market,loan) { return `${market.collateralSymbol} loan #${loan.id}`; }
  acceptanceDeadline(log) { return log.args.repaymentDeadline; }
  subscriptions() { return this.engine.store.all('subscription').filter(sub => sub.scope === this.deployment.scope && sub.consentId && sub.startBlock !== undefined); }
  read(market,block,functionName,args=[]) { return this.client.readContract({address:market.address,abi:this.abi,functionName,args,blockNumber:block.number}); }
  loanKey(market,id) { return `${market.address}:${id}`; }
  link(market,id) { return `${this.engine.origin}/p2p?market=${market.address}&offer=${id}`; }
  async verify(market,block) {
    const [code,loan,collateral] = await Promise.all([
      this.client.getCode({address:market.address,blockNumber:block.number}),
      this.read(market,block,'loanToken'),this.read(market,block,'collateralToken'),
    ]);
    if (!code || code === '0x' || !same(keccak256(code),market.runtimeHash) || !same(loan,market.loanToken)
      || !same(collateral,market.collateralToken)) throw new Error('P2P identity mismatch');
  }
  async loan(market,id,block) {
    const row = await this.read(market,block,'offers',[BigInt(id)]);
    if (!Array.isArray(row) || row.length !== 9 || !address(row[0]) || !address(row[1])
      || !Number.isInteger(row[8]) || row[8] < 1 || row[8] > 6
      || row.slice(2,8).some(n => typeof n !== 'bigint' || n < 0n)) throw new Error('Invalid P2P loan');
    const deadline = row[8] === 1 ? 0 : instant(market.version === 3 ? await this.read(market,block,'repaymentDeadline',[BigInt(id)]) : row[7] + 86400n);
    return {id:String(id),market:market.address,lender:row[0].toLowerCase(),borrower:row[1].toLowerCase(),
      principal:String(row[2]),interest:String(row[4]),status:row[8],deadline};
  }
  remember(market,loan) {
    const key = this.loanKey(market,loan.id);
    if (loan.status === 2 && this.subscriptions().some(sub=>sub.wallet===loan.lender||sub.wallet===loan.borrower)) this.engine.store.put('p2p-loan',key,loan);
    else this.engine.store.delete('p2p-loan',key);
  }
  async canonical(block) {
    if (!hash(block.hash) || (await this.client.getBlock({blockNumber:block.number})).hash !== block.hash) throw new Error('P2P block changed');
  }
  async head() {
    if (await this.client.getChainId() !== this.deployment.chainId) throw new Error('Wrong P2P chain');
    const block = await this.client.getBlock();
    if (!hash(block.hash) || Math.abs(this.engine.now()-instant(block.timestamp)*1000) > 60000) throw new Error('Stale P2P head');
    return block;
  }
  async scan() {
    try {
      const head = await this.head();
      const confirmedNumber = head.number >= BigInt(this.deployment.confirmations) ? head.number-BigInt(this.deployment.confirmations) : 0n;
      const confirmed = await this.client.getBlock({blockNumber:confirmedNumber});
      let complete = true;
      // A few markets at once bounds RPC load while avoiding a serial 20-market startup.
      for (let offset=0;offset<this.deployment.markets.length;offset+=4) {
        const results = await Promise.all(this.deployment.markets.slice(offset,offset+4).map(async market => {
          if (head.number < BigInt(market.startBlock)) throw new Error('P2P market not deployed');
          await this.verify(market,head);
          const eventsComplete = await this.events(market,confirmed);
          let discoveryComplete = true;
          for (const wallet of new Set(this.subscriptions().map(sub => sub.wallet))) {
            if (!await this.discover(market,wallet,head)) discoveryComplete = false;
          }
          const tracked = this.engine.store.all('p2p-loan').filter(row => row.market === market.address);
          const loans=[];
          for (let i=0;i<tracked.length;i+=20) loans.push(...await Promise.all(tracked.slice(i,i+20).map(row => this.loan(market,row.id,head))));
          await this.canonical(head);
          for (const loan of loans) { this.remember(market,loan); this.deadlineNotices(market,loan,head); }
          return eventsComplete && discoveryComplete;
        }));
        if (results.some(result => !result)) complete = false;
      }
      await this.canonical(head);
      if (Math.abs(this.engine.now()-Number(head.timestamp)*1000)>60000) throw new Error('P2P scan expired');
      this.operationalAt = this.engine.now(); this.healthyAt = complete ? this.engine.now() : 0;
      this.monitorReason = complete ? 'ready' : 'catching_up';
    } catch {
      this.healthyAt=0;this.operationalAt=0;this.monitorReason='unavailable';
      throw new Error('P2P alert scan failed');
    }
  }
  async discover(market,wallet,block) {
    const e=this.engine,key=`${market.address}:${wallet}`,saved=e.store.get('p2p-discovery',key);
    if (saved?.complete) return true;
    let cursor=BigInt(saved?.cursor ?? 0),complete=false;
    const rows=[];
    for (let page=0;page<4;page++) {
      let ids,next;
      if (market.version===1) {
        const upper=cursor || await this.read(market,block,'nextOfferId');
        const lower=upper>40n?upper-40n:1n;
        ids=Array.from({length:Number(upper>lower?upper-lower:0n)},(_,i)=>upper-1n-BigInt(i));
        next=lower>1n?lower:0n;
      } else [ids,next]=await this.read(market,block,'getAccountOfferIds',[wallet,cursor,40n]);
      if (!Array.isArray(ids)||ids.length>40||new Set(ids).size!==ids.length||typeof next!=='bigint'||next<0n
        ||(cursor>0n&&next>=cursor)||ids.some(id=>typeof id!=='bigint'||id<=0n)) throw new Error('Invalid P2P discovery');
      rows.push(...await Promise.all(ids.map(id=>this.loan(market,id,block))));
      cursor=next;
      if(next===0n){complete=true;break;}
    }
    await this.canonical(block);
    if (!this.subscriptions().some(sub=>sub.wallet===wallet)) return true;
    for(const loan of rows) if(loan.lender===wallet||loan.borrower===wallet)this.remember(market,loan);
    e.store.put('p2p-discovery',key,{wallet,cursor:String(cursor),complete});
    return complete;
  }
  async events(market,confirmed) {
    const e=this.engine,key=`p2p:${market.address}`;
    let cursor=e.store.get('cursor',key),subscriptions=this.subscriptions();
    if (!cursor) {
      // Historical obligations are discovered separately; lifecycle messages start at verified consent.
      const start=subscriptions.reduce((n,s)=>BigInt(s.startBlock)<n?BigInt(s.startBlock):n,confirmed.number);
      const block=await this.client.getBlock({blockNumber:start});
      cursor={block:String(start),hash:block.hash};
    }
    if ((await this.client.getBlock({blockNumber:BigInt(cursor.block)})).hash!==cursor.hash) throw new Error('P2P event cursor reorg');
    if (BigInt(cursor.block)>=confirmed.number) return true;
    const fromBlock=BigInt(cursor.block)+1n,toBlock=fromBlock+9999n<confirmed.number?fromBlock+9999n:confirmed.number;
    const end=await this.client.getBlock({blockNumber:toBlock});
    const logs=await this.client.getContractEvents({address:market.address,abi:this.abi,fromBlock,toBlock,strict:true});
    if(logs.length>20000)throw new Error('P2P event capacity');
    const notices=[];
    for(const log of logs) {
      if(log.removed||!same(log.address,market.address)||log.blockNumber<fromBlock||log.blockNumber>toBlock
        ||!hash(log.transactionHash)||!Number.isSafeInteger(log.logIndex)||typeof log.args.id!=='bigint') throw new Error('Invalid P2P event');
      const block=await this.client.getBlock({blockNumber:log.blockNumber});
      if(block.hash!==log.blockHash)throw new Error('P2P event reorg');
      const loan=await this.loan(market,log.args.id,end);
      notices.push({log,loan});
    }
    await this.canonical(end);
    for(const {log,loan} of notices) {
      this.remember(market,loan);
      const label={OfferAccepted:'Loan accepted',LoanRepaid:'Loan repaid',LoanDefaulted:'Default settled',
        ExtensionProposed:'Deadline extension proposed',ExtensionAccepted:'Deadline extension agreed'}[log.eventName];
      if(!label)continue;
      const detail=log.eventName==='ExtensionProposed'||log.eventName==='ExtensionAccepted'
        ? `Proposed or agreed final deadline: ${utc(instant(log.args.newDeadline))}. ${log.eventName==='ExtensionProposed'?'A proposal alone does not change the deadline. Review it and explicitly accept to extend the loan.':''}`
        : log.eventName==='LoanDefaulted'?'The collateral claim belongs to the lender; the USDG debt is settled.'
        : log.eventName==='LoanRepaid'?'The debt is settled. The lender’s USDG and borrower’s collateral can be withdrawn separately.'
        : `Total repayment: ${formatUnits(BigInt(loan.principal)+BigInt(loan.interest),market.loanDecimals)} USDG. Final deadline: ${utc(instant(this.acceptanceDeadline(log)))}.`;
      for(const sub of this.subscriptions()) {
        if(![loan.lender,loan.borrower].includes(sub.wallet)||log.blockNumber<=BigInt(sub.startBlock)
          ||(log.eventName==='ExtensionProposed'&&same(sub.wallet,log.args.proposer)))continue;
        const id=`p2p:${sub.consentId}:${market.address}:${log.transactionHash}:${log.logIndex}`;
        e.enqueue(id,{kind:log.eventName==='ExtensionProposed'?'p2p-proposal':'p2p-event',scope:this.deployment.scope,
          subId:sub.id,consentId:sub.consentId,market:market.address,loanId:loan.id,
          eventBlock:String(log.blockNumber),eventHash:log.blockHash,eventName:log.eventName,
          ...(log.args.nonce===undefined?{}:{proposalNonce:String(log.args.nonce)}),
          text:`${this.noticeBrand}: ${label}.\n${this.loanDescription(market,loan)}\n${detail}\n${this.link(market,loan.id)}\nNotifications can be delayed. Check the current loan before acting.`});
      }
    }
    e.store.put('cursor',key,{block:String(toBlock),hash:end.hash});
    return toBlock===confirmed.number;
  }
  deadlineNotices(market,loan,block) {
    const e=this.engine,remaining=loan.deadline-Number(block.timestamp);
    const phase=remaining<0?'overdue':remaining<=3600?'hour':remaining<=86400?'day':null;
    for(const job of e.store.all('outbox')) if(job.kind==='p2p-deadline'&&job.market===market.address&&job.loanId===loan.id
      &&(loan.status!==2||job.deadline!==loan.deadline||job.phase!==phase))e.store.delete('outbox',job.id);
    if(loan.status!==2||!phase)return;
    for(const sub of this.subscriptions()) {
      if(![loan.lender,loan.borrower].includes(sub.wallet))continue;
      const borrower=sub.wallet===loan.borrower;
      const title=phase==='overdue'?'Final repayment deadline passed':phase==='hour'?'Final repayment deadline within one hour':'Repayment deadline within one day';
      const action=phase==='overdue'?'Repayment is no longer available. Default settlement assigns the collateral to the lender.'
        :borrower?`Repay the full ${formatUnits(BigInt(loan.principal)+BigInt(loan.interest),market.loanDecimals)} USDG before the final deadline to recover your collateral.`
        :'Your borrower must repay before the final deadline. If they do not, default settlement becomes available after it.';
      e.enqueue(`p2p:${sub.consentId}:${market.address}:${loan.id}:${loan.deadline}:${phase}`,{
        kind:'p2p-deadline',scope:this.deployment.scope,subId:sub.id,consentId:sub.consentId,market:market.address,
        loanId:loan.id,deadline:loan.deadline,phase,until:phase==='overdue'?e.now()+86400000:loan.deadline*1000+1000,
        text:`${this.noticeBrand}: ${title}.\n${this.loanDescription(market,loan)}\nFinal deadline: ${utc(loan.deadline)}\n${action}\n${this.link(market,loan.id)}\nNotifications do not extend deadlines and can be delayed or missed.`});
    }
  }
  async validateDelivery(job) {
    if(!this.operationalAt||this.engine.now()-this.operationalAt>=90000)return false;
    const sub=this.engine.store.get('subscription',job.subId);
    const market=this.deployment.markets.find(row=>row.address===job.market);
    if(!market||sub?.consentId!==job.consentId||sub.scope!==this.deployment.scope)return false;
    const block=await this.head();await this.verify(market,block);
    const loan=await this.loan(market,job.loanId,block);
    if(![loan.lender,loan.borrower].includes(sub.wallet))throw new Error('Unrelated P2P recipient');
    let obsolete=false;
    if(job.eventBlock) {
      if(BigInt(job.eventBlock)+BigInt(this.deployment.confirmations)>block.number)return false;
      if((await this.client.getBlock({blockNumber:BigInt(job.eventBlock)})).hash!==job.eventHash)throw new Error('P2P notification reorg');
      if(BigInt(job.eventBlock)<=BigInt(sub.startBlock))obsolete=true;
    }
    if(job.kind==='p2p-deadline') {
      const remaining=loan.deadline-Number(block.timestamp);
      const phase=remaining<0?'overdue':remaining<=3600?'hour':remaining<=86400?'day':null;
      obsolete=loan.status!==2||loan.deadline!==job.deadline||phase!==job.phase;
    }
    if(job.kind==='p2p-proposal') {
      const proposal=await this.read(market,block,'extensionProposals',[BigInt(job.loanId)]);
      obsolete=loan.status!==2||String(proposal[1])!==job.proposalNonce||proposal[4]<=block.timestamp;
    }
    await this.canonical(block);
    if(obsolete)this.engine.store.delete('outbox',job.id);
    return !obsolete;
  }
  async watch() { throw new InputError('P2P notifications follow verified loan events automatically'); }
}
