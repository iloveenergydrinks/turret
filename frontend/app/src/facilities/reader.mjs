import { keccak256, parseAbi } from "viem";
import { inspectTokenBaseline, validateTokenBaseline } from "../p2p/health-core.mjs";
import { FRESH_MS, isAccount, parseSignedQuote, quoteDigest, quoteValues, same, uint, validObservation, ZERO_HASH } from "./quotes.mjs";
import { verifyFacilitySignature } from "./signatures.mjs";

export const limitFields=["maxExposure","minDraw","maxDraw","minDuration","maxDuration","maxQuoteLifetime","minCollateralPerPrincipalWad","minInterestBps"];
export const facilityReadAbi=parseAbi([
  ...["lender","loanToken","collateralToken","feeRecipient","vaultImplementation","quoteSigner","manager"].map(n=>`function ${n}() view returns (address)`),
  ...["feeBps","epoch","idleCash","activePrincipal","unresolvedDefaultPrincipal"].map(n=>`function ${n}() view returns (uint256)`),
  "function newLoansPaused() view returns (bool)",
  `function limits() view returns (${limitFields.map(n=>`uint256 ${n}`).join(",")})`,
  "function quoteUses(uint256 epoch,uint256 nonce) view returns (bytes32 digest,uint256 filled,bool cancelled)",
  "function balanceOf(address account) view returns (uint256)",
  "function isFrozen(address account) view returns (bool)","function isBlocked(address account) view returns (bool)",
]);
const isHash=value=>typeof value==="string"&&/^0x[0-9a-f]{64}$/i.test(value);

/** Entries are operator-reviewed deployment identities, never learned from submitted quotes. */
export function validateFacilityEntry(entry,baseline) {
  if(!entry||!Number.isSafeInteger(entry.chainId)||entry.chainId<=0
    || ["address","lender","loanToken","collateralToken","feeRecipient","vaultImplementation"].some(k=>!isAccount(entry[k]))
    || ["runtimeHash","vaultImplementationHash"].some(k=>!isHash(entry[k]))
    || same(entry.loanToken,entry.collateralToken)||same(entry.address,entry.lender)||same(entry.address,entry.feeRecipient)
    || uint(entry.feeBps)>10_000n)throw new Error("Invalid admitted facility identity.");
  validateTokenBaseline(baseline,entry.chainId);
  const tokens=[entry.loanToken,entry.collateralToken].map(address=>baseline.tokens.find(t=>same(t.address,address)));
  if(tokens.some(t=>!t))throw new Error("Facility tokens have not been qualified.");
  return tokens;
}

/** All reads share one block, checked again for reorgs after the final signature check.
 * Throws on incomplete RPC/token/identity verification. Callers must show unavailable, not empty.
 */
export async function readFacilityQuotes(client,entry,baseline,values,{clock=Date.now,block}={}) {
  const tokens=validateFacilityEntry(entry,baseline);
  if(!Array.isArray(values)||values.length>100)throw new Error("Read at most 100 quotes per facility.");
  const envelopes=values.map(parseSignedQuote);
  if(envelopes.some(e=>e.chainId!==entry.chainId||!same(e.facility,entry.address)))throw new Error("Quote facility mismatch.");
  if(await client.getChainId()!==entry.chainId)throw new Error("RPC chain mismatch.");
  block??=await client.getBlock();
  const fresh=()=>Number.isSafeInteger(clock())&&typeof block.number==="bigint"&&isHash(block.hash)
    &&typeof block.timestamp==="bigint"&&Math.abs(clock()-Number(block.timestamp)*1000)<FRESH_MS;
  if(!fresh())throw new Error("Facility block is stale.");
  const read=(address,functionName,args=[])=>client.readContract({address,abi:facilityReadAbi,functionName,args,blockNumber:block.number});
  const hash=async address=>{
    const code=await client.getCode({address,blockNumber:block.number});
    if(!code||code==="0x")throw new Error("Facility code unavailable.");
    return keccak256(code);
  };
  const names=["lender","loanToken","collateralToken","feeRecipient","vaultImplementation","feeBps","quoteSigner","epoch","idleCash","activePrincipal","unresolvedDefaultPrincipal","newLoansPaused","limits"];
  const results=await Promise.all(names.map(n=>read(entry.address,n)));
  const state=Object.fromEntries(names.map((n,i)=>[n,results[i]]));
  for(const name of names.slice(0,5))if(!same(state[name],entry[name]))throw new Error("Facility immutable binding changed.");
  if(state.feeBps!==uint(entry.feeBps))throw new Error("Facility fee configuration changed.");
  const [runtime,vaultRuntime,manager,vaultCash,vaultCollateral,cashBalance]=await Promise.all([
    hash(entry.address),hash(entry.vaultImplementation),read(entry.vaultImplementation,"manager"),
    read(entry.vaultImplementation,"loanToken"),read(entry.vaultImplementation,"collateralToken"),read(entry.loanToken,"balanceOf",[entry.address]),
  ]);
  if(!same(runtime,entry.runtimeHash)||!same(vaultRuntime,entry.vaultImplementationHash)||!same(manager,entry.address)
    ||!same(vaultCash,entry.loanToken)||!same(vaultCollateral,entry.collateralToken))throw new Error("Facility or vault identity changed.");
  for(const token of tokens) {
    const reason=await inspectTokenBaseline(client,token,block);
    if(reason)throw new Error(reason);
    for(const check of token.checks.filter(n=>["isFrozen","isBlocked"].includes(n))) {
      const restricted=await read(token.address,check,[entry.address]);
      if(restricted!==false)throw new Error("Facility token transfers cannot be verified as unrestricted.");
    }
  }
  if(!Array.isArray(state.limits)||state.limits.length!==limitFields.length)throw new Error("Invalid facility policy.");
  const shared={facility:entry.address,chainId:entry.chainId,lender:state.lender,healthy:true,paused:state.newLoansPaused,
    epoch:state.epoch,idleCash:state.idleCash,cashBalance,activePrincipal:state.activePrincipal,
    unresolvedDefaultPrincipal:state.unresolvedDefaultPrincipal,feeBps:state.feeBps,
    limits:Object.fromEntries(limitFields.map((name,i)=>[name,state.limits[i]])),block:{number:block.number,hash:block.hash,timestamp:block.timestamp}};
  if(!validObservation({...shared,signatureValid:false,use:{digest:ZERO_HASH,filled:0n,cancelled:false},checkedAt:clock()},clock()))throw new Error("Invalid facility observation.");
  const rows=[];
  // Bound concurrent signature calls: arbitrary ERC-1271 implementations may be expensive.
  for(const envelope of envelopes) {
    const q=quoteValues(envelope.quote);
    const [use,signatureValid]=await Promise.all([
      read(entry.address,"quoteUses",[q.epoch,q.nonce]),verifyFacilitySignature(client,envelope,block),
    ]);
    if(!Array.isArray(use)||use.length!==3)throw new Error("Invalid quote fill state.");
    rows.push({id:quoteDigest(envelope),envelope,observation:{...shared,signatureValid,use:{digest:use[0],filled:use[1],cancelled:use[2]}}});
  }
  if(!same((await client.getBlock({blockNumber:block.number})).hash,block.hash)||!fresh())throw new Error("Facility block changed or became stale during verification.");
  const checkedAt=clock();
  for(const row of rows) {
    row.observation.checkedAt=checkedAt;
    if(!validObservation(row.observation,checkedAt))throw new Error("Invalid facility observation.");
  }
  return {block:shared.block,checkedAt,rows};
}
