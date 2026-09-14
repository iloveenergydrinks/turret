import {encodeFunctionData,keccak256,parseAbi} from './deps.mjs';
import {probePair,validatePolicy} from './isolated-pyth-preflight.mjs';
import {parseEnvelope,requestPrices,PYTH_VERIFIER} from './pyth.mjs';

export const isolatedHubAbi=parseAbi([
  'function verifier() view returns(address)',
  'function update(bytes) payable',
  'function report(uint32) view returns((uint64 timestampUs,uint64 feedUpdateTimestampUs,int64 price,uint64 confidence,uint16 publishers,int16 exponent,uint16 session))',
  'event ReportUpdated(uint32 indexed feedId,uint64 timestampUs,uint64 feedUpdateTimestampUs,uint16 session)',
]);
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const validAddress=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/i.test(a)&&!/^0x0{40}$/i.test(a);
const validHash=a=>typeof a==='string'&&/^0x[0-9a-f]{64}$/i.test(a)&&!/^0x0{64}$/i.test(a);

/** Prepares a signed-feed cache update without signing or broadcasting a transaction.
 * Does not approve an oracle or infer adapter readiness after hypothetical publication. */
export async function verifyIsolatedTargets(client,{policy,hub,hubCodeHash,adapter,adapterCodeHash,
  verifierCodeHash,collateralCodeHash,usdgCodeHash},at) {
  validatePolicy(policy);
  requireValue([hub,adapter].every(validAddress)&&!same(hub,adapter),'Invalid publication targets');
  requireValue([hubCodeHash,adapterCodeHash,verifierCodeHash,collateralCodeHash,usdgCodeHash].every(validHash),'Explicit publication runtime pins required');
  requireValue(typeof at?.blockNumber==='bigint','Pinned publication block required');
  for(const [address,expected] of [[hub,hubCodeHash],[adapter,adapterCodeHash],[PYTH_VERIFIER,verifierCodeHash],
    [policy.collateral,collateralCodeHash],[policy.usdg,usdgCodeHash]]){
    const code=await client.getCode({address,...at});
    requireValue(code&&code!=='0x'&&same(keccak256(code),expected),'Publication runtime mismatch');
  }
  const read=(address,name,type='address')=>client.readContract({address,
    abi:parseAbi([`function ${name}() view returns(${type})`]),functionName:name,...at});
  for(const [address,name,expected] of [[hub,'verifier',PYTH_VERIFIER],[adapter,'hub',hub],
    [adapter,'verifier',PYTH_VERIFIER],[adapter,'collateral',policy.collateral],[adapter,'usdg',policy.usdg]]){
    requireValue(same(await read(address,name),expected),'Publication binding mismatch');
  }
  requireValue(same(await read(adapter,'hubCodeHash','bytes32'),hubCodeHash)
    &&same(await read(adapter,'verifierCodeHash','bytes32'),verifierCodeHash),'Adapter pinned runtime mismatch');
  for(const name of ['collateralFeedId','usdgFeedId','maxPriceAge','maxPairSkew','maxConfidenceBps','collateralMinPublishers','usdgMinPublishers']){
    requireValue(BigInt(await read(adapter,name,'uint256'))===BigInt(policy[name]),'Publication policy mismatch');
  }
}

export async function prepareIsolatedPublication({client,key,caller,policy,hub,hubCodeHash,adapter,adapterCodeHash,
  verifierCodeHash,collateralCodeHash,usdgCodeHash,getPrices=requestPrices,getSymbols,now=()=>Date.now()}) {
  // Preflight and target verification overlap on three runtimes. Reuse only
  // explicit-block code reads within this preparation on this exact client.
  // Canonical-block checks and every subsequent preparation/signing stay fresh.
  const runtimes=new Map();
  const snapshotClient={...client,getCode(args){
    if(typeof args.blockNumber!=='bigint'||Object.keys(args).some(k=>!['address','blockNumber'].includes(k)))return client.getCode(args);
    const key=`${args.address.toLowerCase()}:${args.blockNumber}`;
    if(!runtimes.has(key)){
      const pending=Promise.resolve().then(()=>client.getCode(args));
      runtimes.set(key,pending);
      pending.catch(()=>runtimes.delete(key));
    }
    return runtimes.get(key);
  }};
  let signed;
  const probe=await probePair({client:snapshotClient,key,caller,policy,verifierCodeHash,getSymbols,now,
    getPrices:async(...args)=>{const result=await getPrices(...args);signed=result.signed;return {signed};}});
  const at={blockNumber:probe.block};
  await verifyIsolatedTargets(snapshotClient,{policy,hub,hubCodeHash,adapter,adapterCodeHash,verifierCodeHash,collateralCodeHash,usdgCodeHash},at);
  const report=parseEnvelope(signed);
  const cached=await Promise.all(report.feeds.map(feed=>client.readContract({address:hub,abi:isolatedHubAbi,functionName:'report',args:[feed.id],...at})));
  requireValue(cached.every(r=>typeof r?.timestampUs==='bigint'&&r.timestampUs>=0n),'Invalid cached report');
  const changedFeeds=report.feeds.filter((feed,i)=>feed.timestampUs>cached[i].timestampUs);
  // Fresh signed non-regular, uncertain or old-source reports intentionally remain
  // publishable. The adapter must see the invalidation instead of old good data.
  if(changedFeeds.length)await client.simulateContract({address:hub,abi:isolatedHubAbi,functionName:'update',args:[signed],value:probe.verificationFee,account:caller,...at});
  const canonical=await client.getBlock(at),wall=BigInt(Math.floor(now()/1000));
  requireValue(canonical.hash===probe.blockHash&&wall>=probe.blockTimestamp&&wall-probe.blockTimestamp<30n,'Publication snapshot changed or expired');
  requireValue(report.timestampUs<=wall*1000000n&&wall*1000000n-report.timestampUs<30000000n,'Publication report expired');
  return {chainId:4663,hub,adapter,block:probe.block,blockHash:probe.blockHash,blockTimestamp:probe.blockTimestamp,
    shouldSubmit:changedFeeds.length>0,reason:changedFeeds.length?'new-authenticated-report':'cache-already-current',
    to:hub,data:encodeFunctionData({abi:isolatedHubAbi,functionName:'update',args:[signed]}),value:probe.verificationFee,
    reportTimestampUs:report.timestampUs,changedFeeds:changedFeeds.map(f=>({id:f.id,timestampUs:f.timestampUs,sourceUs:f.sourceUs,session:f.session})),
    incomingQuote:probe.currentQuote,signatureVerified:true,productionApproved:false,
    scope:'Read-only publication preparation. Revalidate immediately before signing; readiness requires confirmed cache and adapter reads. No live provider entitlement or source-independence approval.'};
}
