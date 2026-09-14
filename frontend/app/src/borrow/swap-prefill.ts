import {formatUnits,parseUnits} from 'viem';
/** A navigation hint only. It never authorizes a deposit or chooses a debt amount. */
export function swapCollateralPrefill(query:URLSearchParams,account:string,balance:bigint):string|null {
 const raw=query.get('collateralAmount'),owner=query.get('swapAccount');
 if(!raw||owner?.toLowerCase()!==account.toLowerCase()||!/^(?:0|[1-9]\d{0,30})(?:\.\d{1,18})?$/.test(raw))return null;
 try{const requested=parseUnits(raw,18),available=requested<balance?requested:balance;return available>0n?formatUnits(available,18):null;}catch{return null;}
}
