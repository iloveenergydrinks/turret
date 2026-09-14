import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,http,parseAbi,keccak256} from './deps.mjs';
import {primaryAbi,stockAbi} from './abi.mjs';
import {requestSnapshots} from './alpaca.mjs';
import {evaluateMarket} from './policy.mjs';
import {sessionAt} from './calendar.mjs';
import {sessionConfig,feedForSession} from './session-config.mjs';
const config=JSON.parse(readFileSync(new URL('../../../contracts/utils/assets/dockyard-pilot-config.json',import.meta.url)));
const manifest=process.env.RISK_MANIFEST_JSON?JSON.parse(process.env.RISK_MANIFEST_JSON):config;
config.markets=manifest.markets;
const trading=sessionConfig(manifest,'observe',process.env.ALPACA_DATA_FEED??'iex');
const client=createPublicClient({transport:http(process.env.ALCHEMY_RPC_URL,{timeout:12000,retryCount:0})});
const vault='0x576c510e9A268B06448f67598B7BF1ed33388e20';
const abi=parseAbi(['function owner() view returns(address)','function totalDebt() view returns(uint256)','function paused() view returns(bool)','function balanceOf(address) view returns(uint256)']);
const output={checkedAt:new Date().toISOString(),chainId:await client.getChainId(),markets:[]};
if(output.chainId!==4663)throw new Error('Wrong chain');
const head=await client.getBlock();output.block=head.number;output.blockTimestamp=head.timestamp;
const session=sessionAt(Number(head.timestamp),trading.policy),sourceFeed=feedForSession(session,trading);
output.trading={policy:trading.policy,session:session.kind??'closed',sourceFeed};
output.gasPrice=await client.getGasPrice();
const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:head.number});
output.v1={address:vault,owner:await read(vault,abi,'owner'),totalDebt:await read(vault,abi,'totalDebt'),paused:await read(vault,abi,'paused'),usdg:await read(config.usdg,abi,'balanceOf',[vault]),codeHash:keccak256(await client.getCode({address:vault,blockNumber:head.number}))};
output.funding={ownerEth:await client.getBalance({address:config.owner,blockNumber:head.number}),keeperEth:await client.getBalance({address:config.keeper,blockNumber:head.number}),keeperUsdg:await read(config.usdg,abi,'balanceOf',[config.keeper])};
let snapshots={};
try{
 if(!session.open)throw Object.assign(new Error(),{name:session.reason});
 snapshots=await requestSnapshots({key:process.env.ALPACA_API_KEY,secret:process.env.ALPACA_API_SECRET,feed:sourceFeed},config.markets.map(m=>m.symbol));
 output.marketDataAccess=true;
}catch(e){output.marketDataAccess=false;output.marketDataError=e.name;}
for(const m of config.markets){
 try{
  const [round,decimals,multiplier,effectiveAt,tokenPaused]=await Promise.all([read(m.primaryOracle,primaryAbi,'latestRoundData'),read(m.primaryOracle,primaryAbi,'decimals'),read(m.collateral,stockAbi,'uiMultiplier'),read(m.collateral,stockAbi,'effectiveAt'),read(m.collateral,stockAbi,'oraclePaused')]);
  const maxPriceAgeSeconds=m.maxPriceAgeSeconds??300;
  const assessment=evaluateMarket({snapshot:snapshots[m.symbol],primary:[round[0],round[1]*10n**BigInt(18-decimals),...round.slice(2)],multiplier,effectiveAt,tokenPaused,maxPriceAgeSeconds,sessionPolicy:trading.policy,sourceFeed},Number(head.timestamp),Math.floor(Date.now()/1000));
  output.markets.push({symbol:m.symbol,round:round[0],updatedAt:round[3],ageSeconds:head.timestamp-round[3],maxPriceAgeSeconds,primaryFresh:round[3]>0n&&round[3]<=head.timestamp&&head.timestamp-round[3]<BigInt(maxPriceAgeSeconds),multiplier,effectiveAt,tokenPaused,assessment:{ok:assessment.ok,code:assessment.code}});
 }catch{output.markets.push({symbol:m.symbol,error:'ChainReadFailed'});}
}
const path=process.env.RISK_PREFLIGHT_OUTPUT;
output.liveComparisonsVerified=output.marketDataAccess&&output.markets.every(m=>m.assessment?.ok);
const json=JSON.stringify(output,(_,v)=>typeof v==='bigint'?v.toString():v,2);
if(path)writeFileSync(path,json+'\n');
console.log(json);
process.exitCode=output.liveComparisonsVerified?0:2;
