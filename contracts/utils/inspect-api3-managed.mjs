import {pathToFileURL} from 'node:url';
import {createPublicClient,http,parseAbi,keccak256,stringToHex} from 'viem';
import {API3_SERVER,API3_SERVER_HASH} from '../../services/oracle-relay/src/api3-usdg.mjs';

export const MANAGED_API3_USDG=Object.freeze({
  chainId:4663,
  reader:'0xCCd6CF334E7eA7DeE4c0c61bffd7410C1F82CEa1',
  readerCodeHash:'0x6a262fa9116d19f33c6b843c58c22f687293b75052171cfe58d05ba51365c3b1',
  server:API3_SERVER,serverCodeHash:API3_SERVER_HASH,
  dapiName:stringToHex('USDG/USD',{size:32}),
  dataFeedId:'0xed54a2b4d40250d3e97868e49dc809c64f22b68e1370b03227628b23304aafb7',
  activationTransaction:'0x04c64ae0ee104a402d644bc41c3c15c13d002beff102483b6d28c9f8a82ea1e6',
  catalogUrl:'https://market.api3.org/robinhood/usdg-usd/integrate',
  purchasedHeartbeatSeconds:86400,dockyardMaxAgeSeconds:3600,
});
export const managedApi3Abi=parseAbi([
  'function read() view returns(int224,uint32)',
  'function api3ServerV1() view returns(address)',
  'function dapiName() view returns(bytes32)',
  'function dappId() view returns(uint256)',
  'function dapiNameHashToDataFeedId(bytes32) view returns(bytes32)',
  'function dataFeeds(bytes32) view returns(int224,uint32)',
]);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(ok,code)=>{if(!ok)throw Error(code);};

export function managedApi3Observation(value,timestamp,now,maxAgeSeconds=3600){
  demand(Number.isSafeInteger(maxAgeSeconds)&&maxAgeSeconds>0&&maxAgeSeconds<=90000,'InvalidManagedApi3AgePolicy');
  const price18=BigInt(value),updatedAt=BigInt(timestamp),clock=BigInt(now);
  const ageSeconds=clock-updatedAt;
  const valid=price18>0n&&price18<=(1n<<128n)-1n&&updatedAt>0n;
  return {price18,updatedAt,ageSeconds,valid,
    fresh:valid&&ageSeconds>=0n&&ageSeconds<BigInt(maxAgeSeconds)};
}

/** No keys, signing, writes, subscription purchase or activation. Pins the
 * base feed independently of upgradeable reader logic and compares its read.
 * This inspects identity/current freshness, not continuous service or rights. */
export async function inspectManagedApi3Usdg({client,now=Date.now,maxAgeSeconds=3600}){
  const cfg=MANAGED_API3_USDG;
  demand(await client.getChainId()===cfg.chainId,'WrongManagedApi3Chain');
  const head=await client.getBlock();
  const checkClock=()=>{
    const wall=BigInt(Math.floor(now()/1000));
    demand(typeof head.number==='bigint'&&/^0x[\da-f]{64}$/i.test(head.hash??'')
      &&head.timestamp<=wall+15n&&wall-head.timestamp<=60n,'ManagedApi3RpcHeadNotFresh');
  };
  checkClock();
  const read=(address,functionName,args=[])=>client.readContract({address,abi:managedApi3Abi,functionName,args,blockNumber:head.number});
  for(const [address,pin] of [[cfg.server,cfg.serverCodeHash],[cfg.reader,cfg.readerCodeHash]]){
    const code=await client.getCode({address,blockNumber:head.number});
    demand(code&&code!=='0x'&&same(keccak256(code),pin),'ManagedApi3RuntimeChanged');
  }
  demand(same(await read(cfg.reader,'api3ServerV1'),cfg.server)
    &&same(await read(cfg.reader,'dapiName'),cfg.dapiName)
    &&BigInt(await read(cfg.reader,'dappId'))===1n,'ManagedApi3ReaderBindingMismatch');
  demand(same(await read(cfg.server,'dapiNameHashToDataFeedId',[keccak256(cfg.dapiName)]),cfg.dataFeedId),
    'ManagedApi3DapiRemapped');
  const base=await read(cfg.server,'dataFeeds',[cfg.dataFeedId]);
  const reader=await read(cfg.reader,'read');
  demand(BigInt(base[0])===BigInt(reader[0])&&BigInt(base[1])===BigInt(reader[1]),'ManagedApi3ReaderDiffersFromBase');
  const observation=managedApi3Observation(...base,head.timestamp,maxAgeSeconds);
  const receipt=await client.getTransactionReceipt({hash:cfg.activationTransaction});
  demand(receipt.status==='success'&&receipt.blockNumber<=head.number,'ManagedApi3PurchaseNotConfirmed');
  demand(same((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash),'ManagedApi3ReceiptReorg');
  demand(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'ManagedApi3SnapshotChanged');
  checkClock();
  return {...cfg,blockNumber:head.number,blockHash:head.hash,blockTimestamp:head.timestamp,
    activationBlock:receipt.blockNumber,purchaseConfirmed:true,...observation,
    dockyardMaxAgeSeconds:maxAgeSeconds,
    configuredSourceMatches:true,heartbeatMeetsDockyardPolicy:maxAgeSeconds>cfg.purchasedHeartbeatSeconds,
    oracleSources:1,oevRewards:false,broadcast:false,productionApproved:false,
    limitations:'Managed API3 base aggregation only. Current timestamp is the median provider system timestamp, not oldest input or exchange-observation time. Reader comparison is a snapshot, not reader implementation provenance. Purchase receipt does not prove ongoing renewal or update SLA. Requires heartbeat-policy resolution, independent second source, usage-rights review and production commissioning.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    demand(process.argv.length===2&&process.env.API3_RPC_URL,'ExplicitManagedApi3RpcRequired');
    const client=createPublicClient({transport:http(process.env.API3_RPC_URL,{timeout:15000,retryCount:0}),cacheTime:0});
    const report=await inspectManagedApi3Usdg({client});
    console.log(JSON.stringify(report,(_,v)=>typeof v==='bigint'?String(v):v,2));
    if(!report.fresh)process.exitCode=2;
  })().catch(()=>{console.error('Managed API3 inspection failed. No transaction sent; endpoint details omitted.');process.exitCode=1;});
}
