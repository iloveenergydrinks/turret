import { keccak256, parseAbi } from 'viem';
import { P2PMonitor } from './p2p-monitor.mjs';

export const nftAlertAbi=parseAbi([
  'function loanToken() view returns(address)',
  'function accountOffers(address,uint256,uint256) view returns(uint256[],uint256)',
  'function getOffer(uint256) view returns((address lender,(address borrower,address collection,uint256 tokenId,uint256 principal,uint256 interest,uint256 duration,uint256 expiresAt) terms,address vault,uint256 dueAt,uint8 status,uint256 usdgCredit,address nftBeneficiary))',
  'event OfferAccepted(uint256 indexed id,address indexed borrower,uint256 dueAt,uint256 finalDeadline)',
  'event LoanRepaid(uint256 indexed id,address indexed payer,uint256 amount)',
  'event LoanDefaulted(uint256 indexed id)',
]);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const address=value=>/^0x[0-9a-f]{40}$/i.test(value??'');
const uint=value=>typeof value==='bigint'&&value>=0n&&value<2n**256n;

/** NFT-specific reads; canonical event delivery, durable retries and consent reuse the P2P monitor. */
export class NFTMonitor extends P2PMonitor {
  get abi(){return nftAlertAbi;}
  get noticeBrand(){return 'Turret NFT P2P';}
  acceptanceDeadline(log){return log.args.finalDeadline;}
  loanDescription(market,loan){return `NFT loan #${loan.id}\nCollection: ${loan.collection}\nNFT token ID: ${loan.tokenId}`;}
  link(market,id){return `${this.engine.origin}/p2p/nfts?offer=${id}`;}
  async verify(market,block){
    const [code,loan,decimals]=await Promise.all([
      this.client.getCode({address:market.address,blockNumber:block.number}),this.read(market,block,'loanToken'),
      this.client.readContract({address:market.loanToken,abi:parseAbi(['function decimals() view returns(uint8)']),functionName:'decimals',blockNumber:block.number}),
    ]);
    if(!code||code==='0x'||!same(keccak256(code),market.runtimeHash)||!same(loan,market.loanToken)||decimals!==market.loanDecimals)throw new Error('NFT identity mismatch');
  }
  async loan(market,id,block){
    const row=await this.read(market,block,'getOffer',[BigInt(id)]),terms=row?.terms;
    if(!row||!terms||!address(row.lender)||!address(terms.borrower)||!address(terms.collection)||!address(row.vault)
      ||!Number.isInteger(row.status)||row.status<1||row.status>6||!uint(row.dueAt)
      ||['tokenId','principal','interest','duration','expiresAt'].some(key=>!uint(terms[key])))throw new Error('Invalid NFT loan');
    const deadline=row.dueAt===0n?0:Number(row.dueAt+86400n);
    if(!Number.isSafeInteger(deadline)||deadline>8_640_000_000_000)throw new Error('Invalid NFT deadline');
    return {id:String(id),market:market.address,lender:row.lender.toLowerCase(),borrower:terms.borrower.toLowerCase(),
      collection:terms.collection.toLowerCase(),tokenId:String(terms.tokenId),principal:String(terms.principal),
      interest:String(terms.interest),status:row.status,deadline};
  }
  async discover(market,wallet,block){
    const e=this.engine,key=`${market.address}:${wallet}`,saved=e.store.get('p2p-discovery',key);
    if(saved?.complete)return true;
    let cursor=BigInt(saved?.cursor??0),complete=false;
    const rows=[];
    for(let page=0;page<4;page++){
      const [ids,next]=await this.read(market,block,'accountOffers',[wallet,cursor,40n]);
      if(!Array.isArray(ids)||ids.length>40||new Set(ids).size!==ids.length||typeof next!=='bigint'
        ||next!==cursor+BigInt(ids.length)||ids.some(id=>!uint(id)||id===0n))throw new Error('Invalid NFT discovery');
      rows.push(...await Promise.all(ids.map(id=>this.loan(market,id,block))));
      cursor=next;
      if(ids.length<40){complete=true;break;}
    }
    await this.canonical(block);
    if(!this.subscriptions().some(sub=>sub.wallet===wallet))return true;
    for(const loan of rows)if(loan.lender===wallet||loan.borrower===wallet)this.remember(market,loan);
    e.store.put('p2p-discovery',key,{wallet,cursor:String(cursor),complete});
    return complete;
  }
}
