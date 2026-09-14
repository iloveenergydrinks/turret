import {pathToFileURL} from 'node:url';
import {ContractFunctionRevertedError,ContractFunctionZeroDataError,createPublicClient,getAddress,http,keccak256,parseAbi} from 'viem';

const abi=parseAbi(['function aggregator() view returns(address)','function decimals() view returns(uint8)',
  'function description() view returns(string)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const check=(ok,message)=>{if(!ok)throw Error(message);};
const address=value=>{const a=getAddress(value);check(!/^0x0{40}$/i.test(a),'Zero oracle address');return a;};
const equal=(a,b)=>a.toLowerCase()===b.toLowerCase();
// Only an EVM revert/empty return can mean an optional getter is unavailable.
// Transport errors, malformed nonempty ABI and timeouts must not become evidence.
function unavailable(error){
  const seen=new Set();
  while(error&&!seen.has(error)){
    if(error instanceof ContractFunctionRevertedError||error instanceof ContractFunctionZeroDataError)return true;
    seen.add(error);error=error.cause;
  }
  return false;
}

/** Negative identity check, NOT proof of source independence. Follows exposed
 * Chainlink-style aggregator links, including nested proxies. Other wrapper
 * types, data-provider overlap and upgrades need separate qualification. */
export async function inspectUsdgSourceIdentity({client,primary,secondary,blockNumber}){
  check(typeof blockNumber==='bigint'&&blockNumber>=0n,'Pinned block required');
  async function trace(input){
    const nodes=[];let current=address(input);
    for(let depth=0;depth<8;depth++){
      check(!nodes.some(n=>equal(n.address,current)),'Oracle aggregator cycle');
      const code=await client.getCode({address:current,blockNumber});
      check(code&&code!=='0x','Oracle dependency has no code');
      nodes.push({address:current,codeHash:keccak256(code)});
      let next;
      try{next=await client.readContract({address:current,abi,functionName:'aggregator',blockNumber});}
      catch(error){if(!unavailable(error))throw error;return {nodes,terminal:'getter-unavailable'};}
      // A zero return is not an independent source identity or a normal terminus.
      current=address(next);
    }
    throw Error('Oracle aggregator trace exceeds bound');
  }
  const feeds=await Promise.all([trace(primary),trace(secondary)]);
  const sharedDependencies=feeds[0].nodes.filter(a=>feeds[1].nodes.some(b=>equal(a.address,b.address))).map(a=>a.address);
  return {feeds,sharedDependencies,knownAlias:sharedDependencies.length>0,independenceVerified:false};
}

export function evaluateUsdgRounds({rounds,decimals,timestamp,maxAge,primaryMaxAge,secondaryMaxAge,maxDeviationBps,maxTimestampSkew}){
  check(typeof timestamp==='bigint'&&timestamp>0n,'Invalid chain timestamp');
  // Legacy CLI remains strict. Heartbeat-aware callers must explicitly supply
  // both source budgets; never silently turn a one-hour policy into 25 hours.
  if(maxAge!==undefined){
    check(typeof maxAge==='bigint'&&maxAge>0n&&maxAge<=3600n
      &&primaryMaxAge===undefined&&secondaryMaxAge===undefined,'Invalid legacy pricing bounds');
    primaryMaxAge=secondaryMaxAge=maxAge;
  }
  for(const n of [primaryMaxAge,secondaryMaxAge,maxDeviationBps,maxTimestampSkew])check(typeof n==='bigint','Integer pricing bounds required');
  const ages=[primaryMaxAge,secondaryMaxAge],largest=primaryMaxAge>secondaryMaxAge?primaryMaxAge:secondaryMaxAge;
  check(ages.every(n=>n>0n&&n<=90000n)&&maxDeviationBps>0n&&maxDeviationBps<=200n
    &&maxTimestampSkew>0n&&maxTimestampSkew<=largest,'Invalid engine pricing bounds');
  check(rounds.length===2&&decimals.length===2,'Two USDG rounds required');
  const issues=[];
  const observations=rounds.map((r,i)=>{
    check(Array.isArray(r)&&r.length===5&&r.every(v=>typeof v==='bigint'),'Invalid round tuple');
    check(Number.isInteger(decimals[i])&&decimals[i]>=0&&decimals[i]<=18,'Unsupported feed decimals');
    const [round,answer,,updatedAt,answeredInRound]=r;
    const valid=round>0n&&answer>0n&&answer<=(1n<<128n)-1n&&answeredInRound>=round
      &&updatedAt>0n&&updatedAt<=timestamp;
    if(!valid)issues.push(`source-${i+1}-invalid-round`);
    const ageSeconds=timestamp-updatedAt;
    if(valid&&ageSeconds>=ages[i])issues.push(`source-${i+1}-stale`);
    return {round,answer,updatedAt,answeredInRound,decimals:decimals[i],ageSeconds,
      price18:valid?answer*10n**BigInt(18-decimals[i]):null};
  });
  if(observations.every(o=>o.price18!==null)){
    const [a,b]=observations,low=a.price18<b.price18?a.price18:b.price18,high=a.price18>b.price18?a.price18:b.price18;
    // Mirrors current Solidity integer-floor deviation comparison exactly.
    if((high-low)*10000n/low>maxDeviationBps)issues.push('source-price-deviation');
    const skew=a.updatedAt>b.updatedAt?a.updatedAt-b.updatedAt:b.updatedAt-a.updatedAt;
    if(skew>maxTimestampSkew)issues.push('source-timestamp-skew');
  }
  return {observations,issues,engineRoundChecksPassed:issues.length===0};
}

/** Read-only qualification evidence. No default $1 value and no activation. */
export async function inspectStockUsdg({client,primary,secondary,maxAge,maxDeviationBps,maxTimestampSkew,now=Date.now}){
  check(await client.getChainId()===4663,'Wrong RPC chain');
  const head=await client.getBlock();
  const fresh=()=>{const wall=BigInt(Math.floor(now()/1000));check(head.hash&&typeof head.number==='bigint'
    &&head.timestamp<=wall+15n&&wall-head.timestamp<=60n,'RPC head is not fresh');};
  fresh();
  const identity=await inspectUsdgSourceIdentity({client,primary,secondary,blockNumber:head.number});
  const read=(a,functionName)=>client.readContract({address:a,abi,functionName,blockNumber:head.number});
  const observations=await Promise.all([address(primary),address(secondary)].map(async a=>({
    round:await read(a,'latestRoundData'),decimals:Number(await read(a,'decimals')),description:await read(a,'description')})));
  const pricing=evaluateUsdgRounds({rounds:observations.map(o=>o.round),decimals:observations.map(o=>o.decimals),
    timestamp:head.timestamp,maxAge,maxDeviationBps,maxTimestampSkew});
  const canonical=await client.getBlock({blockNumber:head.number});
  check(equal(canonical.hash,head.hash),'Oracle inspection snapshot changed');fresh();
  return {chainId:4663,blockNumber:head.number,blockHash:head.hash,blockTimestamp:head.timestamp,
    policy:{maxAge,maxDeviationBps,maxTimestampSkew},identity,descriptions:observations.map(o=>o.description),pricing,
    productionApproved:false,tokenBindingVerified:false,
    limitations:'One provider and one pinned block. Exposed aggregator links only; absence of a shared link does not establish independence. Feed description is not token identity. Does not verify access from deployed consumers, data-use rights, heartbeat availability, proxy upgrades or continuous operation.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    const [primary,secondary,age,deviation,skew,...extra]=process.argv.slice(2);
    check(primary&&secondary&&[age,deviation,skew].every(v=>/^[1-9][0-9]*$/.test(v??''))&&!extra.length
      &&process.env.COLLATERAL_RPC_URL,'Provide two feeds and explicit age, deviation and skew bounds');
    const client=createPublicClient({transport:http(process.env.COLLATERAL_RPC_URL,{timeout:20000,retryCount:0}),cacheTime:0});
    const result=await inspectStockUsdg({client,primary,secondary,maxAge:BigInt(age),maxDeviationBps:BigInt(deviation),maxTimestampSkew:BigInt(skew)});
    console.log(JSON.stringify(result,(_,v)=>typeof v==='bigint'?String(v):v,2));
    if(result.identity.knownAlias||!result.pricing.engineRoundChecksPassed)process.exitCode=2;
  })().catch(()=>{console.error('USDG source inspection failed. Check explicit inputs and RPC state. No transaction sent.');process.exitCode=1;});
}
