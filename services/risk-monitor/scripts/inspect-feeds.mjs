import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,http,parseAbi,keccak256} from '../src/deps.mjs';
import {errorCode} from '../../liquidator/src/chain.mjs';
const root=new URL('../../../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('contracts/utils/assets/test_output/dockyard-pilot-deployed.json',root)));
const catalogUrl='https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const response=await fetch(catalogUrl,{signal:AbortSignal.timeout(20000)});assert.ok(response.ok);
const catalog=await response.json();
const c=createPublicClient({transport:http(process.env.ALCHEMY_RPC_URL,{timeout:12000,retryCount:1}),cacheTime:0});
assert.equal(await c.getChainId(),4663);
const head=await c.getBlock();
const abi=parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)','function getRoundData(uint80) view returns(uint80,int256,uint256,uint256,uint80)','function decimals() view returns(uint8)','function description() view returns(string)','function aggregator() view returns(address)','function owner() view returns(address)','function paused() view returns(bool)','function totalDebt() view returns(uint256)','function availableLiquidity() view returns(uint256)','function balanceOf(address) view returns(uint256)']);
const read=(address,name,args=[])=>c.readContract({address,abi,functionName:name,args,blockNumber:head.number});
const report={checkedAt:new Date().toISOString(),chainId:4663,block:head.number,blockTimestamp:head.timestamp,catalogUrl,markets:[]};
for(const m of manifest.markets){
 const row=catalog.find(x=>x.proxyAddress?.toLowerCase()===m.primaryOracle.toLowerCase());assert.ok(row,`${m.symbol} absent from catalog`);
 const [latest,decimals,description,aggregator]=await Promise.all([read(m.primaryOracle,'latestRoundData'),read(m.primaryOracle,'decimals'),read(m.primaryOracle,'description'),read(m.primaryOracle,'aggregator')]);
 assert.equal(decimals,row.decimals);assert.equal(aggregator.toLowerCase(),row.contractAddress.toLowerCase());
 const history=[];
 for(let offset=0;offset<32;offset+=4){
  const results=await Promise.allSettled(Array.from({length:4},(_,i)=>read(m.primaryOracle,'getRoundData',[latest[0]-BigInt(offset+i)])));
  for(const r of results)if(r.status==='fulfilled'&&r.value[3]>0n)history.push({id:r.value[0],updatedAt:r.value[3]});
 }
 const gaps=history.slice(1).map((r,i)=>history[i].updatedAt-r.updatedAt).filter(g=>g>=0n);
 report.markets.push({symbol:m.symbol,primaryOracle:m.primaryOracle,aggregator,description,decimals,heartbeatSeconds:row.heartbeat,deviationPercent:row.threshold,marketHours:row.docs?.marketHours,latestRound:latest[0],updatedAt:latest[3],ageSeconds:head.timestamp-latest[3],currentGuardMaxAgeSeconds:300,currentGuardAcceptsAge:head.timestamp-latest[3]<300n,history,maxObservedGapSeconds:gaps.reduce((a,b)=>a>b?a:b,0n)});
}
report.vaults=[];
for(const address of ['0x576c510e9A268B06448f67598B7BF1ed33388e20',manifest.vault]){
 report.vaults.push({address,owner:await read(address,'owner'),paused:await read(address,'paused'),totalDebt:await read(address,'totalDebt'),availableLiquidity:await read(address,'availableLiquidity'),codeHash:keccak256(await c.getCode({address,blockNumber:head.number}))});
}
report.funding={};
for(const role of ['owner','keeper','guardian'])report.funding[role]={address:manifest[role],eth:await c.getBalance({address:manifest[role],blockNumber:head.number}),usdg:await read('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168','balanceOf',[manifest[role]])};
assert.equal((await c.getBlock({blockNumber:head.number})).hash,head.hash);
const output=process.env.RISK_INSPECTION_OUTPUT;assert.ok(output,'RISK_INSPECTION_OUTPUT required');
writeFileSync(output,JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
console.log(JSON.stringify({...report,markets:report.markets.map(({history,...m})=>({...m,historicalRounds:history.length}))},(_,v)=>typeof v==='bigint'?v.toString():v));
process.on('unhandledRejection',e=>{console.error(errorCode(e));process.exit(1);});
