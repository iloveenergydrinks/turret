import registry from '../../public/p2p-markets.json';
export const previewMarkets=registry.markets.filter(m=>!m.legacy).slice(0,3).map(m=>({...m,version:3}));
const lender='0x1111111111111111111111111111111111111111';
export function previewLoan(index=0){return {id:BigInt(index+1),lender,borrower:'0x0000000000000000000000000000000000000000',principal:BigInt(1000+index*500)*1000000n,collateral:10n*10n**18n,interest:BigInt(10+index*5)*1000000n,durationDays:14+index*7,expiresAt:Math.floor(Date.now()/1000)+86400,createdAt:Math.floor(Date.now()/1000)-100,dueAt:0,status:'open',isPublic:true,fundingAvailable:BigInt(1000+index*500)*1000000n};}
export async function loadP2PRegistry(){return {markets:previewMarkets,unavailableAssets:[]};}
export class P2PClient {
 constructor(public config:any){}
 async browse(){return {offers:[previewLoan(previewMarkets.findIndex(m=>m.address===this.config.address))],now:Math.floor(Date.now()/1000),blockNumber:1n,paused:false,nextCursor:null,health:{status:'ok',reasons:[]}};}
 async getLoan(id:bigint){return previewLoan(Number(id)-1);}
 disconnect(){}
}
