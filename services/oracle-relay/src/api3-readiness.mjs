import {parseAbi,keccak256} from './deps.mjs';
import {API3_SERVER,API3_SERVER_HASH,API3_USDG_SOURCES,api3UsdgAbi,
  verifyApi3UsdgAdapter,summarizeApi3Usdg} from './api3-usdg.mjs';
const demand=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const roundAbi=parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
function quoteAt(rows,clock){
  try{return {available:true,...summarizeApi3Usdg(rows,clock)};}
  catch{return {available:false};}
}

/** Uses confirmed native beacon state, never the pending publication or API.
 * Missing/expired prices return unavailable; identity or RPC failures throw. */
export async function readApi3UsdgReadiness({client,publication,confirmations,now=Date.now}){
  demand(typeof confirmations==='bigint'&&confirmations>=2n&&confirmations<=100n,'InvalidApi3ConfirmationDepth');
  demand(await client.getChainId()===4663,'WrongApi3ReadinessChain');
  const head=await client.getBlock(),wall=()=>BigInt(Math.floor(now()/1000));
  const fresh=()=>demand(head.hash&&typeof head.number==='bigint'&&head.timestamp<=wall()+15n
    &&wall()-head.timestamp<30n,'StaleApi3ReadinessHead');
  fresh();demand(head.number>=confirmations,'InsufficientApi3ChainHistory');
  const block=await client.getBlock({blockNumber:head.number-confirmations});
  demand(block.number===head.number-confirmations&&block.timestamp<=head.timestamp&&block.hash,'InvalidApi3ConfirmedBlock');
  async function snapshot(atBlock){
    const at={blockNumber:atBlock.number};
    const code=await client.getCode({address:API3_SERVER,...at});
    demand(code&&same(keccak256(code),API3_SERVER_HASH),'Api3ReadinessServerChanged');
    await verifyApi3UsdgAdapter(client,publication,atBlock.number);
    const rows=await Promise.all(API3_USDG_SOURCES.map(async p=>{
      const [price18,timestamp]=await client.readContract({address:API3_SERVER,abi:api3UsdgAbi,functionName:'dataFeeds',args:[p.beaconId],...at});
      return {beaconId:p.beaconId,price18,timestamp:BigInt(timestamp)};
    }));
    const historical=quoteAt(rows,atBlock.timestamp);
    let adapterMatches=false;
    if(historical.available){
      const round=await client.readContract({address:publication.adapter,abi:roundAbi,functionName:'latestRoundData',...at});
      const time=historical.oldestTimestamp;
      adapterMatches=Array.isArray(round)&&round.length===5&&round.every((v,i)=>v===[time,historical.medianPrice18,time,time,time][i]);
      demand(adapterMatches,'Api3ReadinessAdapterMismatch');
    }
    return {rows,historical,adapterMatches};
  }
  // A recently broken feed/runtime must not be masked by an older valid cache.
  // Latest state may invalidate readiness, but cannot replace confirmed prices.
  const [confirmed,latest]=await Promise.all([snapshot(block),snapshot(head)]);
  const [canonical,canonicalHead]=await Promise.all([client.getBlock({blockNumber:block.number}),client.getBlock({blockNumber:head.number})]);
  demand(same(canonical.hash,block.hash)&&same(canonicalHead.hash,head.hash),'Api3ReadinessReorg');
  fresh();
  const quote=quoteAt(confirmed.rows,wall()),latestQuote=quoteAt(latest.rows,wall());
  const latestAvailable=latest.historical.available&&latestQuote.available&&latest.adapterMatches;
  const available=confirmed.historical.available&&quote.available&&confirmed.adapterMatches&&latestAvailable;
  const expires=available?(quote.oldestTimestamp<latestQuote.oldestTimestamp?quote.oldestTimestamp:latestQuote.oldestTimestamp)+60n:wall();
  const deadline=expires<head.timestamp+30n?expires:head.timestamp+30n;
  const checkedAt=now();
  // An accepted small chain-clock lead cannot extend the wall-clock freshness
  // window consumed by an independently running watchdog.
  return {available,block:block.number,blockHash:block.hash,checkedAt,validUntil:Math.min(Number(deadline)*1000,checkedAt+30000),
    quote,latestAvailable,issues:available?[]:[latestAvailable?'confirmed-api3-prices-unavailable':'latest-api3-prices-unavailable'],productionApproved:false};
}
