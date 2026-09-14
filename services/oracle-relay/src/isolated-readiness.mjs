import {parseAbi} from './deps.mjs';
import {evaluatePair} from './isolated-pyth-preflight.mjs';
import {isolatedHubAbi,verifyIsolatedTargets} from './isolated-publication.mjs';

const abi=parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const demand=(ok,message)=>{if(!ok)throw Error(message);};

/** Confirmed cache, not a provider quote or a pending publication. No signing. */
export async function readIsolatedReadiness({client,publication,confirmations,now=Date.now}) {
  demand(typeof confirmations==='bigint'&&confirmations>=2n,'At least two confirmations required');
  demand(await client.getChainId()===4663,'Wrong chain');
  const head=await client.getBlock();
  const wall=()=>BigInt(Math.floor(now()/1000));
  const fresh=()=>demand(head.timestamp<=wall()&&wall()-head.timestamp<30n,'Stale readiness head');
  fresh();
  demand(typeof head.number==='bigint'&&head.number>=confirmations,'Insufficient chain history');
  const block=await client.getBlock({blockNumber:head.number-confirmations});
  demand(block.number===head.number-confirmations&&block.timestamp<=head.timestamp&&block.hash,'Invalid confirmed block');
  const at={blockNumber:block.number};
  await verifyIsolatedTargets(client,publication,at);
  const feeds=await Promise.all([publication.policy.collateralFeedId,publication.policy.usdgFeedId].map(async id=>{
    const r=await client.readContract({address:publication.hub,abi:isolatedHubAbi,functionName:'report',args:[id],...at});
    return {id,timestampUs:r.timestampUs,sourceUs:r.feedUpdateTimestampUs,price:r.price,confidence:r.confidence,
      publishers:Number(r.publishers),exponent:Number(r.exponent),session:Number(r.session)};
  }));
  const historical=evaluatePair(feeds,block.timestamp,publication.policy);
  const current=evaluatePair(feeds,wall(),publication.policy);
  let adapterMatches=false;
  if(historical.available){
    const round=await client.readContract({address:publication.adapter,abi,functionName:'latestRoundData',...at});
    adapterMatches=Array.isArray(round)&&round.length===5&&round.every((v,i)=>
      v===[historical.roundId,historical.answer,historical.updatedAt,historical.updatedAt,historical.roundId][i]);
    demand(adapterMatches,'Adapter and cache disagree');
  }
  const [canonical,canonicalHead]=await Promise.all([client.getBlock(at),client.getBlock({blockNumber:head.number})]);
  demand(canonical.hash===block.hash&&canonicalHead.hash===head.hash,'Readiness reorg');
  fresh();
  const final=evaluatePair(feeds,wall(),publication.policy);
  // Health responses must expire this snapshot even when the next cycle stalls.
  const validUntil=Number(feeds.reduce((limit,f)=>{
    const reportExpiry=f.timestampUs/1000n+30000n;
    const sourceExpiry=f.sourceUs/1000n+BigInt(publication.policy.maxPriceAge)*1000n;
    return [reportExpiry,sourceExpiry].reduce((a,b)=>a<b?a:b,limit);
  },head.timestamp*1000n+30000n));
  return {available:historical.available&&current.available&&final.available&&adapterMatches,
    block:block.number,blockHash:block.hash,checkedAt:now(),validUntil,
    quote:final,issues:final.issues,productionApproved:false};
}
