import { keccak256, toHex } from 'viem';
import type { Deployment } from './client';

export type P2PAlertScope = { protocol?: 'p2p' | 'nft'; chainId: number; scope: string; markets: object[] };
export function p2pAlertScope(markets: readonly Deployment[]): P2PAlertScope | null {
  if (!markets.length || markets.some(m=>m.chainId!==markets[0]!.chainId)) return null;
  const normalized=markets.map(row=>({address:row.address.toLowerCase(),version:row.version??1,chainId:row.chainId,
    loanToken:row.loanToken.toLowerCase(),collateralToken:row.collateralToken.toLowerCase(),runtimeHash:row.runtimeHash.toLowerCase(),
    startBlock:row.startBlock,loanDecimals:row.loanDecimals,collateralDecimals:row.collateralDecimals,
    collateralSymbol:row.collateralSymbol,loanSymbol:'USDG'})).sort((a,b)=>a.address.localeCompare(b.address));
  return {chainId:markets[0]!.chainId,scope:keccak256(toHex(JSON.stringify(normalized))),markets:normalized};
}
export type AlertCapabilities = {protocol:'p2p'|'nft';chainId:number;scope:string;markets:object[];email:boolean;telegram:boolean;monitorReady:boolean;monitorOperational:boolean};
export async function p2pAlertsRequest(base:string,path:string,session='',body?:object,method?:string):Promise<unknown> {
  const url=new URL(base,window.location.origin);
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('Invalid P2P alert service.');
  const response=await fetch(`${url.href.replace(/\/$/,'')}${path}`,{method:method??(body?'POST':'GET'),
    cache:'no-store',redirect:'error',credentials:'same-origin',signal:AbortSignal.timeout(15000),
    headers:{...(body?{'content-type':'application/json'}:{}),...(session?{authorization:`Bearer ${session}`}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw new Error('P2P alert service is unavailable or your session expired. Retry wallet verification.');
  return response.json();
}
export function checkP2PAlertCapabilities(value:unknown,scope:P2PAlertScope):AlertCapabilities {
  const row=value as AlertCapabilities;
  if(!row||row.protocol!==(scope.protocol??'p2p')||row.chainId!==scope.chainId||row.scope!==scope.scope
    ||JSON.stringify(row.markets)!==JSON.stringify(scope.markets)||typeof row.email!=='boolean'||typeof row.telegram!=='boolean'
    ||typeof row.monitorReady!=='boolean'||typeof row.monitorOperational!=='boolean')throw new Error('P2P alert service does not match these loan markets.');
  return row;
}
