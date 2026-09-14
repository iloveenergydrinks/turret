import {encodeAbiParameters,decodeAbiParameters} from './deps.mjs';
import {makeProof,healthTypes,proofParameters} from './policy.mjs';

export const marketHealthTypes={MarketHealth:healthTypes.Health};
export const stockProofParameters=[...proofParameters,{type:'bytes'}];

// Keep the guard's independently scoped price signature, and add authorization
// for this engine's borrowing/capital operations. Neither signature alone is a
// stock-pool admission proof. The pool is immutable after the engine binds it.
export async function makeStockProof(account,engine,adapter,result,state,now){
 const priceProof=await makeProof(account,adapter,result,state,now);
 const [message,priceSignature]=decodeAbiParameters(proofParameters,priceProof.encoded);
 const marketSignature=await account.signTypedData({domain:{name:'DockyardStockCredit',version:'1',chainId:4663,verifyingContract:engine},
  types:marketHealthTypes,primaryType:'MarketHealth',message});
 return {encoded:encodeAbiParameters(stockProofParameters,[message,priceSignature,marketSignature]),validUntil:priceProof.validUntil};
}
