// Read-only candidate qualification. Not wired into the production relay.
import {pathToFileURL} from 'node:url';
import {createPublicClient,http,parseAbi,encodeFunctionData,decodeFunctionResult,decodeAbiParameters,
  encodePacked,recoverMessageAddress,keccak256} from './deps.mjs';

export const API3_SERVER='0xEa5f320Ee0ef7E81AFAf2a9b4FBc1a7d093287fe';
export const API3_SERVER_HASH='0x27204d8c31a1fcbdf7747d795776d8a60c6d10bf2bf7c94739cd9190a5e16238';
export const API3_SOURCE_REVISION='ba4aa04f95eeba693d4b8b7d937377b6bfd6a47f';
// Public provider identities and USDG/USD template IDs from API3's pinned
// active configurations. Key rotation requires requalification, not auto-trust.
export const API3_USDG_SOURCES=Object.freeze([
  ['coingecko','0x9dB03a07bE313B3C08261B1d1606D511f3560D9e','0x9c17f116965a022bf0f94091c3cd169ff3f682186ea0fa6a735d6d1050286edc','20260728'],
  ['coinpaprika','0xE79B702c477127c18A0e1b47Fb008b725035c826','0x08036f9890ac0b67dfd1e6bb03d6058ed474ebe79a4597c0178a42fdf0f15e92','20260728'],
  ['blocksize','0xBA910Eb2867977A0a651FE3D2607237ff4116B1C','0x1c37c3dd526c999a2238125fd5561cd45faaeafc713ab98f5046e96e1667b9fb','20260728'],
  ['ncfx','0x68ec391b38A66A4B19543dc031f2659e2224a781','0x2c8c41cd326d810e049ad14d650b65f255c12b1a7905da59b0e5c16373865024','20260730'],
  ['nodary','0xc52EeA00154B4fF1EbbF8Ba39FDe37F1AC3B9Fd4','0xcd9b10bc78fef5da482bd8b68e7f220689046f419e2e56286c61074778ccd248','20260720'],
].map(([provider,airnode,templateId,date])=>Object.freeze({provider,airnode,templateId,
  configuration:`data/apis/${provider}/configurations/active-configurations/api3-${date}-airnode-feed.json`,
  beaconId:keccak256(encodePacked(['address','bytes32'],[airnode,templateId]))})));
export const api3UsdgAbi=parseAbi([
  'function dataFeeds(bytes32) view returns(int224 value,uint32 timestamp)',
  'function updateBeaconWithSignedData(address,bytes32,uint256,bytes,bytes) returns(bytes32)',
  'function multicall(bytes[]) returns(bytes[])',
]);
const demand=(ok,code)=>{if(!ok)throw Error(code);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const halfOrder=0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function summarizeApi3Usdg(rows,now){
  demand(Array.isArray(rows)&&rows.length===5,'Api3RequiresFiveProviders');
  demand(typeof now==='bigint'&&now>0n,'InvalidApi3Clock');
  for(const r of rows)demand(r.price18>0n&&r.price18<(1n<<223n)&&r.timestamp>0n&&r.timestamp<=now
    &&now-r.timestamp<60n,'Api3PriceOrTimestampInvalid');
  const times=rows.map(r=>r.timestamp).sort((a,b)=>a<b?-1:a>b?1:0);
  const prices=rows.map(r=>r.price18).sort((a,b)=>a<b?-1:a>b?1:0);
  demand(times[4]-times[0]<=10n,'Api3TimestampSkew');
  demand((prices[4]-prices[0])*10000n<=prices[0]*100n,'Api3PriceSpread');
  return {medianPrice18:prices[2],oldestTimestamp:times[0],newestTimestamp:times[4]};
}

// Verifies identity, encoding and signature without imposing a wall-clock age.
// Historical receipt reconciliation needs this even after a report expires.
export async function verifyApi3UsdgPackage(p){
  const source=API3_USDG_SOURCES.find(s=>same(p?.airnode,s.airnode)&&same(p?.templateId,s.templateId));
  demand(source,'Api3ProviderOrTemplateMismatch');
  demand(typeof p.timestamp==='string'&&/^[1-9][0-9]{0,9}$/.test(p.timestamp)
    &&/^0x[0-9a-f]{64}$/i.test(p.encodedValue??'')&&/^0x[0-9a-f]{128}(1b|1c)$/i.test(p.signature??''),'Api3MalformedPackage');
  demand(BigInt('0x'+p.signature.slice(66,130))<=halfOrder,'Api3NonCanonicalSignature');
  const timestamp=BigInt(p.timestamp);
  demand(timestamp<=0xffffffffn,'Api3TimestampOverflow');
  const hash=keccak256(encodePacked(['bytes32','uint256','bytes'],[source.templateId,timestamp,p.encodedValue]));
  const recovered=await recoverMessageAddress({message:{raw:hash},signature:p.signature});
  demand(same(recovered,source.airnode),'Api3SignatureMismatch');
  const [price18]=decodeAbiParameters([{type:'int256'}],p.encodedValue);
  demand(price18>0n&&price18<(1n<<223n),'Api3PriceOrTimestampInvalid');
  return {...source,timestamp,price18,encodedValue:p.encodedValue,signature:p.signature};
}

export async function validateApi3Usdg(packages,nowSeconds){
  demand(Array.isArray(packages)&&packages.length===5,'Api3RequiresFiveProviders');
  const rows=[];
  for(const source of API3_USDG_SOURCES){
    const matches=packages.filter(p=>same(p?.airnode,source.airnode));
    demand(matches.length===1&&same(matches[0].templateId,source.templateId),'Api3ProviderOrTemplateMismatch');
    rows.push(await verifyApi3UsdgPackage(matches[0]));
  }
  return {rows,...summarizeApi3Usdg(rows,nowSeconds)};
}

export async function fetchApi3Usdg(fetcher=fetch){
  return Promise.all(API3_USDG_SOURCES.map(async source=>{
    const r=await fetcher(`https://signed-api.api3.org/public/${source.airnode}`,{
      redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
    demand(r.ok,'Api3SignedApiUnavailable');
    const body=await r.json(),p=body?.data?.[source.beaconId];
    demand(p&&same(p.airnode,source.airnode)&&same(p.templateId,source.templateId),'Api3SignedFeedMissing');
    return p;
  }));
}

/** Publishes into eth_call's temporary state only, then reads it back. */
async function probeApi3Usdg({client,fetcher=fetch,now=Date.now,verifyTarget}){
  demand(await client.getChainId()===4663,'WrongApi3Chain');
  const packages=await fetchApi3Usdg(fetcher),head=await client.getBlock();
  const fresh=()=>{const wall=BigInt(Math.floor(now()/1000));demand(head.hash&&typeof head.number==='bigint'
    &&head.timestamp<=wall+15n&&wall-head.timestamp<=60n,'Api3RpcHeadNotFresh');};
  fresh();
  const code=await client.getCode({address:API3_SERVER,blockNumber:head.number});
  demand(code&&same(keccak256(code),API3_SERVER_HASH),'Api3ServerRuntimeChanged');
  if(verifyTarget)await verifyTarget(head);
  const validated=await validateApi3Usdg(packages,head.timestamp),calls=[],before=[];
  const common={address:API3_SERVER,abi:api3UsdgAbi,blockNumber:head.number};
  for(const p of validated.rows){
    const row=await client.readContract({...common,functionName:'dataFeeds',args:[p.beaconId]});
    before.push({price18:BigInt(row[0]),timestamp:BigInt(row[1])});
    if(p.timestamp>BigInt(row[1]))calls.push(encodeFunctionData({abi:api3UsdgAbi,functionName:'updateBeaconWithSignedData',
      args:[p.airnode,p.templateId,p.timestamp,p.encodedValue,p.signature]}));
  }
  const updateCount=calls.length;
  for(const p of validated.rows)calls.push(encodeFunctionData({abi:api3UsdgAbi,functionName:'dataFeeds',args:[p.beaconId]}));
  const simulation=await client.simulateContract({...common,functionName:'multicall',args:[calls]});
  demand(simulation.result.length===calls.length,'Api3SimulationResultMismatch');
  const effective=validated.rows.map((p,i)=>{
    const [price18,time]=decodeFunctionResult({abi:api3UsdgAbi,functionName:'dataFeeds',data:simulation.result[updateCount+i]});
    const expected=p.timestamp>before[i].timestamp?p:before[i];
    demand(price18===expected.price18&&BigInt(time)===expected.timestamp,'Api3PublishedValueMismatch');
    return {provider:p.provider,beaconId:p.beaconId,price18,timestamp:BigInt(time)};
  });
  const result=summarizeApi3Usdg(effective,head.timestamp);
  demand(same((await client.getBlock({blockNumber:head.number})).hash,head.hash),'Api3SnapshotChanged');fresh();
  const report={chainId:4663,blockNumber:head.number,blockHash:head.hash,blockTimestamp:head.timestamp,
    server:API3_SERVER,serverCodeHash:API3_SERVER_HASH,sourceRevision:API3_SOURCE_REVISION,updateCount,
    observations:effective,...result,signaturesVerified:5,publicationSimulationPassed:true,broadcast:false,
    productionApproved:false,tokenBindingVerified:false,
    limitations:'Fixed five-provider candidate, not an initialized dAPI or deployed Dockyard feed. Signed timestamps are provider processing times, not necessarily underlying exchange observations. Does not establish provider independence, continuous availability, usage rights, a funded relay, or public lending readiness.'};
  return {report,updates:calls.slice(0,updateCount)};
}

export async function preflightApi3Usdg(args){
  return (await probeApi3Usdg(args)).report;
}

/** Fixed adapter bindings and policy at an explicit block. Does not qualify
 * source provenance or assert that its underlying cache is currently fresh. */
export async function verifyApi3UsdgAdapter(client,{adapter,adapterCodeHash},blockNumber){
  demand(typeof adapter==='string'&&/^0x[0-9a-f]{40}$/i.test(adapter)&&!/^0x0{40}$/i.test(adapter)
    &&!same(adapter,API3_SERVER),'InvalidApi3Adapter');
  demand(typeof adapterCodeHash==='string'&&/^0x[0-9a-f]{64}$/i.test(adapterCodeHash)
    &&!/^0x0{64}$/i.test(adapterCodeHash),'InvalidApi3AdapterPin');
  demand(typeof blockNumber==='bigint','PinnedApi3AdapterBlockRequired');
  const at={blockNumber};
  const code=await client.getCode({address:adapter,...at});
  demand(code&&same(keccak256(code),adapterCodeHash),'Api3AdapterRuntimeChanged');
  const read=(name,type)=>client.readContract({address:adapter,...at,
    abi:parseAbi([`function ${name}() view returns(${type})`]),functionName:name});
  for(const name of ['server','aggregator'])demand(same(await read(name,'address'),API3_SERVER),'Api3AdapterBindingMismatch');
  demand(same(await read('serverCodeHash','bytes32'),API3_SERVER_HASH),'Api3AdapterBindingMismatch');
  for(const [name,type,value] of [['decimals','uint8',18n],['MAX_AGE','uint32',60n],
    ['MAX_TIMESTAMP_SKEW','uint32',10n],['MAX_SPREAD_BPS','uint16',100n]]){
    demand(BigInt(await read(name,type))===value,'Api3AdapterPolicyMismatch');
  }
  for(const [i,source] of API3_USDG_SOURCES.entries()){
    const id=await client.readContract({address:adapter,...at,abi:parseAbi(['function beaconId(uint256) view returns(bytes32)']),
      functionName:'beaconId',args:[BigInt(i)]});
    demand(same(id,source.beaconId),'Api3AdapterBeaconMismatch');
  }
}

/** Bounded transaction intent for a pinned Dockyard adapter. No signing or
 * broadcasting. Revalidate before signing/replacement and verify confirmed
 * cache state: a competing publisher can make this intent obsolete. */
export async function prepareApi3UsdgPublication({client,adapter,adapterCodeHash,fetcher=fetch,now=Date.now}){
  const verifyTarget=head=>verifyApi3UsdgAdapter(client,{adapter,adapterCodeHash},head.number);
  const {report,updates}=await probeApi3Usdg({client,fetcher,now,verifyTarget});
  const wall=BigInt(Math.floor(now()/1000));
  demand(report.newestTimestamp<=wall&&wall-report.oldestTimestamp<60n,'Api3PublicationExpired');
  return {...report,adapter,adapterCodeHash,shouldSubmit:updates.length>0,
    reason:updates.length?'new-authenticated-beacons':'cache-already-current',
    to:API3_SERVER,value:0n,expiresAt:report.oldestTimestamp+60n,
    data:updates.length?encodeFunctionData({abi:api3UsdgAbi,functionName:'multicall',args:[updates]}):null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  (async()=>{
    demand(process.argv.length===2&&process.env.API3_RPC_URL,'ExplicitApi3RpcRequired');
    const client=createPublicClient({transport:http(process.env.API3_RPC_URL,{timeout:15000,retryCount:0}),cacheTime:0});
    console.log(JSON.stringify(await preflightApi3Usdg({client}),(_,v)=>typeof v==='bigint'?String(v):v,2));
  })().catch(()=>{console.error('API3 USDG preflight failed. No transaction sent; provider details and credentials omitted.');process.exitCode=1;});
}
