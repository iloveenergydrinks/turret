import {isAddress,parseAbi,verifyTypedData,type Address,type Hex,type PublicClient} from 'viem';
export type CentralMarket={id:string;apiUrl:string;policyHash:Hex;weekend:boolean};
export const centralTypes={Approval:[{name:'borrower',type:'address'},{name:'action',type:'uint8'},
 {name:'collateralAmount',type:'uint256'},{name:'debtAmount',type:'uint256'},{name:'maxDebt',type:'uint256'},
 {name:'price',type:'uint256'},{name:'nonce',type:'uint256'},{name:'observedAt',type:'uint64'},
 {name:'deadline',type:'uint64'},{name:'epoch',type:'uint256'}]} as const;
export const centralAbi=parseAbi(['function riskSigner() view returns(address)','function signerEpoch() view returns(uint256)',
 'function owner() view returns(address)','function approvalNonces(address) view returns(uint256)',
 'function executeApproved((address borrower,uint8 action,uint256 collateralAmount,uint256 debtAmount,uint256 maxDebt,uint256 price,uint256 nonce,uint64 observedAt,uint64 deadline,uint256 epoch),bytes)']);
function need(ok:unknown):asserts ok {if(!ok)throw Error('Central loan approval is unavailable or no longer matches your request.');}
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
export function validateCentral(m:CentralMarket){
 need(m&&/^[A-Z0-9-]{1,16}$/.test(m.id)&&/^0x[0-9a-f]{64}$/i.test(m.policyHash)&&typeof m.weekend==='boolean');
 const u=new URL(m.apiUrl);need(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/');
 return m;
}
const url=(m:CentralMarket,suffix='')=>new URL('/v1/markets/'+m.id+suffix,m.apiUrl);
async function body(response:Response){const text=await response.text();need(response.ok&&text.length<=20000);return JSON.parse(text);}
export async function centralStatus(m:CentralMarket,fetcher=fetch,now=Date.now){
 const b=await body(await fetcher(url(m),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)}));
 const p=b.prices,t=Math.floor(now()/1000);
 need(b.market===m.id&&b.policyHash===m.policyHash&&typeof b.ready==='boolean'&&typeof b.code==='string'&&b.code.length<=64);
 const freshAt=(at:unknown):at is number=>typeof at==='number'&&Number.isSafeInteger(at)&&at>=0&&at<=t&&t-at<15;
 const c=b.closedSession;
 const sessionValid=m.weekend===false&&c?.closed===true&&c.source==='equities-24x5-calendar'
  &&Number.isSafeInteger(c.checkedAt)&&c.checkedAt>=0&&c.checkedAt<=t+2&&t-c.checkedAt<15
  &&Number.isSafeInteger(c.validUntil)&&c.validUntil>t&&c.validUntil<=c.checkedAt+60
  &&Number.isSafeInteger(c.reopensAt)&&c.reopensAt>=c.validUntil&&c.reopensAt<=t+8*86400;
 const closedSession=sessionValid?{checkedAt:BigInt(c.checkedAt),validUntil:BigInt(c.validUntil),reopensAt:BigInt(c.reopensAt)}:null;
 need(!closedSession||!b.ready);
 const positive=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,76}$/.test(value);
 const priceValid=!!p&&freshAt(p.at)&&positive(p.liquidationPrice);
 const borrowing=b.ready&&priceValid&&positive(p.borrowPrice)?BigInt(p.borrowPrice):null;
 const a=b.availability;
 const availabilityValid=!!a&&typeof a.paused==='boolean'&&['cash','principal','debtLimit','minimumDebt'].every(k=>typeof a[k]==='string'&&/^(0|[1-9][0-9]{0,76})$/.test(a[k]));
 // A rejected market can have no price/cash snapshot. Its fresh observation
 // still explains the rejection; it must never become permission to borrow.
 const checkedAt=closedSession?c.checkedAt:freshAt(b.qualification?.at)?b.qualification.at:priceValid?p.at:null;
 need(checkedAt!==null&&(!b.ready||(priceValid&&availabilityValid&&borrowing!==null)));
 const marketQuote=priceValid&&positive(p.marketPrice)
  &&Number.isSafeInteger(p.marketUpdatedAt)&&p.marketUpdatedAt<=t+2&&Number.isSafeInteger(p.marketValidUntil)&&p.marketValidUntil>t&&p.marketValidUntil-p.marketUpdatedAt<=30;
 const referenceAt=priceValid&&Number.isSafeInteger(p.referenceUpdatedAt)&&p.referenceUpdatedAt>=0&&p.referenceUpdatedAt<=t?p.referenceUpdatedAt:priceValid?p.at:null;
 const historicalReference=!!closedSession&&p?.closed===true&&positive(p.liquidationPrice)
  &&Number.isSafeInteger(p.at)&&p.at>=0&&p.at<=t&&Number.isSafeInteger(p.referenceUpdatedAt)&&p.referenceUpdatedAt>=0&&p.referenceUpdatedAt<=p.at;
 return {closedSession,displayReferencePrice:historicalReference?BigInt(p.liquidationPrice):null,displayReferenceAt:historicalReference?BigInt(p.referenceUpdatedAt):null,price:priceValid?BigInt(p.liquidationPrice):null,borrowingPrice:borrowing,
  validUntil:closedSession?.validUntil??BigInt((priceValid?Math.min(checkedAt,p.at):checkedAt)+15),checkedAt:BigInt(checkedAt),referenceUpdatedAt:referenceAt===null?null:BigInt(referenceAt),
  marketPrice:marketQuote?BigInt(p.marketPrice):null,marketUpdatedAt:marketQuote?BigInt(p.marketUpdatedAt):null,marketValidUntil:marketQuote?BigInt(p.marketValidUntil):null,marketSource:p?.marketSource==='dex'?'dex':'alpaca',
  ready:b.ready,code:b.code as string,availability:availabilityValid?{paused:a.paused as boolean,cash:BigInt(a.cash),principal:BigInt(a.principal),debtLimit:BigInt(a.debtLimit),minimumDebt:BigInt(a.minimumDebt)}:null};
}
export function centralRefreshInterval(summary:{validUntil:bigint}|undefined,now=Date.now()){
 // Refresh the cached HTTP summary before its evidence expires. This does not
 // trigger a chain read or extend the backend's authorization lifetime.
 const remaining=summary?Number(summary.validUntil*1000n)-now:0;
 return remaining>0?Math.max(250,Math.min(5000,remaining-3000)):5000;
}
export async function centralApproval(client:PublicClient,m:CentralMarket,engine:Address,borrower:Address,
 action:number,collateralAmount:bigint,debtAmount:bigint,minimumPrice:bigint,fetcher=fetch,now=Date.now){
 const b=await body(await fetcher(url(m,'/quote'),{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000),
  body:JSON.stringify({borrower,action,collateralAmount:String(collateralAmount),debtAmount:String(debtAmount)})}));
 need(b.primaryType==='Approval'&&b.policyHash===m.policyHash&&b.domain?.name==='TurretCreditEngine'&&b.domain?.version==='1'
  &&b.domain?.chainId===4663&&same(b.domain?.verifyingContract,engine));
 const a=b.message;need(a&&isAddress(a.borrower)&&same(a.borrower,borrower)&&a.action===action&&typeof b.signature==='string'&&/^0x[0-9a-f]{130}$/i.test(b.signature));
 const num=(k:string)=>{need(typeof a[k]==='string'&&/^(0|[1-9][0-9]{0,76})$/.test(a[k]));return BigInt(a[k]);};
 const message={borrower:a.borrower as Address,action:a.action as number,collateralAmount:num('collateralAmount'),debtAmount:num('debtAmount'),
  maxDebt:num('maxDebt'),price:num('price'),nonce:num('nonce'),observedAt:num('observedAt'),deadline:num('deadline'),epoch:num('epoch')};
 const t=BigInt(Math.floor(now()/1000));
 need(message.collateralAmount===collateralAmount&&message.debtAmount===debtAmount&&message.price>=minimumPrice
  &&message.observedAt<=t&&message.deadline>t+5n&&message.deadline-message.observedAt<=60n);
 const [signer,epoch,nonce]=await Promise.all([
  client.readContract({address:engine,abi:centralAbi,functionName:'riskSigner'}),
  client.readContract({address:engine,abi:centralAbi,functionName:'signerEpoch'}),
  client.readContract({address:engine,abi:centralAbi,functionName:'approvalNonces',args:[borrower]})]);
 need(epoch===message.epoch&&nonce===message.nonce&&await verifyTypedData({address:signer,domain:b.domain,types:centralTypes,primaryType:'Approval',message,signature:b.signature}));
 return {message,signature:b.signature as Hex};
}
